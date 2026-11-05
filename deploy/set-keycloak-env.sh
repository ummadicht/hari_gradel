#!/usr/bin/env bash
# SUP-84 — put the managed Keycloak's settings into GradeIQ's env on the VM.
#
# RUN IT YOURSELF, in your own terminal on the Mac:
#
#   bash deploy/set-keycloak-env.sh
#
# It asks for the realm issuer URL and the two client secrets GradeIQ itself
# uses (typing is hidden for secrets), writes them into ~/gradeiq/.env.local on
# the VM over ssh, and then runs scripts/keycloak-preflight.mjs ON the VM so you
# see at once whether Keycloak answers the server correctly.
#
#   gradeiq      the staff-login client         → OIDC_CLIENT_SECRET
#   gradeiq-svc  GradeIQ → SuperIQ diagnostics  → SVC_CLIENT_SECRET
# The pandas-api and swapmore-svc secrets are NOT needed here: those clients
# call GradeIQ, and GradeIQ checks their tokens against Keycloak's public keys.
#
# What it does NOT do:
#   - change GIQ_AUTH_MODE (staff keep the sign-in they have now; flipping is
#     deploy/set-auth-mode.sh oidc, after the user import)
#   - restart the app (the new values load at the next restart — the flip)
#   - print, log or store a secret anywhere: values travel only over the ssh
#     connection's stdin (never on a command line, so never in `ps` or shell
#     history) and land only in the VM's .env.local (mode 600). A timestamped
#     backup of the previous file is kept next to it (also mode 600).
# Re-running it is safe: the same keys are replaced, nothing is duplicated.
#
# Env (defaults are the live GradeIQ VM):
#   GIQ_VM=ammar@104.197.168.25  GIQ_SSH_KEY=~/.ssh/denovo_gcp  GIQ_APP_DIR=gradeiq (under ~ on the VM)
#   GIQ_PUBLIC_URL=https://swapmore.com/apps/gradeiq   (the redirect URI is <this>/auth/callback)
#   GIQ_SSH="ssh …" overrides the whole ssh command (tests use a local stand-in)
#   GIQ_PREFLIGHT_ARGS  extra args for the preflight (tests: --app none --no-pm2)
set -euo pipefail

