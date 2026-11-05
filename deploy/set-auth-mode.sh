#!/usr/bin/env bash
# SUP-84 — flip GradeIQ staff sign-in between Keycloak and the legacy logins.
# No rebuild: it edits GIQ_AUTH_MODE in the VM's .env.local and restarts pm2.
#
#   bash deploy/set-auth-mode.sh oidc     # cut over to Keycloak
#   bash deploy/set-auth-mode.sh legacy   # roll back (re-opens the old passwords)
#
# oidc:   refuses unless the deployed build has the SUP-84 fixes AND the
#         preflight (scripts/keycloak-preflight.mjs, run on the VM) passes.
# legacy: no checks — a rollback must work when Keycloak is broken.
# Both:   keep a timestamped .env.local backup (mode 600), restart with a plain
#         `pm2 restart gradeiq` (NEVER --update-env: the shell's env would be
#         stamped onto the process and beat .env.local from then on), then ask
#         the running app where /superadmin sends a signed-out visitor, and
#         fail loudly if it is not the mode just set.
#
# Env: GIQ_VM, GIQ_SSH_KEY, GIQ_APP_DIR, GIQ_SSH, GIQ_PREFLIGHT_ARGS as in
#   set-keycloak-env.sh; GIQ_RESTART_CMD (pm2 restart gradeiq);
#   GIQ_APP_URL (http://127.0.0.1:3700) GIQ_BASE (/apps/gradeiq)
#   GIQ_PUBLIC_HOST (swapmore.com — sent as X-Forwarded-Host, as Caddy does)
set -euo pipefail

MODE=${1:-}
case "$MODE" in oidc|legacy) ;; *) echo "usage: bash deploy/set-auth-mode.sh oidc|legacy" >&2; exit 2;; esac
VM=${GIQ_VM:-ammar@104.197.168.25}
SSH_KEY=${GIQ_SSH_KEY:-$HOME/.ssh/denovo_gcp}
APP_DIR=${GIQ_APP_DIR:-gradeiq}
RESTART=${GIQ_RESTART_CMD:-pm2 restart gradeiq}
APP_URL=${GIQ_APP_URL:-http://127.0.0.1:3700}
BASE=${GIQ_BASE:-/apps/gradeiq}
PUBLIC_HOST=${GIQ_PUBLIC_HOST:-swapmore.com}
PREFLIGHT_ARGS=${GIQ_PREFLIGHT_ARGS:-}
HERE=$(cd "$(dirname "$0")/.." && pwd)
PREFLIGHT="$HERE/scripts/keycloak-preflight.mjs"
# shellcheck disable=SC2206
SSH=(${GIQ_SSH:-ssh -i "$SSH_KEY" -o ConnectTimeout=20})
die() { printf 'ABORT: %s\n' "$*" >&2; exit 1; }
[[ "$APP_DIR" =~ ^[A-Za-z0-9_./-]+$ ]] || die "GIQ_APP_DIR has unexpected characters"
for v in "$APP_URL" "$BASE" "$PUBLIC_HOST"; do [[ "$v" =~ ^[A-Za-z0-9:/._-]*$ ]] || die "unexpected characters in $v"; done
CD="case '$APP_DIR' in /*) cd '$APP_DIR' ;; *) cd \"\$HOME/$APP_DIR\" ;; esac"

if [ "$MODE" = oidc ]; then
  echo "[check] the deployed build has the SUP-84 sign-in fixes"
  "${SSH[@]}" "$VM" "$CD && grep -rqs sso_misconfigured .next/server/app/auth/login" \
    || die "the build on the VM predates SUP-84 (no SSO error handling in .next) — deploy the branch first; nothing changed"
  echo "[check] preflight on the VM"
  "${SSH[@]}" "$VM" "$CD && node --input-type=module - --dotenv .env.local $PREFLIGHT_ARGS" < "$PREFLIGHT" \
    || die "preflight failed (above) — staying on the current sign-in; nothing changed"
fi

echo "[set] GIQ_AUTH_MODE=$MODE"
# Same replace-one-key edit as set-keycloak-env.sh; the payload is just the flag.
printf 'GIQ_AUTH_MODE=%s\n' "$MODE" | "${SSH[@]}" "$VM" "$CD && set -eu && umask 077 && \
  [ -f .env.local ] || { echo 'ABORT: no .env.local'; exit 3; }; \
  ts=\$(date -u +%Y%m%dT%H%M%SZ); cp -p .env.local .env.local.bak-authmode-\$ts; chmod 600 .env.local.bak-authmode-\$ts; \
  awk 'FNR == NR { line = \$0; next } /^[ \t]*(export[ \t]+)?GIQ_AUTH_MODE[ \t]*=/ { next } { print } END { print line }' - .env.local > .env.local.new && \
  chmod 600 .env.local.new && mv .env.local.new .env.local && \
  echo \"  .env.local updated (previous kept as .env.local.bak-authmode-\$ts)\""

echo "[restart] $RESTART"
"${SSH[@]}" "$VM" "$CD && $RESTART >/dev/null"

echo "[verify] where does the running app send a signed-out visitor?"
WANT="$BASE/login"; [ "$MODE" = oidc ] && WANT="$BASE/auth/login"
got=""
for _ in $(seq 1 40); do
  got=$("${SSH[@]}" "$VM" "curl -s -o /dev/null --max-time 5 -w '%{http_code} %{redirect_url}' -H 'X-Forwarded-Proto: https' -H 'X-Forwarded-Host: $PUBLIC_HOST' '$APP_URL$BASE/superadmin'" 2>/dev/null || true)
  case "$got" in 307\ *|308\ *) break;; esac
  sleep 1
done
path=$(printf '%s' "${got#* }" | sed -E 's#^https?://[^/]+##; s#\?.*##')
echo "  /superadmin → ${got:-no answer}"
if [ "$path" = "$WANT" ]; then
  if [ "$MODE" = oidc ]; then
    echo "Done — staff now sign in with Keycloak. Roll back any time: bash deploy/set-auth-mode.sh legacy"
  else
    echo "Done — staff sign in with the legacy passwords again (built-in defaults included)."
  fi
  exit 0
fi
echo "PROBLEM: expected a redirect to $WANT. The flag is written, but the running app did not pick it up."
echo "  Check on the VM: pm2 logs gradeiq --lines 50 | grep '\[auth\]'   and   pm2 env <id> | grep -E 'GIQ_AUTH_MODE|KEYCLOAK'"
echo "  (a value carried by the pm2 process itself beats .env.local)."
exit 1
