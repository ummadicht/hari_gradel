#!/usr/bin/env bash
# Proves deploy/release.sh and deploy/rollback.sh against a stand-in VM on this
# machine. It never reaches a real VM: ssh is replaced (GIQ_SSH) by a stand-in
# that runs commands locally in a fake home, `ssh` itself is shadowed by a stub
# that fails, pm2 is scripts/release-test/fake-pm2.sh and Caddy+app is
# scripts/release-test/stub-app.mjs.
#
#   bash scripts/release-test/run.sh               every scenario with a fake build (~1 min)
#   bash scripts/release-test/run.sh --with-build  plus one REAL release: npm ci + gates +
#                                                  next build, served by a real `next start`
#
# The scripts under test are the ones in this working tree (committed or not):
# they are copied into a throwaway clone, whose deploy/LIVE.json baseline the
# stand-in VM is built to match.
set -euo pipefail
export PATH=$HOME/.local/share/fnm/aliases/default/bin:$PATH

HERE=$(cd "$(dirname "$0")" && pwd)
SRC=$(git -C "$HERE/../.." rev-parse --show-toplevel)
WITH_BUILD=0
[ "${1:-}" = --with-build ] && WITH_BUILD=1
TMP=${TMPDIR:-/tmp}
OUT=${GIQ_RELEASE_TEST_DIR:-${TMP%/}/gradeiq-release-test}
OUT=${OUT%/}
if [ -e "$OUT" ]; then
  [ -f "$OUT/.gradeiq-release-test" ] || { echo "refusing to reuse $OUT — it is not a release-test dir" >&2; exit 1; }
  git -C "$OUT/repo" worktree prune 2>/dev/null || true
  rm -rf "$OUT"
fi
mkdir -p "$OUT/shim" "$OUT/runs"
touch "$OUT/.gradeiq-release-test"
[ -d "$SRC/node_modules/better-sqlite3" ] || { echo "run npm ci in $SRC first" >&2; exit 1; }

PASS=0 FAILED=0
check() { # DESCRIPTION COMMAND… — one assertion
  local d=$1; shift
  if "$@" > /dev/null 2>&1; then PASS=$((PASS + 1)); printf '  ok   %s\n' "$d"
  else FAILED=$((FAILED + 1)); printf '  FAIL %s\n' "$d"; fi
}
has() { grep -qF -- "$2" "$OUT/$1.out"; }
hasnt() { ! grep -qF -- "$2" "$OUT/$1.out"; }

SECRET="release-test-secret-$RANDOM$RANDOM$RANDOM"
SECRET2="release-test-env-file-$RANDOM$RANDOM$RANDOM"

# ── the stand-in for `ssh` itself: anything that bypasses GIQ_SSH fails loudly ─
cat > "$OUT/shim/ssh" <<SH
#!/usr/bin/env bash
echo "real ssh was invoked: \$*" >> "$OUT/REAL-SSH-ATTEMPTS"
exit 97
SH
chmod +x "$OUT/shim/ssh"

# ── test repo: a clone carrying this working tree, pushed to a local origin ──
echo "setting up the test repo"
git clone -q --bare "$SRC" "$OUT/origin.git"
git clone -q "$OUT/origin.git" "$OUT/repo"
R="$OUT/repo"
git -C "$R" checkout -q -b release-test "$(git -C "$SRC" rev-parse HEAD)"
git -C "$R" config user.email release-test@localhost
git -C "$R" config user.name "release test"
(cd "$SRC" && git ls-files -co --exclude-standard -z) | while IFS= read -r -d '' f; do
  [ -f "$SRC/$f" ] || continue
  mkdir -p "$R/$(dirname "$f")"; cp -p "$SRC/$f" "$R/$f"