VM=${GIQ_VM:-ammar@104.197.168.25}
SSH_KEY=${GIQ_SSH_KEY:-$HOME/.ssh/denovo_gcp}
APP_DIR=${GIQ_APP_DIR:-gradeiq}
PUBLIC_URL=${GIQ_PUBLIC_URL:-https://swapmore.com/apps/gradeiq}
PREFLIGHT_ARGS=${GIQ_PREFLIGHT_ARGS:-}
HERE=$(cd "$(dirname "$0")/.." && pwd)
PREFLIGHT="$HERE/scripts/keycloak-preflight.mjs"
# shellcheck disable=SC2206
SSH=(${GIQ_SSH:-ssh -i "$SSH_KEY" -o ConnectTimeout=20})

die() { printf 'ABORT: %s\n' "$*" >&2; exit 1; }
[ -f "$PREFLIGHT" ] || die "missing $PREFLIGHT"
[[ "$APP_DIR" =~ ^[A-Za-z0-9_./-]+$ ]] || die "GIQ_APP_DIR has unexpected characters"
[[ "$PUBLIC_URL" =~ ^https?://[^/]+/[A-Za-z0-9/_-]*[^/]$ ]] || die "GIQ_PUBLIC_URL must look like https://swapmore.com/apps/gradeiq"
if [ ! -t 0 ] && [ "${GIQ_ALLOW_NONTTY:-}" != 1 ]; then
  die "run this in an interactive terminal — it asks for secrets"
fi

case "$APP_DIR" in /*) WHERE="$VM:$APP_DIR" ;; *) WHERE="$VM:~/$APP_DIR" ;; esac
echo "GradeIQ ⇄ Keycloak env for $WHERE (values you type are never shown or logged)"
echo

# ── ask ─────────────────────────────────────────────────────────────────────
# Secrets: Keycloak generates alphanumeric ones. Anything with $ ` " ' # \ or
# whitespace is refused rather than written — Next expands $VAR in .env files
# and treats # as a comment, so such a value would silently arrive changed.
SAFE='^[A-Za-z0-9._~+/=:@%^*!,-]{8,255}$'
read -r -p "Keycloak issuer URL (https://<host>/realms/novetta): " ISSUER
ISSUER=${ISSUER%/}
[[ "$ISSUER" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?/realms/[A-Za-z0-9._-]+$ || "$ISSUER" =~ ^http://(127\.0\.0\.1|localhost)(:[0-9]+)?/realms/[A-Za-z0-9._-]+$ ]] \
  || die "the issuer must look like https://<host>/realms/<realm> (https; no trailing path)"
read -r -s -p "gradeiq client secret (Clients → gradeiq → Credentials; hidden): " S_GRADEIQ; echo
[[ "$S_GRADEIQ" =~ $SAFE ]] || die "that gradeiq secret is empty, too short or has characters an .env file would mangle — nothing was written"
read -r -s -p "gradeiq-svc client secret (Clients → gradeiq-svc → Credentials; hidden): " S_SVC; echo
[[ "$S_SVC" =~ $SAFE ]] || die "that gradeiq-svc secret is empty, too short or has characters an .env file would mangle — nothing was written"
[ "$S_GRADEIQ" != "$S_SVC" ] || die "the two secrets are identical — each client has its own; nothing was written"
read -r -p "SuperIQ diagnostics ingest URL (Enter = leave it as it is on the VM): " SUPERIQ_URL
if [ -n "$SUPERIQ_URL" ]; then
  [[ "$SUPERIQ_URL" =~ ^https?://[^[:space:]\$\`\"\'#]+$ ]] || die "the SuperIQ URL must be an http(s) URL"
fi

# ── write ───────────────────────────────────────────────────────────────────
# The remote side reads KEY=VALUE lines from stdin and replaces exactly those
# keys in .env.local (everything else — GRADEIQ_SERVER_KEY, Gemini, Phonecheck,
# GIQ_AUTH_MODE — is left as it is). No secret is in this command string.
REMOTE_SET_ENV='set -eu
umask 077
case "$APP_DIR" in /*) cd "$APP_DIR" ;; *) cd "$HOME/$APP_DIR" ;; esac
grep -qs "\"name\": \"gradeiq\"" package.json || { echo "ABORT: $(pwd) is not the GradeIQ app directory"; exit 3; }
[ -f .env.local ] || { echo "ABORT: no .env.local in $(pwd) — refusing to create one"; exit 3; }
ts=$(date -u +%Y%m%dT%H%M%SZ)
cp -p .env.local ".env.local.bak-$TAG-$ts"; chmod 600 ".env.local.bak-$TAG-$ts"
awk '"'"'
  function key(l) { sub(/^[ \t]*(export[ \t]+)?/, "", l); sub(/[ \t]*=.*/, "", l); return l }
  FNR == NR { if ($0 ~ /^[A-Za-z_][A-Za-z0-9_]*=/) { k = key($0); val[k] = $0; ord[++n] = k }; next }
  $0 ~ /^[ \t]*(export[ \t]+)?[A-Za-z_][A-Za-z0-9_]*[ \t]*=/ && (key($0) in val) { next }
  { print }
  END { for (i = 1; i <= n; i++) print val[ord[i]] }
'"'"' - .env.local > .env.local.new
grep -q "^NEXT_PUBLIC_BASE_PATH=" .env.local.new || echo "NEXT_PUBLIC_BASE_PATH=/apps/gradeiq" >> .env.local.new
chmod 600 .env.local.new
mv .env.local.new .env.local
mode=$(grep -E "^[[:space:]]*(export[[:space:]]+)?GIQ_AUTH_MODE=" .env.local | tail -1 | sed "s/.*=//; s/[\"'"'"' ]//g")
echo "  wrote $(pwd)/.env.local (mode 600); previous file kept as .env.local.bak-$TAG-$ts"
echo "  GIQ_AUTH_MODE is ${mode:-unset} — unchanged"'

payload() {
  printf 'KEYCLOAK_ISSUER=%s\n' "$ISSUER"
  printf 'OIDC_CLIENT_ID=gradeiq\n'
  printf 'OIDC_CLIENT_SECRET=%s\n' "$S_GRADEIQ"
  printf 'OIDC_REDIRECT_URI=%s/auth/callback\n' "$PUBLIC_URL"
  printf 'SVC_CLIENT_ID=gradeiq-svc\n'
  printf 'SVC_CLIENT_SECRET=%s\n' "$S_SVC"
  [ -z "$SUPERIQ_URL" ] || printf 'SUPERIQ_DIAGNOSTICS_URL=%s\n' "$SUPERIQ_URL"
}

echo
echo "[1/2] writing KEYCLOAK_ISSUER OIDC_CLIENT_ID OIDC_CLIENT_SECRET OIDC_REDIRECT_URI SVC_CLIENT_ID SVC_CLIENT_SECRET${SUPERIQ_URL:+ SUPERIQ_DIAGNOSTICS_URL} (values not shown)"
payload | "${SSH[@]}" "$VM" "APP_DIR='$APP_DIR' TAG=keycloak; $REMOTE_SET_ENV"
unset S_GRADEIQ S_SVC

echo
echo "[2/2] preflight on the VM (talks to Keycloak from the server itself)"
set +e
"${SSH[@]}" "$VM" "case '$APP_DIR' in /*) cd '$APP_DIR' ;; *) cd \"\$HOME/$APP_DIR\" ;; esac && node --input-type=module - --dotenv .env.local $PREFLIGHT_ARGS" < "$PREFLIGHT"
rc=$?
set -e
echo
if [ $rc -eq 0 ]; then
  echo "Done. Keycloak is wired; staff still sign in the old way. Next: import the users, then"
  echo "  bash deploy/set-auth-mode.sh oidc"
else
  echo "The values are saved, but the preflight found problems (above). Fix them in the Keycloak console"
  echo "or re-run this script with the right values. Staff sign-in is unchanged meanwhile."
fi
exit $rc
