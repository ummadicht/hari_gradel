# Shared by deploy/release.sh and deploy/rollback.sh. Sourced, never run.
#
# Env (defaults are the live GradeIQ VM — see deploy/README.md):
#   GIQ_VM=ammar@104.197.168.25      GIQ_SSH_KEY=~/.ssh/denovo_gcp
#   GIQ_APP_DIR=gradeiq              app dir on the VM (under ~ unless absolute)
#   GIQ_RELEASES_DIR=gradeiq-releases  per-release manifests, source + DB backups
#   GIQ_PM2_NAME=gradeiq             GIQ_PUBLIC_URL=https://swapmore.com/apps/gradeiq
#   GIQ_HEALTH_TRIES=20 GIQ_HEALTH_WAIT=3   how long to wait for the app to answer
#   GIQ_LOG_SETTLE=10                seconds to let errors reach the log before scanning it
# Test hooks (scripts/release-test/run.sh uses them against a local stand-in VM):
#   GIQ_SSH="…"   replaces the whole ssh command (also used as rsync's -e)

DEFAULT_VM=ammar@104.197.168.25
VM=${GIQ_VM:-$DEFAULT_VM}
SSH_KEY=${GIQ_SSH_KEY:-$HOME/.ssh/denovo_gcp}
APP_DIR=${GIQ_APP_DIR:-gradeiq}
REL_DIR=${GIQ_RELEASES_DIR:-gradeiq-releases}
PM2_NAME=${GIQ_PM2_NAME:-gradeiq}
PUBLIC_URL=${GIQ_PUBLIC_URL:-https://swapmore.com/apps/gradeiq}
BASE_PATH=/apps/gradeiq   # compiled into the build; Caddy on swapmore.com routes it to :3700
HEALTH_TRIES=${GIQ_HEALTH_TRIES:-20}
HEALTH_WAIT=${GIQ_HEALTH_WAIT:-3}
LOG_SETTLE=${GIQ_LOG_SETTLE:-10}
RSH=${GIQ_SSH:-ssh -i $SSH_KEY -o ConnectTimeout=20 -o BatchMode=yes}
# shellcheck disable=SC2206
SSH=($RSH)
LIVE_FILE="$REPO/deploy/LIVE.json"
# What a healthy pm2 error log must not contain after a restart.
ERROR_PATTERN=${GIQ_ERROR_PATTERN:-'error|fatal|unhandled|uncaught|cannot find module|failed to load|sqlite_|eaddrinuse|out of memory'}

die() { printf '\nABORT: %s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }
step() { printf '\n[%s] %s\n' "$1" "$2"; }

[[ "$APP_DIR" =~ ^[A-Za-z0-9_./-]+$ ]] || die "GIQ_APP_DIR has unexpected characters"
[[ "$REL_DIR" =~ ^[A-Za-z0-9_./-]+$ ]] || die "GIQ_RELEASES_DIR has unexpected characters"
[[ "$PM2_NAME" =~ ^[A-Za-z0-9_.-]+$ ]] || die "GIQ_PM2_NAME has unexpected characters"
[[ "$PUBLIC_URL" =~ ^https?://[^/]+(/[A-Za-z0-9/_-]*[^/])?$ ]] || die "GIQ_PUBLIC_URL must look like https://swapmore.com/apps/gradeiq"

# Run a bash script (stdin) on the VM. Arguments are NAME=value pairs, defined
# (safely quoted) before the script, together with APP / REL (absolute paths)
# and a few helpers. Nothing secret is ever passed: no env file is read or sent.
remote() {
  {
    printf 'set -euo pipefail\n'
    printf 'APP_DIR=%q REL_DIR=%q PM2_NAME=%q\n' "$APP_DIR" "$REL_DIR" "$PM2_NAME"
    local kv
    for kv in "$@"; do printf '%s=%q\n' "${kv%%=*}" "${kv#*=}"; done
    cat <<'PRELUDE'
case "$APP_DIR" in /*) APP="$APP_DIR" ;; *) APP="$HOME/$APP_DIR" ;; esac
case "$REL_DIR" in /*) REL="$REL_DIR" ;; *) REL="$HOME/$REL_DIR" ;; esac
hash_of() { if [ -f "$1" ]; then { sha256sum "$1" 2>/dev/null || shasum -a 256 "$1"; } | cut -d' ' -f1; else echo absent; fi; }
# "status restarts errlog" of the pm2 app, or "missing 0 -".
pm2_state() {
  pm2 jlist 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      let list = []; try { list = JSON.parse(s.slice(s.indexOf("["))); } catch {}
      const p = list.find(x => x.name === process.argv[1]);
      if (!p) return console.log("missing 0 -");
      const e = p.pm2_env || {};
      console.log(e.status || "unknown", e.restart_time ?? 0, e.pm_err_log_path || "-");
    });' "$PM2_NAME"
}
size_of() { if [ -f "$1" ]; then wc -c < "$1" | tr -d ' '; else echo 0; fi; }
PRELUDE
    cat
  } | "${SSH[@]}" "$VM" "bash -s"
}

# The app dir as a word for a remote command line (APP_DIR is validated above).
app_word() { case "$APP_DIR" in /*) printf "'%s'" "$APP_DIR" ;; *) printf '"$HOME/%s"' "$APP_DIR" ;; esac; }

# sha256 (hex) of a file at a commit, or "absent".
git_hash() {
  if git -C "$REPO" cat-file -e "$1:$2" 2>/dev/null; then
    git -C "$REPO" show "$1:$2" | shasum -a 256 | cut -d' ' -f1
  else
    echo absent
  fi
}

live_get() {
  node -e 'const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
           const v = j[process.argv[2]]; process.stdout.write(v == null ? "" : String(v));' "$LIVE_FILE" "$1"
}

# live_write COMMIT BUILD RELEASE_STAMP — rewrite deploy/LIVE.json.
live_write() {
  node -e '
    const fs = require("fs"); const [file, commit, build, release, host, app] = process.argv.slice(1);
    const j = {
      commit, build_id: build, host, app_dir: app,
      released_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
      release: release || null,
      note: "Written by deploy/release.sh or deploy/rollback.sh: the commit and BUILD_ID the VM serves. release.sh refuses to run unless the VM still matches this.",
    };
    fs.writeFileSync(file, JSON.stringify(j, null, 2) + "\n");' "$LIVE_FILE" "$1" "$2" "$3" "$VM" "$APP_DIR"
}

# live_commit MESSAGE — commit deploy/LIVE.json (and nothing else).
live_commit() {
  if git -C "$REPO" diff --quiet HEAD -- deploy/LIVE.json; then
    say "    deploy/LIVE.json already says so — nothing to commit"
    return 0
  fi
  git -C "$REPO" add deploy/LIVE.json
  git -C "$REPO" commit -q -m "$1" -- deploy/LIVE.json
  say "    committed deploy/LIVE.json on $(git -C "$REPO" rev-parse --abbrev-ref HEAD) as $(git -C "$REPO" rev-parse --short HEAD) — push it: git push"
}

http_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$1" || true; }

# health EXPECTED_BUILD RESTARTS_BEFORE — 0 when the RUNNING app serves that
# build (every Next page carries its BUILD_ID, so this proves the restart took
# effect, not just that files moved), the API answers, the auth gate holds and
# pm2 is not crash-looping. Prints what it saw.
health() {
  local want=$1 before=$2 code="" i api imei served state status restarts page page_build=other
  page=$(mktemp "${TMPDIR:-/tmp}/gradeiq-health.XXXXXX")
  for ((i = 1; i <= HEALTH_TRIES; i++)); do
    code=$(curl -sL -o "$page" -w '%{http_code}' --max-time 10 "$PUBLIC_URL" || true)
    if [ "$code" = 200 ] && grep -q -- "$want" "$page"; then page_build=$want; break; fi
    sleep "$HEALTH_WAIT"
  done
  rm -f "$page"
  api=$(http_code "$PUBLIC_URL/api/sessions/does-not-exist")
  imei=$(http_code "$PUBLIC_URL/api/imei/352099001761481")
  served=$(remote <<'EOF'
cat "$APP/.next/BUILD_ID" 2>/dev/null || echo absent
EOF
)
  state=$(remote <<'EOF'
pm2_state
EOF
)
  read -r status restarts _ <<< "$state"
  say "    home page $code, served by build $page_build · unknown session $api (want 404) · anonymous IMEI lookup $imei (want 401)"
  say "    BUILD_ID on disk $served (want $want) · pm2 $status, restarts $before → $restarts"
  local bad=()
  [ "$code" = 200 ] || bad+=("home page answered $code")
  [ "$page_build" = "$want" ] || bad+=("the home page is not served by build $want — the restart did not take")
  [ "$api" = 404 ] || bad+=("API probe answered $api")
  [ "$imei" = 401 ] || bad+=("anonymous IMEI lookup answered $imei — the auth gate is not holding")
  [ "$served" = "$want" ] || bad+=("BUILD_ID on disk is $served")
  [ "$status" = online ] || bad+=("pm2 says $status")
  { [[ "$restarts" =~ ^[0-9]+$ ]] && [ "$restarts" -le $((before + 1)) ]; } || bad+=("pm2 restarted $restarts times (was $before) — crash loop?")
  if [ ${#bad[@]} -gt 0 ]; then
    say "    UNHEALTHY:"; printf '      - %s\n' "${bad[@]}"
    return 1
  fi
  say "    healthy"
}

# scan_log ERRLOG OFFSET — print error lines written to the pm2 error log after
# OFFSET bytes; 1 when there are any.
scan_log() {
  local found
  found=$(remote "ERRLOG=$1" "OFFSET=$2" "PATTERN=$ERROR_PATTERN" <<'EOF'
[ "$ERRLOG" != - ] && [ -f "$ERRLOG" ] || { echo "(no pm2 error log at $ERRLOG)" >&2; exit 0; }
size=$(size_of "$ERRLOG")
if [ "$size" -lt "$OFFSET" ]; then OFFSET=0; fi   # rotated since
tail -c "+$((OFFSET + 1))" "$ERRLOG" | grep -iE -- "$PATTERN" | tail -n 20 || true
EOF
)
  if [ -n "$found" ]; then
    say "    errors logged since the restart:"
    printf '%s\n' "$found" | sed 's/^/      | /'
    return 1
  fi
  say "    no errors logged since the restart"
}