done
(cd "$SRC" && git ls-files -d -z) | while IFS= read -r -d '' f; do rm -f "$R/$f"; done
git -C "$R" add -A
git -C "$R" commit -q -m "release-test: the working tree under test" || true
BASE=$(node -e 'console.log(require(process.argv[1]).commit)' "$R/deploy/LIVE.json")
BASE_BUILD=$(node -e 'console.log(require(process.argv[1]).build_id)' "$R/deploy/LIVE.json")
# Exercise a deletion and an env file that must never ship.
DELETED=docs/CLAUDE-INSPECTION-PLATFORM-HANDOFF.md
git -C "$R" cat-file -e "$BASE:$DELETED"
git -C "$R" rm -q "$DELETED"
printf 'GRADEIQ_SERVER_KEY=%s\n' "$SECRET2" > "$R/.env.production"
git -C "$R" add -f .env.production
git -C "$R" commit -q -m "release-test: delete a file, commit an env file"
CAND=$(git -C "$R" rev-parse HEAD)
git -C "$R" push -q origin release-test
# A runtime dependency change, on its own pushed branch.
git -C "$R" checkout -q -b dep-change
node -e '
  const fs = require("fs"); const f = process.argv[1]; const j = JSON.parse(fs.readFileSync(f, "utf8"));
  const k = Object.keys(j.packages).find(k => k.endsWith("node_modules/qrcode") && !j.packages[k].dev);
  j.packages[k].version = "9.9.9"; fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");' "$R/package-lock.json"
git -C "$R" commit -q -am "release-test: bump a runtime dependency"
git -C "$R" push -q origin dep-change
git -C "$R" checkout -q release-test
CHANGED=$(git -C "$R" diff --name-only --no-renames "$BASE" "$CAND" | grep -v '^\.env' | wc -l | tr -d ' ')
NEWFILE=$(git -C "$R" diff --name-only --diff-filter=A "$BASE" "$CAND" | grep '^lib/' | head -1)
MODFILE=package.json
echo "  baseline ${BASE:0:7} / $BASE_BUILD → candidate ${CAND:0:7}: $CHANGED files change (new: $NEWFILE, deleted: $DELETED)"

