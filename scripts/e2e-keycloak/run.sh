#!/usr/bin/env bash
# SUP-84 — GradeIQ ⇄ Keycloak end-to-end test against a MOCK IdP. Local only.
#
# Builds GradeIQ exactly like prod (basePath /apps/gradeiq, webpack) in a
# throwaway git worktree, runs `next start` with ONLY .env.local for config (as
# pm2 does on the VM) on a fresh scratch DB, against mock-idp.mjs (a
# Keycloak-shaped OIDC provider fed by realm-fixture.json) and receiver.mjs (a
# stand-in for SuperIQ's diagnostics ingest). The owner's own scripts —
# deploy/set-keycloak-env.sh, deploy/set-auth-mode.sh and
# scripts/keycloak-preflight.mjs — are driven through a local stand-in for ssh
# whose "VM" is the worktree, so the env edits, the preflight and the
# flip/rollback are the real code paths.
#
#   S  before the cutover: legacy unchanged, SwapUp's server key, then
#      set-keycloak-env.sh (wrong secret refused by the preflight, then right)
#      and set-auth-mode.sh oidc (refused while the IdP is down, then done)
#   A  oidc: a) staff login · b) tenant scope · c) no-role refusal ·
#      d) logout · e) no password path · f) M2M (+ the server key)
#   B  rollback: set-auth-mode.sh legacy — same build, no rebuild
#   U  the flag LOST after the cutover: built-in defaults stay off
#   C  set-auth-mode.sh oidc again
#   D  Keycloak down (cold, hung, warm), misconfigured (no issuer, wrong
#      issuer string, wrong client secret) — and the preflight's own verdicts
#   I  scripts/import-users-to-keycloak.mjs against mock-kc-admin.mjs: dry run
#      is read-only, the realm's own `admin` is not clobbered, temporary
#      passwords land only in a mode-600 file, dropped giq_client is caught
#   N  SUP-86 trust on GET /api/sessions/{id}; SUP-72 paid IMEI lookups (the
#      receiver stands in for Phonecheck): per-IP daily cap, no channel, server
#      key, CounterIQ's retail key, session routes, journey start, the staff
#      count, the daily total for all anonymous callers; SUP-66 per-result
#      /functional writes and the seller's pick priced at the lowest grade;
#      SUP-77 M2M with no KEYCLOAK_ISSUER (x-sync-secret, SUPERIQ_TOKEN,
#      customers 503); SUP-88 the configurator behind the staff middleware
#      and its API; SUP-80 upload size caps (413) and the per-session limit
#      (429, nothing written, logged; the server key not limited); SUP-63 a
#      grade stuck on `refining` reads as unfinished (API, seller and staff
#      report) and reading it writes nothing
#
# Usage:  bash scripts/e2e-keycloak/run.sh
#   WT=<linked worktree>  test that checkout as it is (uncommitted changes
#                         included). Its data/ and .env.local are REPLACED, so
#                         it must be a throwaway worktree (see the guard below).
#                         Default: a detached worktree of REF under E2E_ROOT.
#   REF=HEAD  E2E_ROOT=${TMPDIR:-/tmp}/gradeiq-e2e-keycloak
#   REBUILD=1  force `next build` (else reused while the tree is unchanged)
#   STRICT=0   report [audit] rows as WARN instead of FAIL
#   KEEP=1     leave the servers running at the end
#   GIQ_PORT / IDP_PORT / RECV_PORT / KCA_PORT  (37811 / 37812 / 37813 / 37814)
# Exit status: number of FAILs (capped at 125); 0 = everything passed.
#
# Safety: never deploys, never touches a VM, never reads prod data. Client
# secrets are generated per run (openssl rand) and never printed; the run
# fails if any of them shows up in a script's output. The only passwords used
# are the PUBLIC built-in defaults (admin/admin, denovo/denovo) against this
# local throwaway build, plus a generated throwaway one for a seeded stored user.
set -o pipefail
[ -d "$HOME/.local/share/fnm/aliases/default/bin" ] && export PATH="$HOME/.local/share/fnm/aliases/default/bin:$PATH"

HERE=$(cd "$(dirname "$0")" && pwd)
SELF="$HERE/run.sh"
GIQ_PORT=${GIQ_PORT:-37811}
IDP_PORT=${IDP_PORT:-37812}
RECV_PORT=${RECV_PORT:-37813}
KCA_PORT=${KCA_PORT:-37814}
BASE=/apps/gradeiq
APP="http://127.0.0.1:$GIQ_PORT$BASE"
ISSUER="http://127.0.0.1:$IDP_PORT/realms/novetta"
REDIRECT="$APP/auth/callback"
export GIQ_PORT IDP_PORT RECV_PORT

say() { printf '%s\n' "$*" | tee -a "$OUT/e2e.log"; }
die() { say "ABORT: $*"; exit 126; }
section() { say ""; say "════ $* ════"; }

# ── processes ───────────────────────────────────────────────────────────────
port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
wait_http() { local n=0; until curl -s -o /dev/null --max-time 2 "$1"; do n=$((n+1)); [ $n -gt 160 ] && return 1; sleep 0.25; done; }
wait_listen() { local n=0; until port_busy "$1"; do n=$((n+1)); [ $n -gt 80 ] && return 1; sleep 0.25; done; }
wait_port_free() {
  local n=0
  while port_busy "$1"; do
    n=$((n+1))
    # Ports were verified free at the start, so anything still here is ours.
    [ $n -eq 40 ] && kill $(lsof -tnP -iTCP:"$1" -sTCP:LISTEN) 2>/dev/null
    [ $n -gt 80 ] && return 1
    sleep 0.25
  done
}
stop_pid() { local f="$OUT/$1.pid" pid; pid=$(cat "$f" 2>/dev/null) || return 0; [ -n "$pid" ] && { pkill -P "$pid" 2>/dev/null; kill "$pid" 2>/dev/null; }; rm -f "$f"; }
# The app gets NOTHING from this shell but PATH and HOME: every setting comes
# from $WT/.env.local, read by `next start` — exactly how pm2 runs it on the VM.
start_app() {
  (cd "$WT" && exec env -i PATH="$PATH" HOME="$HOME" node node_modules/next/dist/bin/next start -p "$GIQ_PORT" -H 127.0.0.1 >> "$OUT/app.log" 2>&1 < /dev/null) &
  echo $! > "$OUT/app.pid"; disown $! 2>/dev/null
  wait_http "$APP/login" || die "GradeIQ did not start (see $OUT/app.log)"
}
stop_app() { stop_pid app; wait_port_free "$GIQ_PORT" || die "app port $GIQ_PORT stuck"; }
restart_app() { stop_app; start_app; }

# `run.sh __restart` — the restart command deploy/set-auth-mode.sh runs on the
# stand-in VM (GIQ_RESTART_CMD), i.e. this harness's `pm2 restart gradeiq`.
if [ "${1:-}" = __restart ]; then
  WT=$E2E_WT OUT=$E2E_OUT
  restart_app
  exit 0
fi

# ── worktree ────────────────────────────────────────────────────────────────
REPO=$(git -C "$HERE" rev-parse --show-toplevel) || { echo "not in a git checkout"; exit 126; }
COMMON=$(cd "$REPO" && cd "$(git rev-parse --git-common-dir)" && pwd)
MAIN=$(dirname "$COMMON")
REF=${REF:-HEAD}
E2E_ROOT=${E2E_ROOT:-${TMPDIR:-/tmp}/gradeiq-e2e-keycloak}
E2E_ROOT=${E2E_ROOT%/}
RUN_ID=$(date +%Y%m%dT%H%M%S)
OUT=${OUT:-$E2E_ROOT/out/run-$RUN_ID}
mkdir -p "$OUT/http" || exit 126
: > "$OUT/results.tsv"
MARK="# e2e-keycloak scratch env — written by scripts/e2e-keycloak/run.sh"
if [ -n "${WT:-}" ]; then
  WT=$(cd "$WT" && pwd) || die "WT=$WT does not exist"
  [ -f "$WT/.git" ] || die "WT must be a LINKED git worktree (its data/ and .env.local are replaced) — not $WT"
  [ "$WT" != "$MAIN" ] || die "refusing to run in the main checkout"
  if [ -f "$WT/.env.local" ] && [ "$(head -1 "$WT/.env.local")" != "$MARK" ]; then die "$WT/.env.local is not an e2e scratch file — refusing to replace it"; fi
  if [ -d "$WT/data" ] && [ ! -f "$WT/data/.e2e-keycloak" ]; then die "$WT/data is not e2e scratch data — refusing to wipe it"; fi
else
  WT="$E2E_ROOT/wt"
  SHA=$(git -C "$REPO" rev-parse "$REF") || die "bad REF $REF"
  if [ ! -e "$WT/.git" ]; then
    mkdir -p "$E2E_ROOT"
    git -C "$REPO" worktree prune
    git -C "$REPO" worktree add --detach "$WT" "$SHA" >> "$OUT/e2e.log" 2>&1 || die "worktree add failed"
  else
    git -C "$WT" diff --quiet HEAD || die "$WT has local changes — refusing to move it to $REF"
    git -C "$WT" checkout -q --detach "$SHA" || die "checkout $REF in $WT failed"
  fi
fi
export E2E_WT="$WT" E2E_OUT="$OUT"
DB="$WT/data/gradeiq.db"
ENVF="$WT/.env.local"
FW_HDRS=(-H "Host: swapmore.com" -H "X-Forwarded-Host: swapmore.com" -H "X-Forwarded-Proto: https" -H "X-Forwarded-For: 203.0.113.9")
PUBLIC="https://swapmore.com$BASE"
HOSTRE='https?://[^/]+'

# ── results ─────────────────────────────────────────────────────────────────
PASSN=0; FAILN=0; WARNN=0; INFON=0
STRICT=${STRICT:-1}; KEEP=${KEEP:-0}; REBUILD=${REBUILD:-0}
result() { # status id category description evidence
  local st=$1 id=$2 cat=$3 desc=$4 ev=$5
  if [ "$st" = FAIL ] && [ "$STRICT" = 0 ] && [ "$cat" = audit ]; then st=WARN; fi
  case $st in PASS) PASSN=$((PASSN+1));; FAIL) FAILN=$((FAILN+1));; WARN) WARNN=$((WARNN+1));; *) INFON=$((INFON+1));; esac
  printf '%-4s %-5s [%s] %s\n       ↳ %s\n' "$st" "$id" "$cat" "$desc" "$ev" | tee -a "$OUT/e2e.log"
  printf '%s\t%s\t%s\t%s\t%s\n' "$st" "$id" "$cat" "$desc" "$ev" >> "$OUT/results.tsv"
}
# expect ID CATEGORY DESCRIPTION ACTUAL REGEX — PASS when ACTUAL matches REGEX (ERE)
expect() {
  if printf '%s' "$4" | grep -Eq -- "$5"; then result PASS "$1" "$2" "$3" "$4"
  else result FAIL "$1" "$2" "$3" "$4   ✗ wanted /$5/"; fi
}
info() { result INFO "$1" "${2:-doc}" "$3" "$4"; }