# ── the stand-in VM ──────────────────────────────────────────────────────────
VMH="$OUT/vm" APP="$OUT/vm/gradeiq" ST="$OUT/vmstate"
make_vm() {
  rm -rf "$VMH" "$ST"
  mkdir -p "$APP" "$VMH/bin" "$ST"
  git -C "$R" archive "$BASE" | tar -x -C "$APP"
  mkdir -p "$APP/.next/server/chunks" "$APP/.next/static/chunks"
  printf '%s' "$BASE_BUILD" > "$APP/.next/BUILD_ID"
  echo old > "$APP/.next/server/chunks/old.js"
  ln -s "$SRC/node_modules" "$APP/node_modules"
  (umask 077; printf 'NEXT_PUBLIC_BASE_PATH=/apps/gradeiq\nGRADEIQ_SERVER_KEY=%s\n' "$SECRET" > "$APP/.env.local")
  (cd "$APP" && node --experimental-strip-types --no-warnings --import "$SRC/lib/capture/ts-resolve.mjs" \
    --input-type=module -e "await import('$SRC/lib/db.ts')")
  node -e 'const D = require(process.argv[1]); const d = new D(process.argv[2]);
    d.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run("release-test", "marker"); d.close();' \
    "$SRC/node_modules/better-sqlite3" "$APP/data/gradeiq.db"
  cp "$HERE/fake-pm2.sh" "$VMH/bin/pm2"; chmod +x "$VMH/bin/pm2"
  echo 4 > "$ST/restarts"; echo online > "$ST/status"; echo up > "$ST/mode"
  printf '%s' "$BASE_BUILD" > "$ST/serving"; : > "$ST/calls.log"
  echo "Error: an old error from before any release — must be ignored" > "$ST/gradeiq-error.log"
}
fingerprint() { # every file of the app dir (not node_modules/data/kept builds), hashed
  (cd "$APP" && find . \( -path ./node_modules -o -path ./data -o -name '.next.bak-*' -o -name '.next.undone-*' -o -name .next.new \) -prune \
    -o -type f -print0 | LC_ALL=C sort -z | xargs -0 shasum -a 256) | shasum -a 256 | cut -c1-16
}
db_rows() { node -e 'const D = require(process.argv[1]); const d = new D(process.argv[2], { readonly: true });
  console.log(d.prepare("SELECT count(*) AS n FROM settings").get().n);' "$SRC/node_modules/better-sqlite3" "$1"; }
vm_build() { cat "$APP/.next/BUILD_ID"; }
restarts() { cat "$ST/restarts"; }

FAKE_SSH="$OUT/fake-ssh"
cat > "$FAKE_SSH" <<SH
#!/usr/bin/env bash
# Stand-in for ssh: drops options, logs host + remote command (never stdin) and
# runs the command locally, in the stand-in VM's home with its pm2 on PATH.
while [ \$# -gt 0 ]; do case \$1 in -i|-o|-p|-l|-F|-J) shift 2;; --) shift; break;; -*) shift;; *) break;; esac; done
host=\$1; shift
printf '%s\t%s\n' "\$host" "\$*" >> "$OUT/fake-ssh.log"
cd "$VMH"
export HOME="$VMH" PATH="$VMH/bin:\$PATH" FAKE_VM_STATE="$ST" FAKE_VM_APP="$APP"
# The release scripts send their remote scripts on stdin to "bash -s": keep a copy.
if [ "\$*" = "bash -s" ]; then exec bash -c "tee -a '$OUT/fake-ssh-scripts.log' | bash -s"; fi
exec bash -c "\$*"
SH
chmod +x "$FAKE_SSH"

node "$HERE/stub-app.mjs" "$ST" "$OUT/stub.port" > "$OUT/stub.log" 2>&1 &
STUB_PID=$!
NEXT_PID_FILE="$ST/next.pid"
teardown() {
  kill "$STUB_PID" 2>/dev/null || true
  [ -f "$NEXT_PID_FILE" ] && kill "$(cat "$NEXT_PID_FILE")" 2>/dev/null || true
}
trap teardown EXIT
for _ in $(seq 1 50); do [ -s "$OUT/stub.port" ] && break; sleep 0.1; done
PORT=$(cat "$OUT/stub.port")

FAKE_BUILD='mkdir -p .next/server/chunks .next/static/chunks .next/cache && printf "fake%s" "$RANDOM$RANDOM" > .next/BUILD_ID && echo new > .next/server/chunks/new.js && echo skip > .next/cache/never-shipped'
ENVS=(PATH="$OUT/shim:$PATH" GIQ_SSH="$FAKE_SSH" GIQ_VM=ammar@stand-in-vm
      GIQ_PUBLIC_URL="http://127.0.0.1:$PORT/apps/gradeiq" GIQ_HEALTH_TRIES=3 GIQ_HEALTH_WAIT=1
      GIQ_LOG_SETTLE=1 GIQ_RUN_DIR="$OUT/runs" FAKE_SECRET="$SECRET" GIQ_FAKE_BUILD="$FAKE_BUILD")
# run NAME COMMAND… — run in the test repo with the stand-in env; output → $OUT/NAME.out, rc → $RC
run() {
  local name=$1; shift
  set +e
  (cd "$R" && env "${ENVS[@]}" "$@") > "$OUT/$name.out" 2>&1
  RC=$?
  set -e
  printf '  · %s exited %s\n' "$name" "$RC"
}
stamp_of() { grep -oE 'rollback\.sh [0-9]{8}T[0-9]{6}Z-[0-9a-f]+' "$OUT/$1.out" | head -1 | cut -d' ' -f2; }
reset_repo() { git -C "$R" checkout -q release-test && git -C "$R" reset -q --hard "$CAND"; }
head_is() { [ "$(git -C "$R" rev-parse HEAD)" = "$1" ]; }
live_is() { [ "$(node -e 'const j=require(process.argv[1]);console.log(j.commit+" "+j.build_id)' "$R/deploy/LIVE.json")" = "$1 $2" ]; }

echo; echo "S0 · the old deploy.sh and the test hook refuse"
make_vm; reset_repo
run s0-deploy bash deploy/deploy.sh
check "deploy.sh exits non-zero" [ "$RC" != 0 ]
check "deploy.sh points to release.sh" has s0-deploy "deploy/release.sh"
set +e
(cd "$R" && env PATH="$OUT/shim:$PATH" GIQ_FAKE_BUILD=true bash deploy/release.sh) > "$OUT/s0-hook.out" 2>&1; RC=$?
set -e
check "GIQ_FAKE_BUILD is refused without a stand-in VM" [ "$RC" != 0 ]
check "… with the reason" has s0-hook "GIQ_FAKE_BUILD is a test hook"

echo; echo "S1 · --plan and DRY_RUN=1 change nothing"
make_vm; reset_repo
FP0=$(fingerprint)
run s1-plan bash deploy/release.sh --plan
check "--plan exits 0" [ "$RC" = 0 ]
check "--plan lists the gates and the rollback command" has s1-plan "If 8 or 9 fail: bash deploy/rollback.sh"
check "--plan reports npm test as a gate" has s1-plan "npm test [yes]"
check "--plan reports check-authz absent" has s1-plan "scripts/check-authz.mjs [no]"
check "--plan does not list the env file as shipped" hasnt s1-plan "+ .env.production"
run s1-dry env DRY_RUN=1 bash deploy/release.sh
check "DRY_RUN=1 exits 0" [ "$RC" = 0 ]
check "… and says PLAN ONLY" has s1-dry "PLAN ONLY"
check "VM files unchanged" [ "$(fingerprint)" = "$FP0" ]
check "no releases dir created" [ ! -e "$VMH/gradeiq-releases" ]
check "pm2 never restarted" [ "$(restarts)" = 4 ]
check "no commit made" head_is "$CAND"

echo; echo "S2 · preflight: the VM serves a different build → abort, nothing changed"
make_vm; reset_repo
printf 'someone-else' > "$APP/.next/BUILD_ID"; FP0=$(fingerprint)
run s2 bash deploy/release.sh
check "exits non-zero" [ "$RC" != 0 ]
check "says why" has s2 "the VM serves build someone-else but deploy/LIVE.json says $BASE_BUILD"
check "says nothing was changed" has s2 "preflight failed — nothing was changed"
check "VM untouched" [ "$(fingerprint)" = "$FP0" ]
check "no lock / backup dir" [ ! -e "$VMH/gradeiq-releases" ]
check "no rollback offered (nothing to roll back)" hasnt s2 "rollback.sh 2"

echo; echo "S3 · preflight: a file it would replace was changed on the VM → abort"
make_vm; reset_repo
echo '// hand edit on the VM' >> "$APP/$MODFILE"; FP0=$(fingerprint)
run s3 bash deploy/release.sh
check "exits non-zero" [ "$RC" != 0 ]
check "names the file" has s3 "$MODFILE on the VM is not the ${BASE:0:7} version"
check "VM untouched" [ "$(fingerprint)" = "$FP0" ]

echo; echo "S4 · preflight: a file it would add already exists on the VM → abort"
make_vm; reset_repo
mkdir -p "$APP/$(dirname "$NEWFILE")"; echo 'stray' > "$APP/$NEWFILE"; FP0=$(fingerprint)
run s4 bash deploy/release.sh
check "exits non-zero" [ "$RC" != 0 ]
check "names the file" has s4 "$NEWFILE is new in"
check "VM untouched" [ "$(fingerprint)" = "$FP0" ]

echo; echo "S5 · preflight: another release holds the lock → abort"
make_vm; reset_repo
mkdir -p "$VMH/gradeiq-releases/.lock"; echo "20990101T000000Z-abc1234" > "$VMH/gradeiq-releases/.lock/owner"
run s5 bash deploy/release.sh
check "exits non-zero" [ "$RC" != 0 ]
check "says who holds it" has s5 "another release holds the lock (20990101T000000Z-abc1234)"

echo; echo "S6 · refusals: runtime dependency change, unpushed commit"
make_vm; reset_repo; FP0=$(fingerprint)
run s6-dep bash deploy/release.sh origin/dep-change
check "dependency change exits non-zero" [ "$RC" != 0 ]
check "… says the VM's node_modules would not match" has s6-dep "runtime dependencies changed"
check "… VM untouched" [ "$(fingerprint)" = "$FP0" ]
echo "unpushed" > "$R/UNPUSHED.md"; git -C "$R" add UNPUSHED.md; git -C "$R" commit -q -m "release-test: unpushed"
run s6-unpushed bash deploy/release.sh
check "unpushed commit exits non-zero" [ "$RC" != 0 ]
check "… asks to push first" has s6-unpushed "is not on any remote branch — push it first"
reset_repo

echo; echo "S7 · health check fails after the swap → non-zero + rollback command; rollback restores the VM exactly"
make_vm; reset_repo; FP0=$(fingerprint)
run s7 env FAKE_APP_AFTER_RESTART=down bash deploy/release.sh
S7=$(stamp_of s7)
check "release exits non-zero" [ "$RC" != 0 ]
check "says UNHEALTHY" has s7 "UNHEALTHY"
check "prints the rollback command" has s7 "bash deploy/rollback.sh $S7"
check "LIVE.json not rewritten, nothing committed" head_is "$CAND"
check "the new build is on the VM (so there is something to undo)" [ "$(vm_build)" != "$BASE_BUILD" ]
check "the release lock was released" [ ! -e "$VMH/gradeiq-releases/.lock" ]
FP_BAD=$(fingerprint)
run s7-rbplan bash deploy/rollback.sh --plan "$S7"
check "rollback --plan exits 0" [ "$RC" = 0 ]
check "rollback --plan changes nothing" [ "$(fingerprint)" = "$FP_BAD" ]
echo up > "$ST/mode"
run s7-rb bash deploy/rollback.sh "$S7"
check "rollback exits 0" [ "$RC" = 0 ]
check "VM files are exactly as before the release" [ "$(fingerprint)" = "$FP0" ]
check "the baseline build is back" [ "$(vm_build)" = "$BASE_BUILD" ]
check "the deleted file is back" [ -f "$APP/$DELETED" ]
check "the added file is gone from the app dir" [ ! -e "$APP/$NEWFILE" ]
check "… and kept in the release's backup" [ -f "$VMH/gradeiq-releases/$S7/undone-added/$NEWFILE" ]
check "every restored file verified against the baseline" has s7-rb "every restored file matches ${BASE:0:7}"
check "LIVE.json already matched — no commit" head_is "$CAND"
run s7-rb2 bash deploy/rollback.sh "$S7"
check "a second rollback of the same release is refused" [ "$RC" != 0 ]
check "… because it was already rolled back" has s7-rb2 "was already rolled back"

echo; echo "S8 · errors in the pm2 log after the restart → non-zero; --record accepts; rollback reverts LIVE.json"
make_vm; reset_repo; FP0=$(fingerprint)
run s8 env FAKE_PM2_ERR_ON_RESTART="Error: Cannot find module 'jose'" bash deploy/release.sh
S8=$(stamp_of s8)
check "release exits non-zero" [ "$RC" != 0 ]
check "shows the new error line" has s8 "Cannot find module 'jose'"
check "ignores errors logged before the release" hasnt s8 "an old error from before any release"
check "prints the rollback command" has s8 "bash deploy/rollback.sh $S8"
check "health itself passed" has s8 "    healthy"
check "nothing committed yet" head_is "$CAND"
run s8-record bash deploy/release.sh --record "$S8"
NEWB=$(vm_build)
check "--record exits 0" [ "$RC" = 0 ]
check "--record commits LIVE.json = candidate + new build" live_is "$CAND" "$NEWB"
check "… as a commit touching only deploy/LIVE.json" [ "$(git -C "$R" show --name-only --format= HEAD)" = deploy/LIVE.json ]
run s8-rb bash deploy/rollback.sh "$S8"
check "rollback exits 0" [ "$RC" = 0 ]
check "VM files are exactly as before" [ "$(fingerprint)" = "$FP0" ]
check "LIVE.json committed back to the baseline" live_is "$BASE" "$BASE_BUILD"
check "… in a new commit" [ "$(git -C "$R" rev-list --count "$CAND"..HEAD)" = 2 ]

echo; echo "S9 · a healthy release, end to end"
make_vm; reset_repo; FP0=$(fingerprint)
ENV_HASH=$(shasum -a 256 "$APP/.env.local" | cut -c1-64)
run s9 bash deploy/release.sh
S9=$(stamp_of s9); NEWB=$(vm_build)
check "release exits 0" [ "$RC" = 0 ]
check "says RELEASED" has s9 "RELEASED GradeIQ ${CAND:0:7}"
check "the VM serves a new build" [ "$NEWB" != "$BASE_BUILD" ]
check "the stub app serves it (pm2 restarted)" [ "$(cat "$ST/serving")" = "$NEWB" ]
check "pm2 restarted exactly once" [ "$(restarts)" = 5 ]
check "pm2 restart without --update-env" [ "$(grep -c -- '--update-env' "$ST/calls.log" || true)" = 0 ]
check "the previous build is kept" [ "$(cat "$APP/.next.bak-$S9/BUILD_ID")" = "$BASE_BUILD" ]
check ".next/cache is never uploaded" [ ! -e "$APP/.next/cache" ]
check "no .next.new left behind" [ ! -e "$APP/.next.new" ]
ok_files=1
while IFS= read -r f; do
  case "$f" in .env* | deploy/LIVE.json) continue ;; esac
  if git -C "$R" cat-file -e "$CAND:$f" 2>/dev/null; then
    [ "$(git -C "$R" show "$CAND:$f" | shasum -a 256)" = "$(shasum -a 256 < "$APP/$f")" ] || { ok_files=0; echo "    differs: $f"; }
  else
    [ ! -e "$APP/$f" ] || { ok_files=0; echo "    should be gone: $f"; }
  fi
done < <(git -C "$R" diff --name-only --no-renames "$BASE" "$CAND")
check "every changed file on the VM is byte-identical to the candidate" [ "$ok_files" = 1 ]
check "the deleted file is backed up" [ -f "$VMH/gradeiq-releases/$S9/src/$DELETED" ]
check "the replaced file's old version is backed up" [ "$(git -C "$R" show "$BASE:$MODFILE" | shasum -a 256)" = "$(shasum -a 256 < "$VMH/gradeiq-releases/$S9/src/$MODFILE")" ]
check "the committed .env.production was NOT shipped" [ ! -e "$APP/.env.production" ]
check "… and the output says so" has s9 "(not shipped — env files never are) .env.production"
check "the VM's .env.local is untouched" [ "$(shasum -a 256 "$APP/.env.local" | cut -c1-64)" = "$ENV_HASH" ]
check "the DB backup is a real copy" [ "$(db_rows "$VMH/gradeiq-releases/$S9/gradeiq.db")" = "$(db_rows "$APP/data/gradeiq.db")" ]
check "LIVE.json = candidate + new build, committed" live_is "$CAND" "$NEWB"
check "the release lock was released" [ ! -e "$VMH/gradeiq-releases/.lock" ]
check "nothing was rsynced with --delete" [ "$(cat "$OUT/fake-ssh.log" "$OUT/fake-ssh-scripts.log" | grep -c -- '--delete' || true)" = 0 ]
check "no npm on the VM" [ "$(cat "$OUT/fake-ssh.log" "$OUT/fake-ssh-scripts.log" | grep -cE '(^|[ ;&|(])npm ' || true)" = 0 ]
check "no .env file read or written on the VM" [ "$(cat "$OUT/fake-ssh.log" "$OUT/fake-ssh-scripts.log" | grep -c '\.env' || true)" = 0 ]
check "pm2 restart never passes --update-env" [ "$(grep -c -- 'update-env' "$OUT/fake-ssh-scripts.log" || true)" = 0 ]
LIVE_AFTER=$(git -C "$R" rev-parse HEAD)
run s9-again bash deploy/release.sh
check "releasing again: nothing to release" has s9-again "Nothing to release"
check "… exits 0" [ "$RC" = 0 ]
git -C "$R" checkout -q "$CAND"   # an older checkout's LIVE.json is stale
run s9-stale bash deploy/release.sh --plan
check "a checkout with a stale LIVE.json is refused" [ "$RC" != 0 ]
check "… pointing at git pull" has s9-stale "this checkout's LIVE.json is stale (git pull)"
git -C "$R" checkout -q release-test
run s9-rb bash deploy/rollback.sh "$S9"
check "rollback exits 0" [ "$RC" = 0 ]
check "VM files are exactly as before" [ "$(fingerprint)" = "$FP0" ]
check "pm2 restarted once more" [ "$(restarts)" = 6 ]
check "LIVE.json back to the baseline, committed" live_is "$BASE" "$BASE_BUILD"
check "… on top of the release's record" [ "$(git -C "$R" rev-parse HEAD~1)" = "$LIVE_AFTER" ]
check "rollback leaves the DB alone and says so" has s9-rb "The database was NOT restored"

if [ "$WITH_BUILD" = 1 ]; then
  echo; echo "S10 · a REAL release: npm ci + gates + next build, served by a real next start"
  make_vm; reset_repo
  NEXT_PORT=$(node -e 'const s = require("net").createServer().listen(0, () => { console.log(s.address().port); s.close(); })')
  ENVS=("${ENVS[@]/GIQ_FAKE_BUILD=*/GIQ_FAKE_BUILD=}")
  run s10 env FAKE_PM2_REAL_NEXT=1 FAKE_NEXT_PORT="$NEXT_PORT" GIQ_PUBLIC_URL="http://127.0.0.1:$NEXT_PORT/apps/gradeiq" \
    GIQ_HEALTH_TRIES=40 GIQ_LOG_SETTLE=5 GIQ_KEEP_BUILD=1 bash deploy/release.sh
  NEWB=$(vm_build)
  check "real release exits 0" [ "$RC" = 0 ]
  check "npm ci ran in the release worktree" has s10 "npm ci (this release's own node_modules)"
  check "npm test ran as a gate" has s10 "gate: npm test"
  WT10=$(sed -n 's/^\[3\/10\] build [0-9a-f]* in a clean worktree (\(.*\))$/\1/p' "$OUT/s10.out")
  check "… and passed" grep -q "test files passed" "$(dirname "$WT10")/test.log"
  check "check-authz gate skipped with a notice" has s10 "gate skipped: scripts/check-authz.mjs does not exist"
  own_node_modules() { [ -d "$WT10/node_modules/next" ] && [ ! -L "$WT10/node_modules" ]; }
  check "the release worktree has its own node_modules (not a symlink)" own_node_modules
  check "a webpack build (no turbopack chunks)" bash -c "! ls '$APP/.next/server/chunks' | grep -q turbopack"
  check "the real server serves the new BUILD_ID" bash -c "curl -s http://127.0.0.1:$NEXT_PORT/apps/gradeiq | grep -q '$NEWB'"
  check "LIVE.json records it" live_is "$CAND" "$NEWB"
fi

echo; echo "S11 · nothing secret leaked, nothing reached a real VM"
leaks=$(cat "$OUT"/*.out "$OUT/fake-ssh.log" "$OUT/fake-ssh-scripts.log" | grep -cE "$SECRET|$SECRET2" || true)
check "no secret in any output or ssh command line" [ "$leaks" = 0 ]
check "the real ssh was never invoked" [ ! -e "$OUT/REAL-SSH-ATTEMPTS" ]

echo
echo "$PASS passed, $FAILED failed   (outputs: $OUT)"
[ "$FAILED" = 0 ]