# ── http ────────────────────────────────────────────────────────────────────
N=0
redact() { sed -E 's/(Bearer )[A-Za-z0-9._-]+/\1<jwt>/g; s/(client_secret=)[^ &]+/\1<secret>/g; s/(gsid_)[A-Za-z0-9_-]+/\1…/g; s/("password":")[^"]*/\1…/g; s/(Cookie: [a-z_]+=)[^ ;]+/\1…/g; s/(id_token_hint=)[^&" ]+/\1<jwt>/g; s/(x-gradeiq-server-key: )[^ ]+/\1<key>/g; s/(x-gradeiq-retail-key: )[^ ]+/\1<key>/g'; }
# http JAR curl-args… → CODE, LOC (absolute), HDR, BODY, SECS.  JAR "-" = no cookie jar.
http() {
  local jar=$1; shift
  N=$((N+1)); HDR="$OUT/http/$N.hdr"; BODY="$OUT/http/$N.body"
  local w
  if [ "$jar" = - ]; then
    w=$(curl -s -o "$BODY" -D "$HDR" --max-time 30 -w '%{http_code} %{time_total} %{redirect_url}' "$@")
  else
    w=$(curl -s -o "$BODY" -D "$HDR" --max-time 30 -b "$OUT/$jar.jar" -c "$OUT/$jar.jar" -w '%{http_code} %{time_total} %{redirect_url}' "$@")
  fi
  CODE=${w%% *}; w=${w#* }; SECS=${w%% *}; LOC=${w#* }; [ "$LOC" = "$w" ] && LOC=""
  printf '%s\t%s\t%s\t%s\n' "$N" "$jar" "$CODE" "$(printf '%s ' "$@" | redact)" >> "$OUT/http/index.tsv"
}
hval() { grep -i "^$1:" "${2:-$HDR}" | head -1 | sed 's/^[^:]*: *//' | tr -d '\r'; }
setck() { grep -i "^set-cookie: $1=" "${2:-$HDR}" | head -1 | sed 's/^[^:]*: *//' | tr -d '\r'; }
ckval() { setck "$1" "${2:-$HDR}" | sed "s/^$1=\([^;]*\).*/\1/"; }
short() { printf '%s' "$1" | redact | cut -c1-"${2:-220}"; }
bodytxt() { sed 's/<!-- -->//g; s/&#x27;/'"'"'/g; s/&amp;/\&/g' "${1:-$BODY}"; }
jarck() { awk -v n="$2" '$6==n{print $7}' "$OUT/$1.jar" 2>/dev/null | tail -1; }
dbq() { sqlite3 -cmd ".timeout 3000" "$DB" "$1"; }
q() { python3 -c 'import sys,urllib.parse as u;print(dict(u.parse_qsl(u.urlsplit(sys.argv[1]).query)).get(sys.argv[2],""))' "$1" "$2"; }
jwtclaims() { python3 -c 'import sys,json,base64;p=sys.argv[1].split(".")[1];p+="="*(-len(p)%4);print(json.dumps(json.loads(base64.urlsafe_b64decode(p)),separators=(",",":")))' "$1" 2>/dev/null; }
lt() { python3 -c 'import sys;sys.exit(0 if float(sys.argv[1])<float(sys.argv[2]) else 1)' "$1" "$2"; }
loglines() { grep -c -F -- "$1" "$OUT/app.log" 2>/dev/null || true; }

# ── the "VM": .env.local + a stand-in for ssh ───────────────────────────────
env_set() { { grep -v "^$1=" "$ENVF" || true; printf '%s=%s\n' "$1" "$2"; } > "$ENVF.tmp"; mv "$ENVF.tmp" "$ENVF"; }
env_unset() { { grep -v "^$1=" "$ENVF" || true; } > "$ENVF.tmp"; mv "$ENVF.tmp" "$ENVF"; }
env_get() { grep "^$1=" "$ENVF" | tail -1 | cut -d= -f2-; }
env_count() { grep -c "^$1=" "$ENVF" || true; }
FAKE_SSH="$OUT/fake-ssh"
cat > "$FAKE_SSH" <<'SH'
#!/usr/bin/env bash
# Stand-in for ssh in the e2e test: drops ssh options, logs the host and the
# remote command (never stdin), and runs the command locally.
while [ $# -gt 0 ]; do case $1 in -i|-o|-p|-l|-F|-J) shift 2;; --) shift; break;; -*) shift;; *) break;; esac; done
host=$1; shift
printf '%s\t%s\n' "$host" "$*" >> "${FAKE_SSH_LOG:-/dev/null}"
exec bash -c "$*"
SH
chmod +x "$FAKE_SSH"
export FAKE_SSH_LOG="$OUT/fake-ssh.log"
OWNER_ENV=(GIQ_SSH="$FAKE_SSH" GIQ_VM=owner@stand-in-vm GIQ_APP_DIR="$WT" GIQ_PUBLIC_URL="$APP"
           GIQ_PREFLIGHT_ARGS="--app none --no-pm2" GIQ_RESTART_CMD="bash $SELF __restart"
           GIQ_APP_URL="http://127.0.0.1:$GIQ_PORT" GIQ_BASE="$BASE")
# set-keycloak-env.sh, answering its four questions on stdin.
set_keycloak_env() { # issuer gradeiq-secret svc-secret superiq-url → OUTFILE, RC
  OUTFILE="$OUT/set-keycloak-env-$((N+1)).out"; N=$((N+1))
  printf '%s\n%s\n%s\n%s\n' "$1" "$2" "$3" "$4" | env GIQ_ALLOW_NONTTY=1 "${OWNER_ENV[@]}" bash "$WT/deploy/set-keycloak-env.sh" > "$OUTFILE" 2>&1
  RC=$?
}
set_auth_mode() { OUTFILE="$OUT/set-auth-mode-$1-$((N+1)).out"; N=$((N+1)); env "${OWNER_ENV[@]}" bash "$WT/deploy/set-auth-mode.sh" "$1" > "$OUTFILE" 2>&1 < /dev/null; RC=$?; }
preflight() { OUTFILE="$OUT/preflight-$((N+1)).out"; N=$((N+1)); (cd "$WT" && env -i PATH="$PATH" HOME="$HOME" node scripts/keycloak-preflight.mjs --dotenv "${1:-.env.local}" --app none --no-pm2 > "$OUTFILE" 2>&1); RC=$?; }
# Did any throwaway secret leak into a file?
leaks() { local f n=0; for f in "$@"; do for s in "$S_GRADEIQ" "$S_GRADEIQ_SVC" "$S_PANDAS" "$S_SWAPMORE" "$S_SUPERIQ" "$SERVER_KEY" "$STORED_PW" "$S_SYNC" "$S_SUPERIQ_TOKEN" "$S_PC" "$S_RETAIL"; do [ -n "$s" ] && grep -qF -- "$s" "$f" 2>/dev/null && n=$((n+1)); done; done; echo "$n"; }

start_mock() { # [extra env…]
  env -i PATH="$PATH" HOME="$HOME" MOCK_PORT="$IDP_PORT" MOCK_CLIENT_SECRETS="$SECRETS_JSON" \
    MOCK_EXTRA_REDIRECTS="$REDIRECT" \
    MOCK_EXTRA_POST_LOGOUT="http://127.0.0.1:$GIQ_PORT$BASE/*,http://localhost:$GIQ_PORT$BASE/*" \
    MOCK_EVENTS_FILE="$OUT/idp-events.jsonl" "$@" \
    node "$WT/scripts/e2e-keycloak/mock-idp.mjs" >> "$OUT/mock.log" 2>&1 < /dev/null &
  echo $! > "$OUT/mock.pid"; disown $! 2>/dev/null
  if printf '%s ' "$@" | grep -q MOCK_HANG; then wait_listen "$IDP_PORT" || die "hung mock did not listen"
  else wait_http "http://127.0.0.1:$IDP_PORT/mock/health" || die "mock IdP did not start (see $OUT/mock.log)"; fi
}
stop_mock() { stop_pid mock; wait_port_free "$IDP_PORT" || die "mock port $IDP_PORT stuck"; }
start_recv() {
  env -i PATH="$PATH" HOME="$HOME" RECV_PORT="$RECV_PORT" RECV_ISSUER="$ISSUER" RECV_LOG="$OUT/receiver.jsonl" RECV_STATIC_TOKEN="$S_SUPERIQ_TOKEN" \
    node "$WT/scripts/e2e-keycloak/receiver.mjs" >> "$OUT/receiver.log" 2>&1 < /dev/null &
  echo $! > "$OUT/recv.pid"; disown $! 2>/dev/null
  wait_http "http://127.0.0.1:$RECV_PORT/last" || die "receiver did not start"
}
stop_recv() { stop_pid recv; wait_port_free "$RECV_PORT"; }
cleanup() { [ "$KEEP" = 1 ] && { say "KEEP=1 — servers left running (pids in $OUT/*.pid)"; return; }; stop_pid app; stop_pid mock; stop_pid recv; stop_pid kca; }

# ── tokens ──────────────────────────────────────────────────────────────────
cc_token() { curl -s --max-time 10 -d grant_type=client_credentials -d client_id="$1" --data-urlencode client_secret="$2" "$ISSUER/protocol/openid-connect/token" | jq -r '.access_token // empty'; }
forge() { curl -s --max-time 10 -X POST "http://127.0.0.1:$IDP_PORT/mock/forge" -H 'content-type: application/json' -d "$1" | jq -r '.token // empty'; }
legacy_pandas_token() { # the retired HMAC scheme, minted with its PUBLIC default key
  node -e 'const c=require("crypto");const p=`cli_live_gradeiq.${Math.floor(Date.now()/1000)+900}`;const s=c.createHmac("sha256","gradeiq-pandas-signing-key").update(p).digest("base64url");console.log(Buffer.from(p).toString("base64url")+"."+s)'
}
legacy_portal_cookie() { # portalAuth tokenFor(user, pw) — no server secret, so computable offline
  node -e 'const [u,p]=process.argv.slice(1);let h=0;const s=`${u}::${p}::gradeiq-portal-2026`;for(let i=0;i<s.length;i++)h=(h*31+s.charCodeAt(i))|0;console.log(`${u}.gqp_${(h>>>0).toString(36)}`)' "$1" "$2"
}
login_pw() { http "$1" -X POST -H 'content-type: application/json' -d "{\"username\":\"$2\",\"password\":\"$3\"}" "$APP/api/portal/login"; }

# ── the OIDC dance, following every redirect by hand ───────────────────────
# oidc_login JAR LOGIN_HINT → L_START L_AUTH L_CB (codes), CB_LOC, SESS_SET (Set-Cookie line), SID
oidc_login() {
  local jar=$1 hint=$2
  rm -f "$OUT/$jar.jar"
  http "$jar" "$APP/auth/login?returnTo=%2Fsuperadmin"; L_START=$CODE; AUTH_URL=$LOC
  http "$jar" "$AUTH_URL&login_hint=$hint"; L_AUTH=$CODE; CB_URL=$LOC
  http "$jar" "$CB_URL"; L_CB=$CODE; CB_LOC=$LOC; SESS_SET=$(setck giq_session); SID=$(ckval giq_session)
}

# ═════════════════════════════════════════════════════════════════════════════
section "0 · preflight + build"
for p in "$GIQ_PORT" "$IDP_PORT" "$RECV_PORT" "$KCA_PORT"; do port_busy "$p" && die "port $p is already in use — refusing to touch someone else's process"; done
for t in node curl jq sqlite3 python3 openssl git lsof bc; do command -v "$t" >/dev/null || die "missing $t"; done
trap cleanup EXIT

# A copy interrupted part-way leaves node_modules without next — check the binary, not the folder.
if [ ! -f "$WT/node_modules/next/dist/bin/next" ]; then
  rm -rf "$WT/node_modules"
  src="$REPO/node_modules"; [ -d "$src" ] || src="$MAIN/node_modules"
  [ -d "$src" ] || die "no node_modules to copy (npm ci in $MAIN first)"
  # -H: when node_modules is itself a symlink (gradeiq-live's is), copy what it points at
  cp -cRH "$src" "$WT/node_modules" 2>/dev/null || cp -RH "$src" "$WT/node_modules"
fi
rm -f "$ENVF" # the build must not see a previous run's env
# What the Next build depends on: the tree minus scripts/, deploy/, docs/ and
# markdown (editing the test or the owner's scripts must not force a rebuild).
NOBUILD=(':(exclude)scripts' ':(exclude)deploy' ':(exclude)docs' ':(exclude)*.md')
tree_stamp() { { git -C "$WT" ls-files -s -- . "${NOBUILD[@]}"; git -C "$WT" diff HEAD -- . "${NOBUILD[@]}"; git -C "$WT" ls-files -o --exclude-standard -- . "${NOBUILD[@]}" | grep -v '^data/' | sort | while read -r f; do printf '%s\n' "$f"; cat "$WT/$f"; done; } 2>/dev/null | shasum | cut -c1-16; }
STAMP=$(tree_stamp)
if [ "$REBUILD" = 1 ] || [ ! -f "$WT/.next/BUILD_ID" ] || [ "$(cat "$WT/.next/E2E_STAMP" 2>/dev/null)" != "$STAMP" ]; then
  ok=0
  # Create the DB (and switch it to WAL) in ONE process first: page-data
  # collection opens data/gradeiq.db from 5 workers at once, and on a fresh file
  # they race to SQLITE_BUSY. Whatever is left is retried.
  mkdir -p "$WT/data/uploads"; touch "$WT/data/.e2e-keycloak"
  (cd "$WT" && env -i PATH="$PATH" HOME="$HOME" node --experimental-strip-types --no-warnings \
    -e 'import("./lib/db.ts").catch((e) => { console.error(e); process.exit(1); })') >> "$OUT/e2e.log" 2>&1 \
    || say "  · (schema pre-init failed — the build will create it)"
  for attempt in 1 2 3 4 5; do
    say "  · next build --webpack (basePath $BASE) attempt $attempt"
    # Collecting page data opens data/gradeiq.db from several workers at once; on
    # an empty data dir that races to SQLITE_BUSY, so a failed attempt is retried.
    (cd "$WT" && rm -rf .next && env -i PATH="$PATH" HOME="$HOME" NEXT_PUBLIC_BASE_PATH="$BASE" NODE_OPTIONS=--max-old-space-size=1536 \
      node node_modules/next/dist/bin/next build --webpack > "$OUT/build-$attempt.log" 2>&1) && { ok=1; break; }
    grep -m1 -E "Error|error" "$OUT/build-$attempt.log" | tee -a "$OUT/e2e.log"
  done
  [ $ok = 1 ] || die "build failed 5× (see $OUT/build-*.log)"
  ls "$WT/.next/server/chunks" | grep -q turbopack && die "turbopack chunks in a --webpack build"
  echo "$STAMP" > "$WT/.next/E2E_STAMP"
else
  say "  · reusing build $(cat "$WT/.next/BUILD_ID") (tree unchanged, stamp $STAMP)"
fi
BUILD_ID=$(cat "$WT/.next/BUILD_ID")
BUILD_MTIME=$(stat -f %m "$WT/.next/BUILD_ID" 2>/dev/null || stat -c %Y "$WT/.next/BUILD_ID")
say "  · worktree $WT @ $(git -C "$WT" rev-parse --short HEAD)$(git -C "$WT" diff --quiet HEAD || echo ' (+local changes)')  BUILD_ID $BUILD_ID"

# Realm drift: the fixture is a secret-free projection of the real realm file.
REAL_REALM=${REAL_REALM:-$HOME/projects/keycloak-novetta/realm-novetta.json}
realm_projection() { jq -S '{realm, accessTokenLifespan, ssoSessionIdleTimeout, revokeRefreshToken, clients: [.clients[] | {clientId, publicClient, bearerOnly, standardFlowEnabled, serviceAccountsEnabled, fullScopeAllowed, redirectUris, attributes: ((.attributes // {}) | with_entries(select(.key == "post.logout.redirect.uris" or .key == "pkce.code.challenge.method"))), protocolMappers: [(.protocolMappers // [])[] | {name, protocol, protocolMapper, config}]}]}' "$1"; }
if [ -f "$REAL_REALM" ]; then
  if [ "$(realm_projection "$REAL_REALM")" = "$(realm_projection "$WT/scripts/e2e-keycloak/realm-fixture.json")" ]; then
    info R0 mock "realm-fixture.json matches the clients in $REAL_REALM" "no drift"
  else
    result WARN R0 mock "realm-fixture.json has DRIFTED from $REAL_REALM — regenerate it (see realm_projection in run.sh)" "drift"
  fi
fi

# Throwaway secrets for this run only. Never printed.
umask 077
S_GRADEIQ=$(openssl rand -hex 24); S_GRADEIQ_SVC=$(openssl rand -hex 24); S_PANDAS=$(openssl rand -hex 24)
S_SWAPMORE=$(openssl rand -hex 24); S_SUPERIQ=$(openssl rand -hex 24); SERVER_KEY=$(openssl rand -hex 24)
SECRETS_JSON=$(jq -nc --arg a "$S_GRADEIQ" --arg b "$S_GRADEIQ_SVC" --arg c "$S_PANDAS" --arg d "$S_SWAPMORE" --arg e "$S_SUPERIQ" \
  '{"gradeiq":$a,"gradeiq-svc":$b,"pandas-api":$c,"swapmore-svc":$d,"superiq-erp":$e}')
STORED_PW=$(openssl rand -hex 12)
# SUP-77's pre-Keycloak shared secrets (SwapMore's x-sync-secret, SuperIQ's static
# Bearer) and a stand-in Phonecheck key for SUP-72.
S_SYNC=$(openssl rand -hex 24); S_SUPERIQ_TOKEN=$(openssl rand -hex 24); S_PC=$(openssl rand -hex 12)
# CounterIQ's retail key (SUP-72 review).
S_RETAIL=$(openssl rand -hex 24)
umask 022

# Fresh scratch DB — never prod data — and the VM's env as it is today: no
# Keycloak, GIQ_AUTH_MODE unset, SwapUp's server key, the base path.
rm -rf "$WT/data"; mkdir -p "$WT/data/uploads"; touch "$WT/data/.e2e-keycloak"
{ echo "$MARK"
  echo "NEXT_PUBLIC_BASE_PATH=$BASE"
  echo "GRADEIQ_SERVER_KEY=$SERVER_KEY"
  echo "SUPERIQ_DIAGNOSTICS_URL=http://127.0.0.1:$RECV_PORT/api/diagnostics/ingest"
  echo "E2E_UNRELATED=keep-me"; } > "$ENVF"
chmod 644 "$ENVF"

start_mock; start_recv; start_app
http - "$APP/api/portal/me" # first DB-touching request creates the schema
dbq "INSERT INTO sessions (id, imei, model, status, functional_grade, cosmetic_grade, overall_grade, client_id)
     VALUES ('e2eden1','356938035643809','iPhone 13','graded','Working','B','B','denovo'),
            ('e2eswp1','490154203237518','Galaxy S21','graded','Working','A','A','swapmore');
     INSERT INTO portal_users (username, role, client_id, pw_sha256, created_by)
     VALUES ('e2estored','client','denovo','$(printf '%s' "$STORED_PW" | shasum -a 256 | cut -d' ' -f1)','e2e');" || die "seed failed"
say "  · seeded scratch DB: $(dbq "SELECT group_concat(id||'→'||client_id, ', ') FROM sessions") + stored user e2estored (throwaway pw)"

# ═════════════════════════════════════════════════════════════════════════════
section "S · before the cutover, then the owner's scripts"
http - "$APP/superadmin"
[ "$CODE" = "000" ] && { sleep 2; http - "$APP/superadmin"; }  # one retry: a loaded machine can drop the very first request
expect S1 core "today's prod (GIQ_AUTH_MODE unset, no Keycloak env): /superadmin → legacy /login" "HTTP $CODE → $LOC" "^HTTP 307 → $HOSTRE$BASE/login\?returnTo=%2Fsuperadmin$"
login_pw legS admin admin
expect S2 core "legacy is unchanged before the cutover: admin/admin still signs in (owner: no interim password change)" "HTTP $CODE" '^HTTP 200$'
http - -H "x-gradeiq-server-key: $SERVER_KEY" "$APP/api/imei/35693803"; S3A=$CODE
http - "$APP/api/imei/35693803"; S3B=$CODE
http - -H "x-gradeiq-server-key: not-the-key" "$APP/api/imei/35693803"
expect S3 core "SwapUp's x-gradeiq-server-key works in legacy (right key 200, none 401, wrong 401)" "key $S3A; none $S3B; wrong $CODE" '^key 200; none 401; wrong 401$'
http - -H "Authorization: Bearer x.y.z" "$APP/api/customers/sessions/e2eden1"
expect S4 core "a bearer call with no KEYCLOAK_ISSUER answers a clean 503 (was an uncaught 500)" "HTTP $CODE $(short "$(cat "$BODY")" 90)" '^HTTP 503'

say "── set-keycloak-env.sh with a WRONG gradeiq secret"
set_keycloak_env "$ISSUER" "wrong$(openssl rand -hex 8)" "$S_GRADEIQ_SVC" "http://127.0.0.1:$RECV_PORT/api/diagnostics/ingest"
expect S5 core "the preflight it runs on the VM catches the wrong secret, and the script exits non-zero" "exit $RC; $(grep -E '^FAIL' "$OUTFILE" | head -2 | tr '\n' ' ')" '^exit 1; FAIL +Keycloak REJECTS OIDC_CLIENT_SECRET'
say "── set-keycloak-env.sh with the right secrets"
set_keycloak_env "$ISSUER" "$S_GRADEIQ" "$S_GRADEIQ_SVC" "http://127.0.0.1:$RECV_PORT/api/diagnostics/ingest"
expect S6 core "set-keycloak-env.sh: values written, preflight READY on the VM" "exit $RC; $(grep -E '^(READY|NOT READY)' "$OUTFILE")" '^exit 0; READY'
expect S7 core "…each key once, GIQ_AUTH_MODE untouched, other VM keys kept, file mode 600" \
  "$(for k in KEYCLOAK_ISSUER OIDC_CLIENT_ID OIDC_CLIENT_SECRET OIDC_REDIRECT_URI SVC_CLIENT_ID SVC_CLIENT_SECRET SUPERIQ_DIAGNOSTICS_URL NEXT_PUBLIC_BASE_PATH GRADEIQ_SERVER_KEY E2E_UNRELATED; do printf '%s=%s ' "$k" "$(env_count "$k")"; done)GIQ_AUTH_MODE=$(env_count GIQ_AUTH_MODE) server_key_kept=$([ "$(env_get GRADEIQ_SERVER_KEY)" = "$SERVER_KEY" ] && echo yes || echo no) secret_right=$([ "$(env_get OIDC_CLIENT_SECRET)" = "$S_GRADEIQ" ] && echo yes || echo no) mode=$(stat -f %Lp "$ENVF" 2>/dev/null || stat -c %a "$ENVF")" \
  '^KEYCLOAK_ISSUER=1 OIDC_CLIENT_ID=1 OIDC_CLIENT_SECRET=1 OIDC_REDIRECT_URI=1 SVC_CLIENT_ID=1 SVC_CLIENT_SECRET=1 SUPERIQ_DIAGNOSTICS_URL=1 NEXT_PUBLIC_BASE_PATH=1 GRADEIQ_SERVER_KEY=1 E2E_UNRELATED=1 GIQ_AUTH_MODE=0 server_key_kept=yes secret_right=yes mode=600$'
BAKS=$(ls "$WT"/.env.local.bak-keycloak-* 2>/dev/null | wc -l | tr -d ' ')
expect S8 core "…a backup of the previous file is kept, mode 600" "backups=$BAKS mode=$(stat -f %Lp "$(ls "$WT"/.env.local.bak-keycloak-* | tail -1)" 2>/dev/null)" '^backups=[1-9][0-9]* mode=600$'
expect S9 core "no secret appears in the scripts' output or on any ssh command line" "leaks=$(leaks "$OUT"/set-keycloak-env-*.out "$FAKE_SSH_LOG" "$OUT/e2e.log")" '^leaks=0$'

say "── set-auth-mode.sh oidc while Keycloak is DOWN (must refuse)"
stop_mock
set_auth_mode oidc
expect S10 core "set-auth-mode.sh oidc refuses when the preflight fails, flag unchanged" "exit $RC; GIQ_AUTH_MODE count=$(env_count GIQ_AUTH_MODE); $(grep -m1 -E '^ABORT' "$OUTFILE")" '^exit 1; GIQ_AUTH_MODE count=0; ABORT: preflight failed'
start_mock
restart_app # what the next routine restart does: Keycloak env loaded, sign-in still legacy
http - "$APP/superadmin"; S11A="$CODE → $LOC"
T_PANDAS=$(cc_token pandas-api "$S_PANDAS")
http - -H "Authorization: Bearer $T_PANDAS" "$APP/api/customers/sessions/e2eden1"
expect S11 core "Keycloak env loaded but flag unset: staff sign-in still legacy, M2M already live" "/superadmin $S11A; pandas-api token → HTTP $CODE" "^/superadmin 307 → $HOSTRE$BASE/login\?returnTo=%2Fsuperadmin; pandas-api token → HTTP 200$"
say "── set-auth-mode.sh oidc (the cutover)"
set_auth_mode oidc
expect S12 core "set-auth-mode.sh oidc: build check + preflight pass, flag set once, restarted, /superadmin → /auth/login" "exit $RC; GIQ_AUTH_MODE=$(env_get GIQ_AUTH_MODE) ×$(env_count GIQ_AUTH_MODE); $(grep -m1 '/superadmin →' "$OUTFILE" | sed 's/^ *//')" "^exit 0; GIQ_AUTH_MODE=oidc ×1; /superadmin → 307 https://swapmore.com$BASE/auth/login"
expect S13 core "no rebuild for the flip: same BUILD_ID, untouched .next" "BUILD_ID $(cat "$WT/.next/BUILD_ID") mtime $(stat -f %m "$WT/.next/BUILD_ID" 2>/dev/null || stat -c %Y "$WT/.next/BUILD_ID")" "^BUILD_ID $BUILD_ID mtime $BUILD_MTIME$"

# ═════════════════════════════════════════════════════════════════════════════
section "A · GIQ_AUTH_MODE=oidc"

say "── (a) staff login: super"
rm -f "$OUT/super1.jar"
http super1 "$APP/superadmin"
expect a1 core "unauthenticated /superadmin → middleware sends to the OIDC start" "HTTP $CODE → $LOC" "^HTTP 307 → $HOSTRE$BASE/auth/login\?returnTo=%2Fsuperadmin$"
http super1 "$LOC"; AUTH_URL=$LOC; TX_SET=$(setck giq_oidc_tx)
expect a2 core "/auth/login → IdP authorize (code + PKCE S256, client gradeiq, exact redirect_uri)" \
  "HTTP $CODE → $(short "$AUTH_URL" 400)" \
  "^HTTP 307 → $ISSUER/protocol/openid-connect/auth\?response_type=code&client_id=gradeiq&redirect_uri=http%3A%2F%2F127.0.0.1%3A$GIQ_PORT%2Fapps%2Fgradeiq%2Fauth%2Fcallback&scope=openid\+email\+profile&state=[^&]+&nonce=[^&]+&code_challenge=[A-Za-z0-9_-]{43}&code_challenge_method=S256$"
expect a2b core "PKCE/state cookie giq_oidc_tx is HttpOnly+Secure+SameSite=lax, 10 min" "$(short "$TX_SET" 60)…$(printf '%s' "$TX_SET" | sed 's/^[^;]*//')" "Max-Age=600; Secure; HttpOnly; SameSite=lax"
STATE=$(q "$AUTH_URL" state)
http super1 "$AUTH_URL&login_hint=super"; CB_URL=$LOC
expect a3 core "IdP authenticates (login_hint=super) → callback with code + the same state" "HTTP $CODE → $(printf '%s' "$CB_URL" | sed -E 's/code=[^&]+/code=…/')" "^HTTP 302 → $REDIRECT\?state=$STATE&session_state=[^&]+&code=…&iss="
http super1 "$CB_URL"; SESS_SET=$(setck giq_session); SID1=$(ckval giq_session); CB_LOC=$LOC
expect a4 core "callback → redirect to /superadmin on the origin the browser used" "HTTP $CODE → $CB_LOC" "^HTTP 307 → http://127\.0\.0\.1:$GIQ_PORT$BASE/superadmin$"
expect a4b core "session cookie giq_session: opaque sid, HttpOnly, Secure, SameSite=lax, Path=/, 14 d" "$(printf '%s' "$SESS_SET" | redact)" "^giq_session=gsid_…; Path=/; Expires=[^;]+; Max-Age=1209600; Secure; HttpOnly; SameSite=lax$"
expect a4c core "the PKCE/state cookie is consumed on callback" "$(setck giq_oidc_tx | redact)" "^giq_oidc_tx=; Path=/; Expires=Thu, 01 Jan 1970"
http super1 "$APP/superadmin"
expect a5 core "/superadmin with the session → 200" "HTTP $CODE" "^HTTP 200$"
http super1 "$APP/api/portal/me"
expect a6 core "/api/portal/me → super, all clients" "HTTP $CODE $(jq -c '{u:.user,n:(.clients|length)}' "$BODY" 2>/dev/null)" '^HTTP 200 \{"u":\{"username":"admin@gradeiq.local","role":"super","clientId":null\},"n":[4-9]'
expect a7 core "server-side session row (oidc_sessions) holds role + scope" "$(dbq "SELECT 'role='||role||' client_id='||ifnull(client_id,'NULL')||' sub_set='||(length(sub)>0)||' id_token_set='||(length(id_token)>0) FROM oidc_sessions WHERE sid='$SID1'")" "^role=super client_id=NULL sub_set=1 id_token_set=1$"
EV=$(grep '"type":"auth_ok"' "$OUT/idp-events.jsonl" | tail -1 | jq -r '"pkce="+.pkce')
EV2=$(grep '"grant":"authorization_code"' "$OUT/idp-events.jsonl" | tail -1 | jq -r '.type')
expect a8 core "IdP saw S256 PKCE and accepted GradeIQ's code_verifier + client secret at /token" "$EV token=$EV2" "^pkce=S256 token=token_ok$"
expect a8b core "the first Keycloak sign-in is recorded in the DB (keeps defaults off if the flag is ever lost)" "auth_state rows: $(dbq "SELECT count(*) FROM auth_state WHERE key='oidc_cutover'")" '^auth_state rows: 1$'

rm -f "$OUT/tamper.jar"
http tamper "$APP/auth/login?returnTo=%2Fsuperadmin"; A_URL=$LOC
http tamper "$A_URL&login_hint=super"; T_CB=$(printf '%s' "$LOC" | sed -E 's/state=[^&]+/state=tampered/')
http tamper "$T_CB"
expect a9 core "callback with a tampered state is refused, no session issued" "HTTP $CODE → $LOC; giq_session set: $( [ -n "$(setck giq_session)" ] && echo yes || echo no)" "^HTTP 307 → .*/login\?error=state_mismatch; giq_session set: no$"
rm -f "$OUT/redir.jar"
http redir "$APP/auth/login?returnTo=%2F%2Fevil.example%2Fx"; A_URL=$LOC
http redir "$A_URL&login_hint=super"; http redir "$LOC"
expect a10 core "returnTo=//evil.example is replaced by /superadmin (never protocol-relative)" "HTTP $CODE → $LOC" "^HTTP 307 → http://127\.0\.0\.1:$GIQ_PORT$BASE/superadmin$"
http - "${FW_HDRS[@]}" "$APP/superadmin"
expect a11 prod-proxy "behind Caddy, middleware redirect uses the public origin" "HTTP $CODE → $LOC" "^HTTP 307 → $PUBLIC/auth/login\?returnTo=%2Fsuperadmin$"
http - "${FW_HDRS[@]}" "$APP/auth/login?returnTo=%2Fsuperadmin"; A_URL=$LOC; TXC=$(ckval giq_oidc_tx)
http - "$A_URL&login_hint=super"; C_URL=$LOC
http - "${FW_HDRS[@]}" -H "Cookie: giq_oidc_tx=$TXC" "$C_URL"; CADDY_SID=$(ckval giq_session)
expect a12 prod-proxy "behind Caddy, the post-login redirect goes to https://swapmore.com$BASE/superadmin (not the internal origin)" "HTTP $CODE → $LOC  (session issued: $( [ -n "$CADDY_SID" ] && echo yes || echo no))" "^HTTP 307 → $PUBLIC/superadmin  \(session issued: yes\)$"

say "── (b) tenant scope: client:denovo"
oidc_login den "client:denovo"
http den "$APP/api/portal/me"
expect b1 core "client user → role client scoped to denovo, sees only denovo" "HTTP $CODE $(jq -c '{u:.user,c:[.clients[].id]}' "$BODY" 2>/dev/null)" '^HTTP 200 \{"u":\{"username":"denovo-admin@gradeiq.local","role":"client","clientId":"denovo"\},"c":\["denovo"\]\}$'
http den "$APP/api/portal/sessions?client=denovo"
expect b2 core "GET /api/portal/sessions?client=denovo → own rows only" "HTTP $CODE ids=$(jq -c '[.sessions[].id]' "$BODY" 2>/dev/null)" '^HTTP 200 ids=\["e2eden1"\]$'
http den "$APP/api/portal/sessions?client=swapmore"
expect b3 core "…?client=swapmore → 403" "HTTP $CODE $(cat "$BODY")" '^HTTP 403 .*not your client'
http den "$APP/api/portal/sessions?client=all"
expect b4 core "…?client=all (super-only cross-tenant) → refused" "HTTP $CODE $(cat "$BODY")" '^HTTP 403'
http den "$APP/api/portal/sessions/e2eswp1"
expect b5 core "GET /api/portal/sessions/<swapmore session> → 403" "HTTP $CODE $(cat "$BODY")" '^HTTP 403'
http den -X POST -H 'content-type: application/json' -d '{"vision_provider":"kimi"}' "$APP/api/settings"
expect b6 core "POST /api/settings (platform, super-only) → 403" "HTTP $CODE $(cat "$BODY")" '^HTTP 403'
http den "$APP/api/sessions"
expect b7 scope "GET /api/sessions (staff dashboard) → only denovo rows" "HTTP $CODE client_ids=$(jq -c '[.[].client_id]|unique' "$BODY" 2>/dev/null)" '^HTTP 200 client_ids=\["denovo"\]$'
http den "$APP/console/swapmore"; B8A=$CODE
http den "$APP/console/denovo"
expect b8 scope "/console/swapmore as a denovo user → refused; /console/denovo → 200" "swapmore HTTP $B8A; denovo HTTP $CODE" '^swapmore HTTP 404; denovo HTTP 200$'
oidc_login swp "client:swapmore"
http swp -X POST "$APP/api/report/e2eden1/push-superiq"
expect b9 scope "a swapmore client user cannot push a DENOVO session to SuperIQ" "HTTP $CODE $(short "$(cat "$BODY")" 120)" '^HTTP 403'

say "── (c) no gradeiq role"
oidc_login norole "norole"
NR_ROWS=$(dbq "SELECT count(*)||' row(s)' FROM oidc_sessions WHERE email='erp-operator@gradeiq.local'")
expect c1 core "user with NO gradeiq role is refused at the callback → /login?error=no_access, no session" "callback HTTP $L_CB → $CB_LOC; giq_session set: $( [ -n "$SESS_SET" ] && echo yes || echo no); oidc_sessions: $NR_ROWS" "^callback HTTP 307 → $HOSTRE$BASE/login\?error=no_access; giq_session set: no; oidc_sessions: 0 row"
http norole "$APP/api/portal/me"
expect c2 core "no-role user: /api/portal/me → 401" "HTTP $CODE $(short "$(cat "$BODY")" 100)" '^HTTP 401'
http norole "$APP/api/sessions"
expect c3 core "no-role user: /api/sessions (all tenants' IMEIs) → 401" "HTTP $CODE" '^HTTP 401'
http norole "$APP/api/settings"
expect c4 core "no-role user: GET /api/settings (integration config) → 401" "HTTP $CODE" '^HTTP 401'
http norole "$APP/console/denovo"
expect c5 core "no-role user: /console/denovo → sent to sign-in" "HTTP $CODE → $LOC" '^HTTP 30[0-9] → .*/auth/login'
http norole -X POST "$APP/api/report/e2eden1/push-superiq"
expect c6 core "no-role user: push-superiq → 401" "HTTP $CODE" '^HTTP 401'
http - "$CB_LOC"
expect c7 core "the no_access page explains it and offers a different account (ends the SSO session)" "HTTP $CODE $(bodytxt | grep -o "Your account doesn't have access to GradeIQ" | head -1) | $(grep -o 'href="[^"]*auth/logout"' "$BODY" | head -1)" "^HTTP 200 Your account doesn't have access to GradeIQ \| href=\"$BASE/auth/logout\"$"
oidc_login noroleden "norole:denovo"
expect c8 core "no gradeiq role but giq_client=denovo attribute → still refused" "callback HTTP $L_CB → $CB_LOC; session: $( [ -n "$SESS_SET" ] && echo yes || echo no)" 'error=no_access; session: no$'
oidc_login cnot "client"
expect c9 core "gradeiq role client but NO giq_client → refused (no tenant-less client)" "callback → $CB_LOC; session: $( [ -n "$SESS_SET" ] && echo yes || echo no)" 'error=no_access; session: no$'
expect c10 core "each refusal is logged with its reason (server log)" "log lines: $(loglines '[auth] refused sign-in for')" '^log lines: [3-9]'
oidc_login deny "deny"
expect c11 core "user cancels at Keycloak → /login?error=access_denied" "callback → $CB_LOC" 'login\?error=access_denied$'

say "── (d) logout revokes"
http super1 "$APP/auth/logout"
LOGOUT_URL=$LOC
CLR=$(setck giq_session)
expect d1 core "/auth/logout → IdP end-session with id_token_hint + client_id + post_logout_redirect_uri" "HTTP $CODE → $(printf '%s' "$LOGOUT_URL" | redact)" "^HTTP 307 → $ISSUER/protocol/openid-connect/logout\?id_token_hint=<jwt>&post_logout_redirect_uri=http%3A%2F%2F127\.0\.0\.1%3A$GIQ_PORT%2Fapps%2Fgradeiq%2Flogin&client_id=gradeiq$"
expect d2 core "…and clears the cookie" "$CLR" "^giq_session=; Path=/; Expires=Thu, 01 Jan 1970"
expect d3 core "…and deletes the server-side session row" "rows for sid: $(dbq "SELECT count(*) FROM oidc_sessions WHERE sid='$SID1'")" "^rows for sid: 0$"
http - -H "Cookie: giq_session=$SID1" "$APP/api/portal/me"
expect d4 core "replaying the revoked sid → 401 (and tells the page where to sign in)" "HTTP $CODE $(cat "$BODY")" "^HTTP 401 \{\"user\":null,\"signIn\":\"$BASE/auth/login\"\}$"
http - "$LOGOUT_URL"
expect d5 core "IdP accepts the end-session (SSO session ended) and returns to GradeIQ /login" "HTTP $CODE → $LOC; idp: $(tail -1 "$OUT/idp-events.jsonl" | jq -c '{type}')" "^HTTP 302 → http://127\.0\.0\.1:$GIQ_PORT$BASE/login; idp: \{\"type\":\"logout_ok\"\}$"
if [ -n "$CADDY_SID" ]; then
  http - "${FW_HDRS[@]}" -H "Cookie: giq_session=$CADDY_SID" "$APP/auth/logout"
  PLR=$(q "$LOC" post_logout_redirect_uri)
  http - "$LOC"
  expect d6 prod-proxy "behind Caddy, post_logout_redirect_uri is $PUBLIC/login (in the realm allow-list)" "post_logout_redirect_uri=$PLR → IdP HTTP $CODE $(grep -o 'kc-error-message">[^<]*' "$BODY" | sed 's/.*">//')" "^post_logout_redirect_uri=$PUBLIC/login → IdP HTTP 302"
else
  result FAIL d6 prod-proxy "behind Caddy logout" "no Caddy session from a12"
fi
oidc_login super3 "super"; SID3=$SID
http super3 -X POST "$APP/api/portal/logout"; D7R=$(jq -r '.redirect // ""' "$BODY" | redact)
http super3 "$APP/api/portal/me"
expect d7 core "console 'Sign out' (POST /api/portal/logout) revokes the session and hands back Keycloak's end-session URL" "after sign-out: /api/portal/me HTTP $CODE; rows: $(dbq "SELECT count(*) FROM oidc_sessions WHERE sid='$SID3'"); redirect: $(printf '%s' "$D7R" | cut -c1-90)" "HTTP 401; rows: 0; redirect: $ISSUER/protocol/openid-connect/logout\?id_token_hint=<jwt>"
http - -H "Cookie: giq_session=$SID1" "$APP/superadmin"
info d8 design "a revoked sid still passes the middleware (presence check only); the page then asks /api/portal/me, gets signIn, and goes to Keycloak" "GET /superadmin with revoked cookie → HTTP $CODE"

say "── (e) no password path while oidc"
for cred in admin:admin altaf:altaf denovo:denovo swapmoreus:swapmoreus swapmoreind:swapmoreind inzman:inzman "e2estored:$STORED_PW"; do
  u=${cred%%:*}; p=${cred#*:}
  login_pw "leg_$u" "$u" "$p"
  expect "e1.$u" core "POST /api/portal/login $u/<$( [ "$u" = e2estored ] && echo throwaway || echo built-in default)> → 404, nothing checked, no cookie" "HTTP $CODE cookie: $(setck giq_portal | cut -d';' -f1 | sed -E 's/=.+/=<set>/')" '^HTTP 404 cookie: $'
done
login_pw leg_bad admin "not-$(openssl rand -hex 4)"
expect e1.x core "…a WRONG password gets the very same answer (no password oracle)" "HTTP $CODE" '^HTTP 404$'
FORGED=$(legacy_portal_cookie admin admin)
http - -H "Cookie: giq_portal=$FORGED" "$APP/api/portal/me"
expect e2 core "a giq_portal cookie computed offline from the public default (admin/admin) → 401" "HTTP $CODE" '^HTTP 401'
http - -H "Cookie: giq_portal=$FORGED" "$APP/superadmin"
expect e3 core "…and the middleware ignores it (/superadmin → OIDC start)" "HTTP $CODE → $LOC" "^HTTP 307 → $HOSTRE$BASE/auth/login"
http ent -X POST -H 'content-type: application/json' -d '{"user":"denovo","pass":"denovo"}' "$APP/api/enterprise/login"
expect e4 core "POST /api/enterprise/login denovo/denovo → 404, no cookie" "HTTP $CODE cookie: $(setck ent_session | cut -d';' -f1 | sed -E 's/=.+/=<set>/')" '^HTTP 404 cookie: $'
http - -H "Cookie: ent_session=x" "$APP/api/sessions"; E5A="$CODE"
http - -H "Cookie: ent_session=x" "$APP/console/denovo"
expect e5 core "an ent_session cookie grants nothing (/api/sessions, /console/denovo)" "api/sessions HTTP $E5A; console HTTP $CODE → $LOC" "^api/sessions HTTP 401; console HTTP 307 → $HOSTRE$BASE/auth/login"
http - -X POST -d 'grant_type=client_credentials&client_id=cli_live_gradeiq&client_secret=csec_gradeiq_dev' "$APP/api/customers/auth/token"
expect e7 core "retired Pandas token endpoint (built-in default client) → 410" "HTTP $CODE $(jq -c .error.code "$BODY" 2>/dev/null)" '^HTTP 410'
http - -H "Authorization: Bearer $(legacy_pandas_token)" "$APP/api/customers/sessions/e2eden1"
expect e8 core "a retired-scheme Pandas HMAC token (public default key) → 401" "HTTP $CODE" '^HTTP 401'
http - "$APP/login"
expect e9 core "/login renders only the SSO launcher — no password field" "HTTP $CODE password-input=$(grep -c 'type="password"' "$BODY") sso-link=$(grep -c 'Continue to sign in' "$BODY")" '^HTTP 200 password-input=0 sso-link=1$'
SSO_HREF=$(grep -o 'href="[^"]*auth/login[^"]*"' "$BODY" | head -1 | sed 's/^href="//; s/"$//; s/&amp;/\&/g')
http - "http://127.0.0.1:$GIQ_PORT$SSO_HREF"
expect e11 core "the /login 'Continue to sign in' link reaches the OIDC start (was a double-basePath 404)" "href=$SSO_HREF → HTTP $CODE${LOC:+ → $(short "$LOC" 90)}" "^href=$BASE/auth/login\?returnTo=%2Fsuperadmin → HTTP 307 → $ISSUER/protocol/openid-connect/auth"
http - "$APP/channel/retail"
expect e10 core "/channel/retail (had its own password form) → OIDC start" "HTTP $CODE → $LOC" "^HTTP 307 → $HOSTRE$BASE/auth/login"
oidc_login super6 "super"
http super6 -X POST -H 'content-type: application/json' -d '{"op":"create","username":"e2enew","password":"whatever1","role":"client","clientId":"denovo"}' "$APP/api/portal/users"
expect e12 core "no new GradeIQ passwords can be minted in oidc (/api/portal/users create → 409)" "HTTP $CODE $(short "$(cat "$BODY")" 80)" '^HTTP 409'

say "── (f) machine-to-machine"
T_PANDAS=$(cc_token pandas-api "$S_PANDAS"); T_SWAP=$(cc_token swapmore-svc "$S_SWAPMORE"); T_SVC=$(cc_token gradeiq-svc "$S_GRADEIQ_SVC")
info f0 mock "client_credentials tokens minted by the mock (Keycloak-shaped claims)" "pandas-api $(jwtclaims "$T_PANDAS" | jq -c '{aud,azp}') · swapmore-svc $(jwtclaims "$T_SWAP" | jq -c '{aud,azp}') · gradeiq-svc $(jwtclaims "$T_SVC" | jq -c '{aud,azp}')"
http - -H "Authorization: Bearer $T_PANDAS" "$APP/api/customers/sessions/e2eden1"
expect f1 core "pandas-api token → GET /api/customers/sessions/e2eden1 → 200" "HTTP $CODE $(short "$(cat "$BODY")" 90)" '^HTTP 200'
http - -X POST -H "Authorization: Bearer $T_SWAP" -H 'content-type: application/json' --data-binary @"$WT/lib/pricebook-swapmore.seed.json" "$APP/api/clients/swapmore/pricebook"
expect f2 core "swapmore-svc token → POST /api/clients/swapmore/pricebook → 200" "HTTP $CODE $(cat "$BODY")" '^HTTP 200 \{"ok":true'
http - -H "Authorization: Bearer $T_SVC" "$APP/api/customers/sessions/e2eden1"
expect f3 core "wrong audience (gradeiq-svc, aud superiq-erp) on customers → 401" "HTTP $CODE $(cat "$BODY")" '^HTTP 401 .*invalid_token'
http - -X POST -H "Authorization: Bearer $T_SVC" -H 'content-type: application/json' -d '{}' "$APP/api/clients/swapmore/pricebook"
expect f4 core "wrong audience on pricebook → 401" "HTTP $CODE" '^HTTP 401'
http - -H "Authorization: Bearer $T_SWAP" "$APP/api/customers/sessions/e2eden1"
expect f5 core "right audience, wrong client (swapmore-svc on customers) → 403" "HTTP $CODE $(cat "$BODY")" '^HTTP 403 .*unauthorized_client'
http - -X POST -H "Authorization: Bearer $T_PANDAS" -H 'content-type: application/json' -d '{}' "$APP/api/clients/swapmore/pricebook"
expect f6 core "right audience, wrong client (pandas-api on pricebook) → 403" "HTTP $CODE" '^HTTP 403'
http - "$APP/api/customers/sessions/e2eden1"; F7A=$CODE
http - -X POST -H 'content-type: application/json' -d '{}' "$APP/api/clients/swapmore/pricebook"
expect f7 core "no token → 401 on both" "customers HTTP $F7A; pricebook HTTP $CODE" '^customers HTTP 401; pricebook HTTP 401'
T_HUMAN=$(forge '{"claims":{"aud":["superiq-erp","account"],"azp":"gradeiq","typ":"Bearer","sub":"u1","resource_access":{"gradeiq":{"roles":["super"]}}}}')
http - -H "Authorization: Bearer $T_HUMAN" "$APP/api/customers/sessions/e2eden1"
expect f8 core "a human (staff) access token is not an M2M token → 401" "HTTP $CODE" '^HTTP 401'
T_ROGUE=$(forge '{"signer":"rogue","claims":{"aud":["gradeiq","account"],"azp":"pandas-api","typ":"Bearer"}}')
http - -H "Authorization: Bearer $T_ROGUE" "$APP/api/customers/sessions/e2eden1"
expect f9 core "pandas-shaped token signed by a foreign key (same kid) → 401" "HTTP $CODE" '^HTTP 401'
T_EXP=$(forge "{\"claims\":{\"aud\":[\"gradeiq\",\"account\"],\"azp\":\"pandas-api\",\"iat\":$(( $(date +%s) - 900 )),\"exp\":$(( $(date +%s) - 600 ))}}")
http - -H "Authorization: Bearer $T_EXP" "$APP/api/customers/sessions/e2eden1"
expect f10 core "expired pandas token → 401" "HTTP $CODE" '^HTTP 401'
T_ISS=$(forge '{"claims":{"iss":"http://127.0.0.1:1/realms/other","aud":["gradeiq","account"],"azp":"pandas-api"}}')
http - -H "Authorization: Bearer $T_ISS" "$APP/api/customers/sessions/e2eden1"
expect f11 core "wrong issuer → 401" "HTTP $CODE" '^HTTP 401'
oidc_login super2 "super"; SID2=$SID
http - -X POST "$APP/api/report/e2eden1/push-superiq"
expect f12 core "push-superiq without a staff session → 401" "HTTP $CODE $(cat "$BODY")" '^HTTP 401'
http super2 -X POST "$APP/api/report/e2eden1/push-superiq"
RECV=$(curl -s "http://127.0.0.1:$RECV_PORT/last")
expect f13 core "push-superiq (super) → 200; receiver got a gradeiq-svc client_credentials token for aud superiq-erp, signature verified" \
  "HTTP $CODE · receiver: $(printf '%s' "$RECV" | jq -c '{verified,azp:.claims.azp,aud:.claims.aud,user:.claims.preferred_username,rows,source}')" \
  '^HTTP 200 · receiver: \{"verified":true,"azp":"gradeiq-svc","aud":\["superiq-erp","account"\],"user":"service-account-gradeiq-svc","rows":1'
http - -X POST "${FW_HDRS[@]}" -H "Cookie: giq_session=$SID2" "$APP/api/report/e2eden1/push-superiq"
expect f14 prod-proxy "push-superiq behind Caddy (X-Forwarded-Proto https) builds its payload in-process → 200" "HTTP $CODE $(short "$(cat "$BODY")" 80)" '^HTTP 200'
http - "${FW_HDRS[@]}" "$APP/api/report/e2eden1/export?format=superiq"
expect f15 prod-proxy "the export's report URL is the public one, not https://localhost" "HTTP $CODE reportUrl=$(jq -r '.rows[0].reportUrl' "$BODY" 2>/dev/null)" "^HTTP 200 reportUrl=$PUBLIC/report/e2eden1$"
http - -H "x-gradeiq-server-key: $SERVER_KEY" "$APP/api/imei/35693803"; F16A=$CODE
http - "$APP/api/imei/35693803"
expect f16 core "SwapUp's x-gradeiq-server-key still works in oidc mode (key 200, none 401)" "key $F16A; none $CODE" '^key 200; none 401$'

# ═════════════════════════════════════════════════════════════════════════════
section "B · rollback: set-auth-mode.sh legacy (same build)"
set_auth_mode legacy
expect B0 core "set-auth-mode.sh legacy: flag set, restarted, /superadmin → /login — no rebuild (same BUILD_ID)" "exit $RC; GIQ_AUTH_MODE=$(env_get GIQ_AUTH_MODE) ×$(env_count GIQ_AUTH_MODE); BUILD_ID $(cat "$WT/.next/BUILD_ID") mtime $(stat -f %m "$WT/.next/BUILD_ID" 2>/dev/null || stat -c %Y "$WT/.next/BUILD_ID")" "^exit 0; GIQ_AUTH_MODE=legacy ×1; BUILD_ID $BUILD_ID mtime $BUILD_MTIME$"
http - "$APP/superadmin"
expect B1 core "/superadmin unauthenticated → legacy /login (not the OIDC start)" "HTTP $CODE → $LOC" "^HTTP 307 → $HOSTRE$BASE/login\?returnTo=%2Fsuperadmin$"
http - "$APP/login"
expect B2 core "/login renders the username+password form, no 'defaults off' banner" "HTTP $CODE password-input=$(grep -c 'type="password"' "$BODY") sso-link=$(grep -c 'Continue to sign in' "$BODY") banner=$(grep -c 'default passwords are switched off' "$BODY")" '^HTTP 200 password-input=1 sso-link=0 banner=0$'
http - "$APP/auth/login?returnTo=%2Fsuperadmin"
expect B3 core "/auth/login does not start an IdP handshake in legacy" "HTTP $CODE → $LOC" "^HTTP 307 → $HOSTRE$BASE/login\?returnTo=%2Fsuperadmin$"
rm -f "$OUT/legB.jar"
login_pw legB admin admin
expect B4 core "explicit rollback restores the legacy logins: admin/admin → 200 + giq_portal" "HTTP $CODE $(setck giq_portal | redact | sed -E 's/=admin\.[^;]+/=admin.<token>/')" '^HTTP 200 giq_portal=admin.<token>; Path=/; Expires=[^;]+; Max-Age=1209600; HttpOnly; SameSite=lax'
LEGB_COOKIE=$(jarck legB giq_portal)
http legB "$APP/superadmin"; B5A=$CODE
http legB "$APP/api/portal/me"
expect B5 core "legacy session: /superadmin 200 and /api/portal/me = super" "superadmin HTTP $B5A; me HTTP $CODE $(jq -c .user "$BODY" 2>/dev/null)" '^superadmin HTTP 200; me HTTP 200 \{"username":"admin","role":"super","clientId":null\}$'
http legB "$APP/api/sessions"
expect B6 core "legacy session reaches the staff APIs" "HTTP $CODE rows=$(jq length "$BODY" 2>/dev/null)" '^HTTP 200 rows=2$'
http - -H "Cookie: giq_session=$SID2" "$APP/api/portal/me"
info B7 design "an OIDC session minted before the flip keeps working in legacy (flipping never signs anyone out)" "HTTP $CODE $(jq -c .user "$BODY" 2>/dev/null)"
T_PANDAS=$(cc_token pandas-api "$S_PANDAS")  # fresh: the earlier one can outlive its 5-min lifespan on a slow run
http - -H "Authorization: Bearer $T_PANDAS" "$APP/api/customers/sessions/e2eden1"
expect B8 core "M2M does not depend on GIQ_AUTH_MODE — only on KEYCLOAK_ISSUER" "pandas-api token in legacy → HTTP $CODE" '→ HTTP 200$'
http legB -X POST "$APP/api/portal/logout"
expect B9 core "legacy Sign out still just clears the cookie (no Keycloak redirect)" "HTTP $CODE $(cat "$BODY") $(setck giq_portal | cut -d';' -f1)" '^HTTP 200 \{"ok":true\} giq_portal=$'

# ═════════════════════════════════════════════════════════════════════════════
section "U · the flag is LOST after the cutover (e.g. a deploy rewrote .env.local)"
env_unset GIQ_AUTH_MODE; restart_app
http - "$APP/superadmin"
expect U1 core "GIQ_AUTH_MODE missing → legacy routing (/login)" "HTTP $CODE → $LOC" "^HTTP 307 → $HOSTRE$BASE/login"
login_pw - admin admin; U2A=$CODE
http - -H "Cookie: giq_portal=$LEGB_COOKIE" "$APP/api/portal/me"
expect U2 core "…but the built-in defaults stay OFF: admin/admin 401, the admin cookie from B 401" "admin/admin HTTP $U2A; B's cookie HTTP $CODE" '^admin/admin HTTP 401; B.s cookie HTTP 401$'
http - -X POST -H 'content-type: application/json' -d '{"user":"denovo","pass":"denovo"}' "$APP/api/enterprise/login"
expect U3 core "…denovo/denovo (enterprise default) 401" "HTTP $CODE" '^HTTP 401$'
login_pw - e2estored "$STORED_PW"
expect U4 design "…a password an operator set (stored user) still works" "HTTP $CODE" '^HTTP 200$'
http - "$APP/login"
expect U5 core "/login says the defaults are off" "HTTP $CODE banner=$(grep -c 'default passwords are switched off' "$BODY")" '^HTTP 200 banner=1$'
expect U6 core "the server log says why and what to set" "log lines: $(loglines '[auth] GIQ_AUTH_MODE is not set, but this server already moved to Keycloak')" '^log lines: [1-9]$'
http - -H "Cookie: giq_session=$SID2" "$APP/api/portal/me"
expect U7 core "signed-in Keycloak sessions keep working" "HTTP $CODE $(jq -c .user.role "$BODY" 2>/dev/null)" '^HTTP 200 "super"$'

# ═════════════════════════════════════════════════════════════════════════════
section "C · set-auth-mode.sh oidc again"
set_auth_mode oidc
expect C0 core "set-auth-mode.sh oidc → exit 0, flag oidc ×1" "exit $RC; GIQ_AUTH_MODE=$(env_get GIQ_AUTH_MODE) ×$(env_count GIQ_AUTH_MODE)" '^exit 0; GIQ_AUTH_MODE=oidc ×1$'
http - "$APP/superadmin"
expect C1 core "/superadmin unauthenticated → OIDC start again" "HTTP $CODE → $LOC" "^HTTP 307 → $HOSTRE$BASE/auth/login\?returnTo=%2Fsuperadmin$"
http - -H "Cookie: giq_portal=$LEGB_COOKIE" "$APP/api/portal/me"; C2A=$CODE
http - -H "Cookie: giq_portal=$LEGB_COOKIE" "$APP/superadmin"
expect C2 core "the legacy cookie issued in B is dead in oidc" "me HTTP $C2A; /superadmin HTTP $CODE → $LOC" "^me HTTP 401; /superadmin HTTP 307 → $HOSTRE$BASE/auth/login"
oidc_login super4 "super"; SID4=$SID
http super4 "$APP/api/portal/me"
expect C3 core "OIDC login works again after the round trip" "callback HTTP $L_CB; me HTTP $CODE $(jq -c .user.role "$BODY" 2>/dev/null)" '^callback HTTP 307; me HTTP 200 "super"$'
http - -H "Cookie: giq_session=$SID2" "$APP/api/portal/me"
info C4 design "session SID2 (minted in A, used in B and U) still valid in C" "HTTP $CODE"

# ═════════════════════════════════════════════════════════════════════════════
section "D · Keycloak down or misconfigured (GIQ_AUTH_MODE=oidc)"
say "── D-cold: Keycloak down before GradeIQ starts (nothing cached)"
stop_mock; restart_app
http - "$APP/superadmin"; D1=$LOC
http - "$D1"; D1C=$CODE; D1S=$SECS; D2=$LOC
expect D1 core "staff route → /auth/login → /login?error=idp_unavailable, fast" "/auth/login HTTP $D1C in ${D1S}s → $D2" "^/auth/login HTTP 307 in 0\.[0-9]+s → $HOSTRE$BASE/login\?returnTo=%2Fsuperadmin&error=idp_unavailable$"
http - "$D2"
D2MSG=$(bodytxt | grep -o "Single sign-on isn't answering right now[^<]*" | head -1 | cut -c1-60)
D2HREF=$(grep -o 'href="[^"]*auth/login[^"]*"' "$BODY" | head -1 | sed 's/^href="//; s/"$//; s/&amp;/\&/g')
D2PW=$(grep -c 'type="password"' "$BODY")
http - "http://127.0.0.1:$GIQ_PORT$D2HREF"
expect D2 core "the page explains it, shows no password form, and its 'Try again' reaches the sign-in start (no 404)" "msg=\"$D2MSG…\" password-input=$D2PW; Try again → HTTP $CODE → $(printf '%s' "$LOC" | sed -E "s#$HOSTRE##")" "^msg=\"Single sign-on isn't answering right now.*\" password-input=0; Try again → HTTP 307 → $BASE/login\?returnTo=%2Fsuperadmin&error=idp_unavailable$"
expect D2b core "…and the outage is logged" "log lines: $(loglines '[auth] sign-in could not start: Keycloak discovery at')" '^log lines: [1-9]'
http - -H "Cookie: giq_session=$SID4" "$APP/api/portal/me"
expect D3 core "an already-signed-in staff session keeps working (sessions are local rows)" "HTTP $CODE $(jq -c .user.role "$BODY" 2>/dev/null)" '^HTTP 200 "super"$'
login_pw - admin admin
expect D4 core "no password fallback opens while Keycloak is down: admin/admin → 404" "HTTP $CODE" '^HTTP 404$'
http - -H "Cookie: giq_session=$SID4" "$APP/auth/logout"; D5C=$CODE; D5L=$LOC; D5CLR=$(setck giq_session)
http - -H "Cookie: giq_session=$SID4" "$APP/api/portal/me"
expect D5 core "logout while Keycloak is down still revokes locally (row deleted, cookie cleared) and lands on /login" "logout HTTP $D5C → $(printf '%s' "$D5L" | sed -E "s#$HOSTRE##"); Set-Cookie: $(printf '%s' "${D5CLR:-none}" | cut -c1-14); then me HTTP $CODE; rows=$(dbq "SELECT count(*) FROM oidc_sessions WHERE sid='$SID4'")" "^logout HTTP 307 → $BASE/login; Set-Cookie: giq_session=;.*then me HTTP 401; rows=0$"
http - -H "Authorization: Bearer $T_PANDAS" "$APP/api/customers/sessions/e2eden1"
expect D6 core "M2M while Keycloak is down (no cached JWKS) → clean 503" "HTTP $CODE $(short "$(cat "$BODY")" 80)" '^HTTP 503'
http - -X POST -H "Cookie: giq_session=$SID2" "$APP/api/report/e2eden1/push-superiq"
expect D7 core "push-superiq while Keycloak is down → 503 with the reason" "HTTP $CODE $(short "$(cat "$BODY")" 80)" '^HTTP 503'

say "── D-hung: Keycloak accepts connections but never answers"
start_mock MOCK_HANG=1; restart_app
http - "$APP/auth/login?returnTo=%2Fsuperadmin"; H1S=$SECS; H1="$CODE → $(printf '%s' "$LOC" | sed -E "s#$HOSTRE##")"
http - "$APP/auth/login?returnTo=%2Fsuperadmin"; H2S=$SECS
lt "$H1S" 6 && H1OK=yes || H1OK=no; lt "$H2S" 1 && H2OK=yes || H2OK=no
expect D8 core "a hung Keycloak times out (≤ ~4 s, was ~11 s) and the next attempts fail fast for 15 s" "first ${H1S}s (<6: $H1OK) $H1; second ${H2S}s (<1: $H2OK)" "<6: yes\) 307 → $BASE/login\?returnTo=%2Fsuperadmin&error=idp_unavailable; second [0-9.]+s \(<1: yes\)$"
preflight; PFS=$RC
expect D9 core "the preflight says Keycloak isn't answering, within its 3 s budget" "exit $PFS; $(grep -m1 'not reachable' "$OUTFILE")" '^exit 1; FAIL +Keycloak is not reachable from this machine: no answer within 3s$'
stop_mock

say "── D-warm: Keycloak dies AFTER GradeIQ cached discovery + JWKS"
start_mock; restart_app
T_PANDAS2=$(cc_token pandas-api "$S_PANDAS")
oidc_login super5 "super"; SID5=$SID
http - -H "Authorization: Bearer $T_PANDAS2" "$APP/api/customers/sessions/e2eden1"; WARM_PRE=$CODE
stop_mock
http - "$APP/auth/login?returnTo=%2Fsuperadmin"
info D10 design "warm: /auth/login still redirects to the (dead) Keycloak authorize URL — discovery is cached; the browser gets connection-refused there" "HTTP $CODE → $(printf '%s' "$LOC" | cut -c1-60)…"
http - -H "Authorization: Bearer $T_PANDAS2" "$APP/api/customers/sessions/e2eden1"
expect D11 core "warm: M2M keeps verifying from the cached JWKS" "before kill HTTP $WARM_PRE; after kill HTTP $CODE" '^before kill HTTP 200; after kill HTTP 200$'
http - -H "Cookie: giq_session=$SID5" "$APP/auth/logout"; D12C=$CODE; D12L=$LOC
info D12 design "warm: logout revokes locally, then sends the browser to Keycloak's end-session (cached)" "HTTP $D12C → $(printf '%s' "$D12L" | cut -c1-60)…; rows=$(dbq "SELECT count(*) FROM oidc_sessions WHERE sid='$SID5'")"

say "── D-misconfig: GIQ_AUTH_MODE=oidc but KEYCLOAK_ISSUER missing"
start_mock
SAVED_ISSUER=$(env_get KEYCLOAK_ISSUER); env_unset KEYCLOAK_ISSUER; restart_app
http - "$APP/superadmin"; DM1="$CODE → $(printf '%s' "$LOC" | sed -E "s#$HOSTRE##")"
http - "$APP/auth/login?returnTo=%2Fsuperadmin"; DM2="$CODE → $(printf '%s' "$LOC" | sed -E "s#$HOSTRE##")"
login_pw - admin admin
expect D13 core "a lost KEYCLOAK_ISSUER does not silently re-open the built-in defaults: stays oidc, explains, admin/admin 404" "/superadmin $DM1; /auth/login $DM2; admin/admin HTTP $CODE" "^/superadmin 307 → $BASE/auth/login\?returnTo=%2Fsuperadmin; /auth/login 307 → $BASE/login\?returnTo=%2Fsuperadmin&error=sso_misconfigured; admin/admin HTTP 404$"
expect D14 core "…and logs which env NAME is missing (never a value)" "log lines: $(loglines '[auth] GIQ_AUTH_MODE=oidc but KEYCLOAK_ISSUER is not set')" '^log lines: [1-9]'
preflight; expect D15 core "the preflight names the missing variable" "exit $RC; $(grep -m1 'KEYCLOAK_ISSUER is not set' "$OUTFILE")" '^exit 1; FAIL +KEYCLOAK_ISSUER is not set'
env_set KEYCLOAK_ISSUER "$SAVED_ISSUER"

say "── D-mismatch: Keycloak calls itself something else"
stop_mock; start_mock MOCK_ISSUER_OVERRIDE="http://kc.example.invalid/realms/novetta"; restart_app
http - "$APP/auth/login?returnTo=%2Fsuperadmin"
expect D16 core "issuer string mismatch is caught BEFORE the password step → sso_misconfigured" "HTTP $CODE → $(printf '%s' "$LOC" | sed -E "s#$HOSTRE##")" "error=sso_misconfigured$"
preflight; expect D17 core "the preflight explains the mismatch" "exit $RC; $(grep -m1 'calls itself' "$OUTFILE" | cut -c1-80)" '^exit 1; FAIL +Keycloak calls itself "http://kc.example.invalid/realms/novetta"'

say "── D-badsecret: OIDC_CLIENT_SECRET wrong"
stop_mock; start_mock
env_set OIDC_CLIENT_SECRET "wrong$(openssl rand -hex 8)"; restart_app
oidc_login badsec "super"
expect D18 core "a wrong client secret fails at the token exchange → sso_misconfigured, no session, logged" "callback → $(printf '%s' "$CB_LOC" | sed -E "s#$HOSTRE##"); session: $( [ -n "$SESS_SET" ] && echo yes || echo no); log lines: $(loglines 'rejected client "gradeiq" at the token endpoint (HTTP 401)')" "^callback → $BASE/login\?error=sso_misconfigured; session: no; log lines: [1-9]"
preflight; expect D19 core "the preflight catches it too" "exit $RC; $(grep -m1 'REJECTS' "$OUTFILE" | cut -c1-70)" '^exit 1; FAIL +Keycloak REJECTS OIDC_CLIENT_SECRET'
env_set OIDC_CLIENT_SECRET "$S_GRADEIQ"; restart_app
oidc_login good "super"
expect D20 core "with the right secret back (env edit + restart) sign-in works again" "callback HTTP $L_CB → $(printf '%s' "$CB_LOC" | sed -E "s#$HOSTRE##")" "^callback HTTP 307 → $BASE/superadmin$"

# ═════════════════════════════════════════════════════════════════════════════
section "I · user import (scripts/import-users-to-keycloak.mjs vs a mock Keycloak admin API)"
KCA_PASS=$(openssl rand -hex 12)
start_kca() { # [extra env…]
  stop_pid kca; wait_port_free "$KCA_PORT"
  env -i PATH="$PATH" HOME="$HOME" KCA_PORT="$KCA_PORT" KCA_ADMIN_USER=e2e-kc-admin KCA_ADMIN_PASS="$KCA_PASS" KCA_LOG="$OUT/kca.jsonl" "$@" \
    node "$WT/scripts/e2e-keycloak/mock-kc-admin.mjs" >> "$OUT/kca.log" 2>&1 < /dev/null &
  echo $! > "$OUT/kca.pid"; disown $! 2>/dev/null
  wait_http "http://127.0.0.1:$KCA_PORT/kca/state" || die "mock admin API did not start"
}
import_users() { # args… → OUTFILE, RC
  OUTFILE="$OUT/import-$((N+1)).out"; N=$((N+1))
  (cd "$WT" && env -i PATH="$PATH" HOME="$OUT/home" KEYCLOAK_ISSUER="http://127.0.0.1:$KCA_PORT/realms/novetta" KC_ADMIN_USER=e2e-kc-admin KC_ADMIN_PASS="$KCA_PASS" \
    node scripts/import-users-to-keycloak.mjs "$@" > "$OUTFILE" 2>&1 < /dev/null); RC=$?
}
kstate() { curl -s "http://127.0.0.1:$KCA_PORT/kca/state"; }
temp_pws() { grep -hv '^#' "$@" 2>/dev/null | cut -s -f3 | grep -v '^$'; } # the password column only
# A consistent copy (WAL included), the way a prod DB copy is taken: .backup.
mkdir -p "$OUT/home"; sqlite3 "$DB" ".backup '$OUT/import-copy.db'" || die "db backup failed"
start_kca
import_users --db "$OUT/no-such.db"
expect I1 core "--db pointing at a missing file fails loudly (no silent built-ins-only import)" "exit $RC; $(head -1 "$OUTFILE")" '^exit 1; --db .*no such file$'
import_users --dry --db "$OUT/import-copy.db"
expect I2 core "--dry: reads only (no write calls), plans the 6 built-ins + the stored user, sees the realm's own admin" \
  "exit $RC; writes=$(jq -r 'select(.method!="GET" and (.path|startswith("/admin"))) | .path' "$OUT/kca.jsonl" | wc -l | tr -d ' '); $(grep -c '^  + ' "$OUTFILE") to create; $(grep -o '= admin \[super\]: already in the realm' "$OUTFILE")" \
  '^exit 0; writes=0; 6 to create; = admin \[super\]: already in the realm$'
import_users --db "$OUT/import-copy.db" --passwords-out "$OUT/first-passwords.txt"
PWN=$(grep -vc '^#' "$OUT/first-passwords.txt" 2>/dev/null)
expect I3 core "import: 6 created with roles + giq_client + a TEMPORARY password; the realm's admin is not touched" \
  "exit $RC; $(kstate | jq -c '[.users[] | {u:.username,r:.roles[0],c:(.attributes.giq_client[0] // null),t:.credentials[0].temporary}]')" \
  '^exit 0; \[\{"u":"admin","r":"super","c":"denovo","t":false\},\{"u":"altaf","r":"super","c":null,"t":true\},\{"u":"denovo","r":"client","c":"denovo","t":true\},\{"u":"swapmoreus","r":"client","c":"swapmore","t":true\},\{"u":"swapmoreind","r":"client","c":"swapmore-in","t":true\},\{"u":"inzman","r":"client","c":"inzman","t":true\},\{"u":"e2estored","r":"client","c":"denovo","t":true\}\]$'
expect I4 core "the temporary passwords go to a mode-600 file only — never to the output" \
  "file mode $(stat -f %Lp "$OUT/first-passwords.txt" 2>/dev/null || stat -c %a "$OUT/first-passwords.txt"), $PWN entries; in output: $(temp_pws "$OUT/first-passwords.txt" | while read -r pw; do grep -cF -- "$pw" "$OUTFILE"; done | paste -sd+ - | bc)" \
  '^file mode 600, 6 entries; in output: 0$'
import_users --db "$OUT/import-copy.db" --passwords-out "$OUT/first-passwords-2.txt"
expect I5 core "re-run: nothing re-created, no new passwords, exit 0" "exit $RC; $(tail -1 "$OUTFILE"); new file: $( [ -f "$OUT/first-passwords-2.txt" ] && echo yes || echo no)" '^exit 0; created=0 existing=7 repaired=0 failed=0; new file: no$'
start_kca KCA_DROP_UNDECLARED=1
import_users --passwords-out "$OUT/first-passwords-3.txt"
expect I6 core "a realm that DROPS giq_client (undeclared in the user profile) is caught: client users fail loudly, exit 1" "exit $RC; $(grep -c 'DROPPED giq_client' "$OUTFILE") failures; $(tail -1 "$OUTFILE")" '^exit 1; 4 failures; created=1 existing=1 repaired=0 failed=4$'
expect I7 core "the admin password and the temporary passwords never reach the import output or the admin API log" "leaks=$(n=0; for f in "$OUT"/import-*.out "$OUT/kca.jsonl"; do grep -qF -- "$KCA_PASS" "$f" && n=$((n+1)); temp_pws "$OUT"/first-passwords*.txt | while read -r pw; do grep -qF -- "$pw" "$f" && echo x; done | grep -q x && n=$((n+1)); done; echo $n)" '^leaks=0$'
stop_pid kca

# ═════════════════════════════════════════════════════════════════════════════
section "N · SUP-86 trust · SUP-72 paid IMEI lookups · SUP-77 M2M without Keycloak"
say "── SUP-86: GET /api/sessions/{id} carries trust (contracts/grade-result.ts)"
http - "$APP/api/sessions/e2eden1"
expect N1 core "the session API carries trust (integer 0..100) beside the unchanged grade fields, and names its contract" \
  "HTTP $CODE trust=$(jq -r '.trust' "$BODY") ($(jq -r '.trust|type' "$BODY")) fields=$(jq -c '[.overall_grade,.cosmetic_grade,.functional_grade,.client_id,.model]' "$BODY") identity=$(jq -r '.identity.verdict' "$BODY") contract=$(hval x-gradeiq-contract)" \
  '^HTTP 200 trust=[0-9]{1,3} \(number\) fields=\["B","B","Working","denovo","iPhone 13"\] identity=(match|mismatch|unverified) contract=grade-result/1$'

say "── SUP-72: paid IMEI lookups (the receiver is Phonecheck's Cloud DB)"
env_set PHONECHECK_API_URL "http://127.0.0.1:$RECV_PORT"
env_set PHONECHECK_API_KEY "$S_PC"; env_set PHONECHECK_USERNAME e2e
env_set GRADEIQ_ANON_LOOKUP_CAP 2
env_set GRADEIQ_ANON_UPLOAD_SESSION_CAP 3
env_set GRADEIQ_RETAIL_KEY "$S_RETAIL"
env_set PRICEBOOK_SYNC_SECRET "$S_SYNC"; env_set SUPERIQ_TOKEN "$S_SUPERIQ_TOKEN"
restart_app
pc_calls() { curl -s "http://127.0.0.1:$RECV_PORT/pc" | jq -r '.calls'; }
mkimei() { python3 -c 'import sys
b=sys.argv[1]; s=0
for i,c in enumerate(b):
    d=int(c)
    if i%2==1:
        d*=2
        if d>9: d-=9
    s+=d
print(b+str((10-s%10)%10))' "$1"; }
create_s() { # IP JSON-body [extra curl args…] — a browser behind Caddy (X-Forwarded-For)
  local ip=$1 body=$2; shift 2
  http - -X POST -H 'content-type: application/json' -H "X-Forwarded-For: $ip" "$@" -d "$body" "$APP/api/sessions"
}
I1=$(mkimei 35124296500001); I2=$(mkimei 35124296500002); I3=$(mkimei 35124296500003)
I4=$(mkimei 35124296500004); I5=$(mkimei 35124296500005); I6=$(mkimei 35124296500006)
P0=$(pc_calls)
create_s 198.51.100.7 "{\"imei\":\"$I1\",\"client\":\"swapmore\",\"segment\":\"c2b\"}"; N2A="$CODE $(jq -r '.imeiInfo.source' "$BODY")"
create_s 198.51.100.7 "{\"imei\":\"$I2\",\"client\":\"swapmore\",\"segment\":\"c2b\"}"; N2B="$CODE $(jq -r '.imeiInfo.source' "$BODY")"
P1=$(pc_calls)
expect N2 core "an embed seller's lookups (?client=swapmore, within the cap) are paid and name the model" "creates: $N2A, $N2B; Phonecheck calls: $((P1-P0)); model=$(jq -r .model "$BODY")" '^creates: 200 gsma, 200 gsma; Phonecheck calls: 4; model=Galaxy Z Flip5$'
create_s 198.51.100.7 "{\"imei\":\"$I3\",\"client\":\"swapmore\",\"segment\":\"c2b\"}"; SID_CAP=$(jq -r '.id // empty' "$BODY"); P2=$(pc_calls)
expect N3 core "past GRADEIQ_ANON_LOOKUP_CAP (2) the session is still created — with ZERO Phonecheck calls" "HTTP $CODE id=$( [ -n "$SID_CAP" ] && echo yes || echo no) skipped=$(jq -r '.imeiInfo.skipped' "$BODY") source=$(jq -r '.imeiInfo.source' "$BODY") Phonecheck calls: $((P2-P1))" '^HTTP 200 id=yes skipped=daily-cap source=(tac|stub) Phonecheck calls: 0$'
http - "$APP/api/sessions/$SID_CAP"
expect N4 core "…and its identity reads unverified, saying why" "verdict=$(jq -r '.identity.verdict' "$BODY") reason=$(jq -r '.identity.flags[]' "$BODY" | grep -c 'daily lookup limit was reached')" '^verdict=unverified reason=1$'
http - -X POST -H "X-Forwarded-For: 198.51.100.7" "$APP/api/sessions/$SID_CAP/offer"; N5A=$CODE
http - -X POST -H "X-Forwarded-For: 198.51.100.7" "$APP/api/sessions/$SID_CAP/accept"; N5B=$CODE
expect N5 core "/offer and /accept on that session cannot buy the refused lookup" "offer HTTP $N5A, accept HTTP $N5B; Phonecheck calls: $(( $(pc_calls) - P2 ))" '^offer HTTP 200, accept HTTP 200; Phonecheck calls: 0$'
P3=$(pc_calls)
create_s 203.0.113.50 "{\"imei\":\"$I4\",\"client\":\"denovo\",\"channel\":\"retail\",\"segment\":\"c2b\"}"; N6A="$(jq -r '.imeiInfo.source' "$BODY")"
create_s 198.51.100.7 "{\"imei\":\"$I5\",\"segment\":\"c2b\"}" -H "x-gradeiq-server-key: $SERVER_KEY"; N6B="$(jq -r '.imeiInfo.source' "$BODY")"
expect N6 core "the cap is per address (another IP's retail desk is paid), and SwapUp's server key is never capped" "other IP: $N6A; server key from the capped IP: $N6B; Phonecheck calls: $(( $(pc_calls) - P3 ))" '^other IP: gsma; server key from the capped IP: gsma; Phonecheck calls: 4$'
P3R=$(pc_calls); N6R=""
for b in 35124296500011 35124296500012 35124296500013; do
  create_s 198.51.100.7 "{\"imei\":\"$(mkimei $b)\",\"client\":\"denovo\",\"channel\":\"retail\",\"segment\":\"c2b\"}" -H "x-gradeiq-retail-key: $S_RETAIL"
  N6R="$N6R$(jq -r '.imeiInfo.source' "$BODY") "
done
create_s 198.51.100.7 "{\"imei\":\"$(mkimei 35124296500014)\",\"client\":\"denovo\",\"channel\":\"retail\",\"segment\":\"c2b\"}" -H "x-gradeiq-retail-key: wrong$(openssl rand -hex 4)"
expect N6R core "CounterIQ's retail key: three desks' creates from the CAPPED address are all paid; a wrong key is capped" "with key: ${N6R}· wrong key: $(jq -r '.imeiInfo.skipped' "$BODY") · Phonecheck calls: $(( $(pc_calls) - P3R ))" '^with key: gsma gsma gsma · wrong key: daily-cap · Phonecheck calls: 6$'
P4=$(pc_calls)
create_s 203.0.113.51 "{\"imei\":\"$I6\",\"segment\":\"c2b\"}"
expect N7 core "no known channel (default client, no channel): no paid lookup at all, model from the TAC only" "HTTP $CODE skipped=$(jq -r '.imeiInfo.skipped' "$BODY") source=$(jq -r '.imeiInfo.source' "$BODY") Phonecheck calls: $(( $(pc_calls) - P4 ))" '^HTTP 200 skipped=no-channel source=(tac|stub) Phonecheck calls: 0$'
create_s 198.51.100.7 "{\"imei\":\"$I1\",\"client\":\"swapmore\",\"segment\":\"c2b\"}"
expect N8 core "a cached IMEI is free even past the cap" "HTTP $CODE source=$(jq -r '.imeiInfo.source' "$BODY") skipped=$(jq -r '.imeiInfo.skipped // "no"' "$BODY") Phonecheck calls: $(( $(pc_calls) - P4 ))" '^HTTP 200 source=gsma skipped=no Phonecheck calls: 0$'
oidc_login nstaff "super"
http nstaff -X POST -H 'content-type: application/json' -d "{\"imei\":\"$I2\"}" "$APP/api/journeys/denovo-tradein-employee/start"
expect N9 core "journey start with a cached IMEI: one cached lookup, ZERO Phonecheck calls" "HTTP $CODE model=$(jq -r '.model' "$BODY") Phonecheck calls: $(( $(pc_calls) - P4 ))" '^HTTP 200 model=Galaxy Z Flip5 Phonecheck calls: 0$'
http nstaff "$APP/api/settings"
expect N10 core "staff see the day's paid lookups (GET /api/settings → paidLookups)" "HTTP $CODE $(jq -c '.paidLookups | {total, byCaller, skipped, cap, ipsAtCap, totalCap, totalReached}' "$BODY")" \
  '^HTTP 200 \{"total":7,"byCaller":\{"server":1,"retail":3,"staff":0,"channel":3,"internal":0\},"skipped":5,"cap":2,"ipsAtCap":1,"totalCap":200,"totalReached":false\}$'

say "── SUP-66 review: /functional judged per result; a seller's pick priced at the lowest grade"
create_s 203.0.113.90 '{"model":"iPhone 13","client":"denovo","segment":"c2b"}'; WSID=$(jq -r '.id // empty' "$BODY")
http - -X POST -H 'content-type: application/json' -d '{"functional":{"touch":"pass","speaker":"fail","camera":"skip"},"camera":{"lenses":[{"id":"wide","name":"Wide","facing":"rear","state":"pass","by":"browser"},{"id":"tele","name":"Telephoto","facing":"rear","state":"manual"}]},"merge":true}' "$APP/api/sessions/$WSID/functional"; W1A=$CODE
http - -X POST -H 'content-type: application/json' -d '{"functional":{"touch":"pass","speaker":"pass","vibration":"fail","camera":"pass"},"camera":{"lenses":[{"id":"wide","state":"pass","by":"browser"},{"id":"tele","state":"pass","by":"browser"},{"id":"front","name":"Front","facing":"front","state":"pass","by":"browser"}]},"merge":true}' "$APP/api/sessions/$WSID/functional"
expect W1 core "a self-test re-run: the recorded fail, the untestable lens and the camera line are kept — everything else saves (200)" \
  "first $W1A; re-run HTTP $CODE refused=$(jq -c '.refused' "$BODY") stored=$(jq -c '.session | [.functional.speaker, .functional.vibration, .functional.camera, (.camera.lenses|length), .camera.manual]' "$BODY") notice=$(jq -r '.notice[0:24]' "$BODY")" \
  '^first 200; re-run HTTP 200 refused=\["speaker: fail → pass","lens tele: manual → pass \(the browser cannot test this lens\)","camera: pass → skip \(lenses not all verified\)"\] stored=\["fail","fail","skip",3,1\] notice=Saved — except Speaker, '
http - -X POST -H 'content-type: application/json' -d '{"grade":"Premium"}' "$APP/api/sessions/$WSID/grade-manual"; W2A=$CODE
http - -X POST "$APP/api/sessions/$WSID/offer"
expect W2 core "a seller's own pick (Premium) is priced at the lowest grade until the store confirms it" \
  "pick $W2A; offer HTTP $CODE $(jq -c '.offer | {provisional, gradeRange, atFloor: (.offer == .floor), upside: (.ceiling > .floor)}' "$BODY")" \
  '^pick 200; offer HTTP 200 \{"provisional":true,"gradeRange":\{"best":"Premium","worst":"D"\},"atFloor":true,"upside":true\}$'

say "── SUP-77: M2M with KEYCLOAK_ISSUER set — Keycloak only"
http - -X POST -H "x-sync-secret: $S_SYNC" -H 'content-type: application/json' --data-binary @"$WT/lib/pricebook-swapmore.seed.json" "$APP/api/clients/swapmore/pricebook"
expect N11 core "with Keycloak configured, SwapMore's x-sync-secret alone is no longer accepted" "HTTP $CODE $(cat "$BODY")" '^HTTP 401 \{"error":"missing_bearer_token"\}$'

say "── SUP-77: today's prod — no KEYCLOAK_ISSUER, GIQ_AUTH_MODE=legacy"
env_unset KEYCLOAK_ISSUER; env_set GIQ_AUTH_MODE legacy
# SUP-72 review: the daily total for all anonymous callers, set to what they have
# already spent today (N2 + N6A = 3) so the next keyless create meets it (N17).
env_set GRADEIQ_ANON_LOOKUP_TOTAL_CAP 3
LOG_MARK=$(wc -l < "$OUT/app.log" | tr -d ' ')
restart_app
http - -X POST -H "x-sync-secret: $S_SYNC" -H 'content-type: application/json' --data-binary @"$WT/lib/pricebook-swapmore.seed.json" "$APP/api/clients/swapmore/pricebook"; N12A="$CODE $(jq -c '{ok,models}' "$BODY")"
http - -X POST -H "x-sync-secret: wrong$(openssl rand -hex 8)" -H 'content-type: application/json' -d '{}' "$APP/api/clients/swapmore/pricebook"; N12B=$CODE
http - -X POST -H 'content-type: application/json' -d '{}' "$APP/api/clients/swapmore/pricebook"; N12C=$CODE
expect N12 core "pricebook takes SwapMore's x-sync-secret = PRICEBOOK_SYNC_SECRET (right 200, wrong 401, none 401)" "right $N12A; wrong $N12B; none $N12C" '^right 200 \{"ok":true,"models":[0-9]+\}; wrong 401; none 401$'
http - -H "Authorization: Bearer x.y.z" "$APP/api/customers/sessions/e2eden1"
expect N13 core "customers API without Keycloak → 503 not_configured" "HTTP $CODE $(jq -c '.error.code' "$BODY")" '^HTTP 503 "not_configured"$'
http nstaff -X POST "$APP/api/report/e2eden1/push-superiq"
expect N14 core "push-superiq without Keycloak sends SUPERIQ_TOKEN as the Bearer → 200 (SuperIQ's legacy ingest)" "HTTP $CODE · receiver: $(curl -s "http://127.0.0.1:$RECV_PORT/last" | jq -c '{static,rows}')" '^HTTP 200 · receiver: \{"static":true,"rows":1\}$'
env_unset PRICEBOOK_SYNC_SECRET; env_unset SUPERIQ_TOKEN; restart_app
http - -X POST -H "x-sync-secret: $S_SYNC" -H 'content-type: application/json' -d '{}' "$APP/api/clients/swapmore/pricebook"; N15A="$CODE $(jq -r '.error' "$BODY")"
http nstaff -X POST "$APP/api/report/e2eden1/push-superiq"
expect N15 core "secrets unset → clean 503 'not configured' on both (pricebook, push-superiq)" "pricebook $N15A; push HTTP $CODE $(jq -r '.error' "$BODY")" '^pricebook 503 not configured: PRICEBOOK_SYNC_SECRET is not set on GradeIQ; push HTTP 503 SuperIQ push not configured: set SUPERIQ_TOKEN'
expect N16 core "no 'KEYCLOAK_ISSUER is not set' error or stack trace in the server log without Keycloak" "lines: $(tail -n +"$((LOG_MARK+1))" "$OUT/app.log" | grep -cE 'KEYCLOAK_ISSUER is not set|^[[:space:]]+at ' || true)" '^lines: 0$'

say "── SUP-72 review: the daily total for all anonymous callers"
P5=$(pc_calls)
create_s 203.0.113.77 "{\"imei\":\"$(mkimei 35124296500021)\",\"client\":\"swapmore\",\"segment\":\"c2b\"}"; N17A="$CODE $(jq -r '.imeiInfo.skipped' "$BODY")"
create_s 203.0.113.78 "{\"imei\":\"$(mkimei 35124296500022)\",\"client\":\"swapmore\",\"segment\":\"c2b\"}"; N17B="$CODE $(jq -r '.imeiInfo.skipped' "$BODY")"
expect N17 core "a fresh address under its own cap still gets no paid lookup once all anonymous callers reached GRADEIQ_ANON_LOOKUP_TOTAL_CAP (3)" "creates: $N17A, $N17B; Phonecheck calls: $(( $(pc_calls) - P5 ))" '^creates: 200 total-cap, 200 total-cap; Phonecheck calls: 0$'
expect N18 core "…which is written to the server log ONCE for the day" "lines: $(tail -n +"$((LOG_MARK+1))" "$OUT/app.log" | grep -c 'reached the daily total of 3 paid IMEI lookups' || true)" '^lines: 1$'
create_s 203.0.113.77 "{\"imei\":\"$(mkimei 35124296500023)\",\"client\":\"denovo\",\"channel\":\"retail\",\"segment\":\"c2b\"}" -H "x-gradeiq-retail-key: $S_RETAIL"
expect N19 core "the retail key is not part of the anonymous total" "HTTP $CODE source=$(jq -r '.imeiInfo.source' "$BODY") Phonecheck calls: $(( $(pc_calls) - P5 ))" '^HTTP 200 source=gsma Phonecheck calls: 2$'

say "── SUP-88: the program configurator is staff-only, its API super-only"
http - -X POST -H 'content-type: application/json' -d '{"message":"Add a $500 trade-in bonus"}' "$APP/api/configurator"
expect N20 core "anonymous POST /api/configurator → 401, and the global program config is untouched" "HTTP $CODE · program_config rows: $(dbq "SELECT COUNT(*) FROM settings WHERE key = 'program_config'")" '^HTTP 401 · program_config rows: 0$'
http - "$APP/configurator"
expect N21 core "/configurator with no sign-in → the middleware sends it to sign in (basePath kept)" "HTTP $CODE → $LOC" "^HTTP 307 → $HOSTRE$BASE/(login|auth/login)\\?returnTo=%2Fconfigurator$"

say "── SUP-80: upload size caps and the anonymous per-session limit (GRADEIQ_ANON_UPLOAD_SESSION_CAP=3)"
create_s 198.51.100.80 '{"client":"swapmore","segment":"c2b"}'; U_ID=$(jq -r '.id' "$BODY")
U_FILES0=$(ls "$WT/data/uploads" | wc -l | tr -d ' ')
python3 -c 'import sys; sys.stdout.write("{\"frames\":[{\"photo\":\"data:image/jpeg;base64," + "A"*(7*1024*1024) + "\"}]}")' > "$OUT/big-frames.json"
http - -X POST -H 'content-type: application/json' -H 'X-Forwarded-For: 198.51.100.80' --data-binary @"$OUT/big-frames.json" "$APP/api/sessions/$U_ID/camera-frames"
expect N22 core "a 7 MB body on /camera-frames (cap 6 MB) → 413 before it is parsed, nothing written" "HTTP $CODE $(jq -r '.error' "$BODY") · files written: $(( $(ls "$WT/data/uploads" | wc -l | tr -d ' ') - U_FILES0 ))" '^HTTP 413 payload too large · files written: 0$'
U_FRAME='{"frames":[{"lensId":"rear-1","name":"Wide","facing":"rear","photo":"data:image/jpeg;base64,/9j/4AAQSkZJRg=="}]}'
U_CODES=""
for _ in 1 2 3 4; do
  http - -X POST -H 'content-type: application/json' -H 'X-Forwarded-For: 198.51.100.80' -d "$U_FRAME" "$APP/api/sessions/$U_ID/camera-frames"; U_CODES="$U_CODES$CODE "
done
U_RETRY=$(hval retry-after); U_REASON=$(jq -r '.reason' "$BODY")
expect N23 core "the 4th anonymous upload on one session → 429 with Retry-After, nothing written, the refusal in the session trail" \
  "codes: ${U_CODES}· reason=$U_REASON retry-after=$([ -n "$U_RETRY" ] && [ "$U_RETRY" -gt 0 ] && echo set || echo missing) · files written: $(( $(ls "$WT/data/uploads" | wc -l | tr -d ' ') - U_FILES0 )) · trail: $(dbq "SELECT COUNT(*) FROM session_events WHERE session_id = '$U_ID' AND event = 'rate-limited'")" \
  '^codes: 200 200 200 429 · reason=session-daily retry-after=set · files written: 3 · trail: 1$'
http - -X POST -H 'content-type: application/json' -H 'X-Forwarded-For: 198.51.100.80' -H "x-gradeiq-server-key: $SERVER_KEY" -d "$U_FRAME" "$APP/api/sessions/$U_ID/camera-frames"
expect N24 core "SwapUp's server key is never limited: the same session from the same address → 200" "HTTP $CODE saved=$(jq -r '.saved' "$BODY")" '^HTTP 200 saved=1$'

say "── SUP-63: a grade stuck on refining reads as unfinished, and reading it writes nothing"
# The background upload's placeholder exactly as /cosmetic stores it, an hour old:
# the process that was grading it is gone.
ST_AT=$(( $(date +%s) * 1000 - 3600000 ))
dbq "INSERT INTO sessions (id, model, status, client_id, photos, cosmetic)
     VALUES ('e2estuck','iPhone 13','open','swapmore','[]','{\"refining\":true,\"findings\":[],\"_submitId\":$ST_AT}');" || die "seed failed"
st_row() { dbq "SELECT * FROM sessions WHERE id = 'e2estuck'" | shasum | cut -c1-12; }
ST_ROW0=$(st_row); ST_EV0=$(dbq "SELECT COUNT(*) FROM session_events WHERE session_id = 'e2estuck'")
http - "$APP/api/sessions/e2estuck"
expect N25 core "GET /api/sessions/{id}, refining for an hour → refine.state unfinished; cosmetic.refining sent as stored" "HTTP $CODE $(jq -c '{state:.refine.state,after:.refine.unfinishedAfterSeconds,refining:.cosmetic.refining}' "$BODY")" '^HTTP 200 \{"state":"unfinished","after":421,"refining":true\}$'
http - "$APP/report/e2estuck"
expect N26 core "the seller's report says grading didn't finish: no spinner, no clean 'no damage' tick" "HTTP $CODE unfinished=$(bodytxt | grep -c "Grading didn't finish") spinner=$(bodytxt | grep -c 'Full inspection still running') cleanTick=$(bodytxt | grep -c 'No visible damage located')" '^HTTP 200 unfinished=[1-9][0-9]* spinner=0 cleanTick=0$'
http nstaff "$APP/report/e2estuck"
expect N27 core "the staff report says it on the re-grade bar, with Re-grade now (the staff /reprocess path)" "HTTP $CODE notice=$(bodytxt | grep -c 'Grading did not finish') action=$(bodytxt | grep -c 'Re-grade now') spinner=$(bodytxt | grep -c 'Full inspection still running')" '^HTTP 200 notice=[1-9][0-9]* action=[1-9][0-9]* spinner=0$'
expect N28 core "reading it (the API, both reports) changed no rows" "row: $([ "$(st_row)" = "$ST_ROW0" ] && echo same || echo CHANGED) · events: $(( $(dbq "SELECT COUNT(*) FROM session_events WHERE session_id = 'e2estuck'") - ST_EV0 ))" '^row: same · events: 0$'

# ═════════════════════════════════════════════════════════════════════════════
section "summary"
expect Z1 core "no throwaway secret leaked into any log or output of this run" "leaks=$(leaks "$OUT"/*.out "$OUT"/*.log "$FAKE_SSH_LOG")" '^leaks=0$'
stop_app; stop_recv; stop_mock
say "PASS=$PASSN FAIL=$FAILN WARN=$WARNN INFO=$INFON   (STRICT=$STRICT)"
say "evidence: $OUT  (e2e.log, results.tsv, http/<n>.hdr|.body + http/index.tsv, *.out from the owner's scripts, idp-events.jsonl, receiver.jsonl, app.log)"
say "worktree: $WT"
[ "$FAILN" -gt 125 ] && FAILN=125
exit "$FAILN"
