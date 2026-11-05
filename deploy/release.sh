#!/usr/bin/env bash
# Checked release of GradeIQ to the live VM (ammar@104.197.168.25 ~/gradeiq,
# pm2 "gradeiq" :3700, served at https://swapmore.com/apps/gradeiq).
#
#   bash deploy/release.sh --plan [REF]   read-only: what would ship, and does the VM still match?
#   bash deploy/release.sh [REF]          release REF (default HEAD)
#   bash deploy/release.sh --record STAMP  accept a release that is live but exited non-zero
#   bash deploy/rollback.sh STAMP          undo a release (see deploy/README.md)
#   DRY_RUN=1 is the same as --plan.
#
# The baseline — the commit and BUILD_ID the VM is serving — is deploy/LIVE.json.
# What it does, in order (any failure stops it, and once the VM has been changed
# it prints the exact rollback command):
#   1. diff LIVE.json's commit → REF; refuse env files, data/, and runtime
#      dependency changes (the VM's node_modules are never touched)
#   2. preflight, read-only: the VM's BUILD_ID and every file it will replace are
#      exactly what LIVE.json says was shipped; pm2 is online; no other release is
#      running; there is disk space
#   3. build REF in a clean worktree with its OWN node_modules (npm ci), run the
#      release gates that exist on REF (scripts/check-authz.mjs, npm test), then
#      `next build --webpack` with NEXT_PUBLIC_BASE_PATH=/apps/gradeiq
#   4. back up the SQLite DB on the VM (online backup, integrity-checked)
#   5. upload the build to .next.new and verify it
#   6. back up every source file it replaces or deletes, then ship REF's versions
#      straight from git (never from a working tree) and verify their hashes
#   7. swap .next.new in (the old one stays as .next.bak-STAMP) and pm2 restart —
#      without --update-env, so pm2 keeps the app's environment as it is
#   8. health checks; 9. scan the new pm2 error-log lines; both exit non-zero
#   10. rewrite deploy/LIVE.json and commit it
#
# Never: copies .env*, rsyncs --delete into the app dir, runs npm on the VM,
# touches Caddy/pm2 config/cron, or deletes a backup.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(git -C "$HERE/.." rev-parse --show-toplevel)
# shellcheck source=deploy/release-lib.sh
. "$HERE/release-lib.sh"

usage() { sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; }

PLAN=0
case "${DRY_RUN:-0}" in 1 | true | yes) PLAN=1 ;; esac
REF=HEAD RECORD=""
while [ $# -gt 0 ]; do
  case $1 in
    --plan | --dry-run) PLAN=1 ;;
    --record) RECORD=${2:-}; [ -n "$RECORD" ] || die "--record needs the release stamp"; shift ;;
    -h | --help) usage; exit 0 ;;
    -*) die "unknown option $1 (see --help)" ;;
    *) REF=$1 ;;
  esac
  shift
done

# Test-only hook: GIQ_FAKE_BUILD replaces npm ci + gates + next build with a
# command that writes .next/. It can never be pointed at the real VM.
if [ -n "${GIQ_FAKE_BUILD:-}" ] && { [ "$VM" = "$DEFAULT_VM" ] || [ -z "${GIQ_SSH:-}" ]; }; then
  die "GIQ_FAKE_BUILD is a test hook — it only works with GIQ_SSH and GIQ_VM pointing at a stand-in VM"
fi

[ -f "$LIVE_FILE" ] || die "deploy/LIVE.json is missing — it records what the VM serves"
git -C "$REPO" diff --quiet HEAD -- deploy/LIVE.json 2>/dev/null \
  || die "deploy/LIVE.json has uncommitted changes — commit or restore it first"
BASE_COMMIT=$(live_get commit)
BASE_BUILD=$(live_get build_id)
[ -n "$BASE_COMMIT" ] && [ -n "$BASE_BUILD" ] || die "deploy/LIVE.json has no commit/build_id"
git -C "$REPO" cat-file -e "$BASE_COMMIT^{commit}" 2>/dev/null \
  || die "the live commit $BASE_COMMIT is not in this clone — git fetch"

# ── --record: accept a release that is live and healthy but exited non-zero ──
if [ -n "$RECORD" ]; then
  [[ "$RECORD" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]+$ ]] || die "not a release stamp: $RECORD"
  manifest=$(remote "STAMP=$RECORD" <<'EOF'
cat "$REL/$STAMP/manifest.txt" 2>/dev/null || true
EOF
)
  m() { printf '%s\n' "$manifest" | sed -n "s/^$1=\([A-Za-z0-9._:-]*\)$/\1/p" | tail -1; }
  [ -n "$(m NEW_BUILD)" ] || die "no release $RECORD on the VM"
  [ "$(m BASE_COMMIT)" = "$BASE_COMMIT" ] && [ "$(m BASE_BUILD)" = "$BASE_BUILD" ] \
    || die "release $RECORD was not made from the baseline in deploy/LIVE.json"
  step 1/2 "health of release $RECORD"
  health "$(m NEW_BUILD)" "$(m PRE_RESTARTS)" || die "not healthy — roll back instead: bash deploy/rollback.sh $RECORD"
  [ "$PLAN" = 1 ] && { say "(plan) would record $(m NEW_COMMIT) / $(m NEW_BUILD) in deploy/LIVE.json"; exit 0; }
  step 2/2 "record it in deploy/LIVE.json"
  live_write "$(m NEW_COMMIT)" "$(m NEW_BUILD)" "$RECORD"
  live_commit "Record GradeIQ release $RECORD as live: $(m NEW_COMMIT | cut -c1-7), build $(m NEW_BUILD)"
  exit 0
fi

REL_COMMIT=$(git -C "$REPO" rev-parse --verify "$REF^{commit}" 2>/dev/null) || die "unknown commit: $REF"
REL_SHORT=$(git -C "$REPO" rev-parse --short "$REL_COMMIT")
BASE_SHORT=$(git -C "$REPO" rev-parse --short "$BASE_COMMIT")
STAMP=$(date -u +%Y%m%dT%H%M%SZ)-$REL_SHORT

say "GradeIQ release: $BASE_SHORT (live, build $BASE_BUILD) → $REL_SHORT  [$VM:$APP_DIR]"
[ "$PLAN" = 1 ] && say "PLAN ONLY — nothing on the VM or in git will change"

if [ "$REL_COMMIT" = "$BASE_COMMIT" ]; then say "Nothing to release: $REL_SHORT is already live."; exit 0; fi
# deploy/LIVE.json is bookkeeping for this script, never shipped: a commit that
# only records a release has nothing to release.
if [ -z "$(git -C "$REPO" diff --name-only "$BASE_COMMIT" "$REL_COMMIT" -- . ':(exclude)deploy/LIVE.json')" ]; then
  say "Nothing to release: $REL_SHORT differs from the live $BASE_SHORT only in deploy/LIVE.json."; exit 0
fi
if ! git -C "$REPO" merge-base --is-ancestor "$BASE_COMMIT" "$REL_COMMIT" && [ "${GIQ_ALLOW_NON_DESCENDANT:-}" != 1 ]; then
  die "$REL_SHORT does not contain the live commit $BASE_SHORT — releasing it would drop live work. Merge first (or GIQ_ALLOW_NON_DESCENDANT=1 if that is really intended)"
fi
if [ -z "$(git -C "$REPO" branch -r --contains "$REL_COMMIT" 2>/dev/null)" ] && [ "${GIQ_ALLOW_UNPUSHED:-}" != 1 ]; then
  die "$REL_SHORT is not on any remote branch — push it first, so what runs live can always be recovered from GitHub"
fi
if [ "$PLAN" != 1 ] && ! git -C "$REPO" symbolic-ref -q HEAD >/dev/null; then
  die "this checkout is on a detached HEAD — check out a branch (deploy/LIVE.json is committed to it after the release)"
fi

# ── 1. what changes ──────────────────────────────────────────────────────────
step 1/10 "diff $BASE_SHORT..$REL_SHORT"
SHIP=() DEL=() ADDED=() SKIPPED=()
while IFS=$'\t' read -r st path; do
  [ -n "$path" ] && [ "$path" != deploy/LIVE.json ] || continue
  [[ "$path" =~ ^[][A-Za-z0-9._/@()+,=-]+$ ]] || die "unexpected characters in a changed path: $path"
  case "${path##*/}" in .env*) SKIPPED+=("$path"); continue ;; esac
  case "$path" in data/*) die "$path is under data/ — runtime data lives only on the VM, never in a release" ;; esac
  case "$st" in
    A | M | T) SHIP+=("$path"); git -C "$REPO" cat-file -e "$BASE_COMMIT:$path" 2>/dev/null || ADDED+=("$path") ;;
    D) DEL+=("$path") ;;
    *) die "unexpected change type $st for $path" ;;
  esac
done < <(git -C "$REPO" diff --name-status --no-renames "$BASE_COMMIT" "$REL_COMMIT")
say "    ${#SHIP[@]} to ship (${#ADDED[@]} new), ${#DEL[@]} to delete"
[ ${#SHIP[@]} -gt 0 ] && printf '      + %s\n' "${SHIP[@]}"
[ ${#DEL[@]} -gt 0 ] && printf '      - %s\n' "${DEL[@]}"
[ ${#SKIPPED[@]} -gt 0 ] && printf '      (not shipped — env files never are) %s\n' "${SKIPPED[@]}"

runtime_deps() { # COMMIT → sorted name@version of every non-dev package in the lockfile
  git -C "$REPO" show "$1:package-lock.json" 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      const pk = s ? JSON.parse(s).packages || {} : {};
      console.log(Object.entries(pk).filter(([k, v]) => k && !v.dev).map(([k, v]) => k + "@" + v.version).sort().join("\n"));
    });'
}
dep_diff=$(diff <(runtime_deps "$BASE_COMMIT") <(runtime_deps "$REL_COMMIT") | grep '^[<>]' || true)
if [ -n "$dep_diff" ]; then
  printf '%s\n' "$dep_diff" | head -20 | sed 's/^/      /'
  [ "${GIQ_ALLOW_DEP_CHANGE:-}" = 1 ] \
    || die "runtime dependencies changed. This script never runs npm on the VM, so the VM's node_modules would not match the build. Update them on the VM as its own reviewed step first, then re-run with GIQ_ALLOW_DEP_CHANGE=1"
  say "    GIQ_ALLOW_DEP_CHANGE=1 — continuing; the VM's node_modules must already match"
fi

# ── 2. preflight (read-only) ─────────────────────────────────────────────────
step 2/10 "preflight on $VM (read-only): the VM must be exactly what LIVE.json says"
CHECK=("${SHIP[@]+"${SHIP[@]}"}" "${DEL[@]+"${DEL[@]}"}")
pre=$(remote "FILES=$(printf '%s\n' "${CHECK[@]+"${CHECK[@]}"}")" <<'EOF'
[ -d "$APP" ] || { echo "noapp"; exit 0; }
echo "build $(cat "$APP/.next/BUILD_ID" 2>/dev/null || echo absent)"
echo "pm2 $(pm2_state)"
if [ -e "$REL/.lock" ]; then echo "lock $(cat "$REL/.lock/owner" 2>/dev/null || echo unknown-owner)"; else echo "lock none"; fi
echo "db $([ -f "$APP/data/gradeiq.db" ] && echo present || echo absent)"
echo "next_new $([ -e "$APP/.next.new" ] && echo present || echo absent)"
avail=$(df -Pk "$APP" | awk 'NR==2 {print $4}')
next_kb=$(du -sk "$APP/.next" 2>/dev/null | cut -f1)
db_kb=$(du -sk "$APP/data/gradeiq.db" 2>/dev/null | cut -f1)
echo "space ${avail:-0} ${next_kb:-0} ${db_kb:-0}"
while IFS= read -r f; do
  [ -n "$f" ] || continue
  echo "file $(hash_of "$APP/$f") $f"
done <<< "$FILES"
EOF
) || die "could not reach $VM"
[ "$pre" != noapp ] || die "no app dir $APP_DIR on $VM"
field() { printf '%s\n' "$pre" | sed -n "s/^$1 //p" | head -1; }
FAIL=()
live_build=$(field build)
read -r pm2_status PRE_RESTARTS ERRLOG <<< "$(field pm2)"
lock=$(field lock)
read -r avail_kb next_kb db_kb <<< "$(field space)"
need_kb=$((next_kb * 2 + db_kb * 2 + 300 * 1024))
say "    BUILD_ID $live_build (LIVE.json: $BASE_BUILD) · pm2 $pm2_status · lock $lock · db $(field db)"
say "    disk: $((avail_kb / 1024)) MB free, needs ~$((need_kb / 1024)) MB (a second .next + DB backup)"
[ "$live_build" = "$BASE_BUILD" ] || FAIL+=("the VM serves build $live_build but deploy/LIVE.json says $BASE_BUILD — someone deployed outside release.sh, or this checkout's LIVE.json is stale (git pull)")
[ "$pm2_status" = online ] || FAIL+=("pm2 app $PM2_NAME is $pm2_status, not online")
[ "$lock" = none ] || FAIL+=("another release holds the lock ($lock). If it is dead, check the VM, then remove $REL_DIR/.lock")
[ "$(field db)" = present ] || FAIL+=("no data/gradeiq.db in $APP_DIR — refusing to release without a DB to back up")
[ "$avail_kb" -ge "$need_kb" ] || FAIL+=("not enough disk on the VM")
[ "$(field next_new)" = absent ] || say "    note: a leftover .next.new from an interrupted release will be replaced"
mismatch=0
while read -r kind remote_hash path; do
  [ "$kind" = file ] || continue
  base_hash=$(git_hash "$BASE_COMMIT" "$path")
  if [ "$remote_hash" != "$base_hash" ]; then
    mismatch=$((mismatch + 1))
    if [ "$base_hash" = absent ]; then
      FAIL+=("$path is new in $REL_SHORT but already exists on the VM")
    else
      FAIL+=("$path on the VM is not the $BASE_SHORT version (VM ${remote_hash:0:12}, git ${base_hash:0:12}) — compare: ${SSH[*]} $VM 'cat $APP_DIR/$path' | diff <(git show $BASE_SHORT:$path) -")
    fi
  fi
done <<< "$pre"
say "    ${#CHECK[@]} files checked against $BASE_SHORT, $mismatch differ"
if [ ${#FAIL[@]} -gt 0 ]; then
  printf '    PREFLIGHT FAILED:\n'; printf '      - %s\n' "${FAIL[@]}"
  die "preflight failed — nothing was changed"
fi
say "    preflight ok"

has_test=$(git -C "$REPO" show "$REL_COMMIT:package.json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).scripts?.test ? "yes" : "no"))')
has_authz=no; git -C "$REPO" cat-file -e "$REL_COMMIT:scripts/check-authz.mjs" 2>/dev/null && has_authz=yes

if [ "$PLAN" = 1 ]; then
  cat <<PLAN

PLAN — what \`bash deploy/release.sh $REF\` would do now:
   3. clean worktree of $REL_SHORT, npm ci there, gates: scripts/check-authz.mjs [$has_authz] · npm test [$has_test],
      then NEXT_PUBLIC_BASE_PATH=$BASE_PATH next build --webpack
   4. back up $APP_DIR/data/gradeiq.db → $REL_DIR/$STAMP/gradeiq.db (lock $REL_DIR/.lock while it runs)
   5. upload the build → $APP_DIR/.next.new, check its BUILD_ID and file count
   6. back up the ${#CHECK[@]} files above → $REL_DIR/$STAMP/src/, then ship ${#SHIP[@]} and delete ${#DEL[@]}
   7. mv .next .next.bak-$STAMP && mv .next.new .next && pm2 restart $PM2_NAME
   8. health: $PUBLIC_URL serves the new build · /api/sessions/does-not-exist 404 · anonymous /api/imei 401 · pm2 online
   9. no new errors in the pm2 error log
  10. deploy/LIVE.json → $REL_SHORT + the new BUILD_ID, committed
  If 8 or 9 fail: bash deploy/rollback.sh $STAMP
PLAN
  exit 0
fi

# ── 3. build + gates in a clean worktree ─────────────────────────────────────
RUN_PARENT=${GIQ_RUN_DIR:-${TMPDIR:-/tmp}}
RUN_DIR=$(mktemp -d "${RUN_PARENT%/}/gradeiq-release-$REL_SHORT.XXXXXX")
WT="$RUN_DIR/wt"
LOCKED=0 TOUCHED=0
cleanup() {
  local rc=$?
  if [ "$LOCKED" = 1 ]; then
    remote "STAMP=$STAMP" <<'EOF' || echo "WARNING: could not release the lock $REL_DIR/.lock on the VM — remove it by hand" >&2
[ "$(cat "$REL/.lock/owner" 2>/dev/null)" = "$STAMP" ] && rm -f "$REL/.lock/owner" && rmdir "$REL/.lock"
true
EOF
  fi
  if [ -d "$WT" ] && [ "${GIQ_KEEP_BUILD:-}" != 1 ]; then git -C "$REPO" worktree remove --force "$WT" >/dev/null 2>&1 || true; fi
  if [ $rc -ne 0 ] && [ "$TOUCHED" = 1 ]; then
    printf '\nThe VM was changed by release %s. To put it back exactly as it was:\n    bash deploy/rollback.sh %s\n' "$STAMP" "$STAMP" >&2
    printf 'If it is in fact healthy and you want to keep it: bash deploy/release.sh --record %s\n' "$STAMP" >&2
  fi
  [ $rc -ne 0 ] && printf 'Logs: %s\n' "$RUN_DIR" >&2
  exit $rc
}
trap cleanup EXIT

step 3/10 "build $REL_SHORT in a clean worktree ($WT)"
git -C "$REPO" worktree add -q --detach "$WT" "$REL_COMMIT"
if [ -n "${GIQ_FAKE_BUILD:-}" ]; then
  say "    TEST HOOK GIQ_FAKE_BUILD — skipping npm ci, gates and next build"
  (cd "$WT" && bash -c "$GIQ_FAKE_BUILD") > "$RUN_DIR/build.log" 2>&1 || die "fake build failed — $RUN_DIR/build.log"
else
  say "    npm ci (this release's own node_modules)"
  (cd "$WT" && npm ci --no-audit --no-fund) > "$RUN_DIR/npm-ci.log" 2>&1 || die "npm ci failed — $RUN_DIR/npm-ci.log"
  if [ "$has_authz" = yes ]; then
    say "    gate: node scripts/check-authz.mjs"
    (cd "$WT" && node scripts/check-authz.mjs) > "$RUN_DIR/check-authz.log" 2>&1 || die "check-authz failed — $RUN_DIR/check-authz.log"
  else
    say "    gate skipped: scripts/check-authz.mjs does not exist on $REL_SHORT"
  fi
  if [ "$has_test" = yes ]; then
    say "    gate: npm test"
    (cd "$WT" && npm test) > "$RUN_DIR/test.log" 2>&1 || die "npm test failed — $RUN_DIR/test.log"
    tail -1 "$RUN_DIR/test.log" | sed 's/^/      /'
  else
    say "    gate skipped: no \"test\" script on $REL_SHORT"
  fi
  # A fresh checkout has no data/gradeiq.db, and `next build` collects page data
  # in parallel workers that all open it at once: they race on the WAL switch and
  # the build dies with SQLITE_BUSY. Create the build's own throwaway DB once,
  # single-process, first. It never leaves this worktree.
  if [ -f "$WT/lib/db.ts" ] && [ -f "$WT/lib/capture/ts-resolve.mjs" ]; then
    (cd "$WT" && node --experimental-strip-types --no-warnings --import ./lib/capture/ts-resolve.mjs \
      --input-type=module -e 'await import("./lib/db.ts")') > "$RUN_DIR/db-init.log" 2>&1 \
      || die "could not create the build's DB — $RUN_DIR/db-init.log"
  fi
  say "    next build --webpack (NEXT_PUBLIC_BASE_PATH=$BASE_PATH)"
  (cd "$WT" && NEXT_PUBLIC_BASE_PATH=$BASE_PATH NODE_OPTIONS=--max-old-space-size=4096 npm run build) \
    > "$RUN_DIR/build.log" 2>&1 || die "build failed — $RUN_DIR/build.log"
fi
[ -f "$WT/.next/BUILD_ID" ] || die "the build left no .next/BUILD_ID"
if [ -d "$WT/.next/server/chunks" ] && ls "$WT/.next/server/chunks" | grep -q turbopack; then
  die "turbopack chunks in the build — they break better-sqlite3 on the VM"
fi
NEW_BUILD=$(cat "$WT/.next/BUILD_ID")
[[ "$NEW_BUILD" =~ ^[A-Za-z0-9_-]+$ ]] || die "odd BUILD_ID: $NEW_BUILD"
[ "$NEW_BUILD" != "$BASE_BUILD" ] || die "the new build has the live BUILD_ID $NEW_BUILD"
NEXT_FILES=$(cd "$WT/.next" && find . -type f ! -path './cache/*' ! -path './dev/*' | wc -l | tr -d ' ')
dirty=$(git -C "$WT" status --porcelain --untracked-files=no)
[ -z "$dirty" ] || say "    note: the build changed tracked files in its worktree (not shipped — sources come from git):"$'\n'"$dirty"
say "    built $NEW_BUILD ($NEXT_FILES files)"

# ── 4. lock + DB backup ──────────────────────────────────────────────────────
step 4/10 "lock, write the release manifest, back up the DB → $REL_DIR/$STAMP/"
SHIPPED_HASHES=$(for f in "${SHIP[@]+"${SHIP[@]}"}"; do printf '%s %s\n' "$(git_hash "$REL_COMMIT" "$f")" "$f"; done)
lock_out=$(remote "STAMP=$STAMP" "BASE_COMMIT=$BASE_COMMIT" "BASE_BUILD=$BASE_BUILD" "NEW_COMMIT=$REL_COMMIT" \
  "NEW_BUILD=$NEW_BUILD" "PRE_RESTARTS=$PRE_RESTARTS" \
  "SHIP_LIST=$(printf '%s\n' "${SHIP[@]+"${SHIP[@]}"}")" "DEL_LIST=$(printf '%s\n' "${DEL[@]+"${DEL[@]}"}")" \
  "ADDED_LIST=$(printf '%s\n' "${ADDED[@]+"${ADDED[@]}"}")" "SHIPPED_HASHES=$SHIPPED_HASHES" <<'EOF'
mkdir -p "$REL"
mkdir "$REL/.lock" 2>/dev/null || { echo "locked $(cat "$REL/.lock/owner" 2>/dev/null)"; exit 0; }
echo "$STAMP" > "$REL/.lock/owner"
echo locked-by-us
B="$REL/$STAMP"
mkdir "$B"
cat > "$B/manifest.txt" <<MANIFEST
STAMP=$STAMP
BASE_COMMIT=$BASE_COMMIT
BASE_BUILD=$BASE_BUILD
NEW_COMMIT=$NEW_COMMIT
NEW_BUILD=$NEW_BUILD
PRE_RESTARTS=$PRE_RESTARTS
PM2_NAME=$PM2_NAME
MANIFEST
printf '%s\n' "$SHIP_LIST" | sed '/^$/d' > "$B/shipped.txt"
printf '%s\n' "$DEL_LIST" | sed '/^$/d' > "$B/deleted.txt"
printf '%s\n' "$ADDED_LIST" | sed '/^$/d' > "$B/added.txt"
printf '%s\n' "$SHIPPED_HASHES" | sed '/^$/d' > "$B/shipped.sha256"
echo locked > "$B/phase"
cd "$APP"
node -e '
  const D = require("./node_modules/better-sqlite3");
  new D("data/gradeiq.db", { readonly: true }).backup(process.argv[1]).then(() => {
    const r = new D(process.argv[1], { readonly: true }).pragma("integrity_check", { simple: true });
    if (r !== "ok") { console.error("backup integrity_check: " + r); process.exit(1); }
    console.log("db-backup-ok");
  }, e => { console.error(String(e)); process.exit(1); });' "$B/gradeiq.db" < /dev/null
echo db-backed-up > "$B/phase"
EOF
) || { [[ "$lock_out" == *locked-by-us* ]] && LOCKED=1; die "could not lock / back up the DB on the VM: $lock_out"; }
case "$lock_out" in
  *locked-by-us*) LOCKED=1 ;;
  locked*) die "another release holds the lock: ${lock_out#locked }" ;;
esac
[[ "$lock_out" == *db-backup-ok* ]] || die "DB backup did not confirm: $lock_out"
say "    DB backed up and integrity-checked: $REL_DIR/$STAMP/gradeiq.db"

# ── 5. upload the build ──────────────────────────────────────────────────────
step 5/10 "upload the build → $APP_DIR/.next.new"
remote <<'EOF'
rm -rf "$APP/.next.new"
EOF
rsync -az --exclude=/cache --exclude=/dev -e "$RSH" "$WT/.next/" "$VM:$APP_DIR/.next.new/"
up=$(remote <<'EOF'
echo "$(cat "$APP/.next.new/BUILD_ID" 2>/dev/null || echo absent) $(cd "$APP/.next.new" && find . -type f | wc -l | tr -d ' ')"
EOF
)
[ "$up" = "$NEW_BUILD $NEXT_FILES" ] || die "upload incomplete: VM has '$up', expected '$NEW_BUILD $NEXT_FILES'"
say "    uploaded and verified ($NEXT_FILES files)"

# ── 6. back up + ship sources ────────────────────────────────────────────────
step 6/10 "back up the files being replaced, then ship $REL_SHORT's versions"
TOUCHED=1
remote "STAMP=$STAMP" <<'EOF'
B="$REL/$STAMP"
mkdir -p "$B/src"
cd "$APP"
while IFS= read -r f; do
  [ -n "$f" ] && [ -e "$f" ] || continue
  mkdir -p "$B/src/$(dirname "$f")"
  cp -p "$f" "$B/src/$f"
done < <(cat "$B/shipped.txt" "$B/deleted.txt")
# Deleted in git: move out of the app dir (the copy above is the backup).
while IFS= read -r f; do
  [ -n "$f" ] && [ -e "$f" ] || continue
  rm -f "$f"
done < "$B/deleted.txt"
echo sources-backed-up > "$B/phase"
EOF
if [ ${#SHIP[@]} -gt 0 ]; then
  git -C "$REPO" --literal-pathspecs archive --format=tar "$REL_COMMIT" -- "${SHIP[@]}" | "${SSH[@]}" "$VM" "cd $(app_word) && tar -xf -"
fi
got=$(remote "STAMP=$STAMP" <<'EOF'
cd "$APP"; n=0; bad=0
while read -r want f; do
  [ -n "$f" ] || continue
  n=$((n + 1)); [ "$(hash_of "$f")" = "$want" ] || { bad=$((bad + 1)); echo "differs: $f" >&2; }
done < "$REL/$STAMP/shipped.sha256"
while IFS= read -r f; do [ -z "$f" ] || [ ! -e "$f" ] || { bad=$((bad + 1)); echo "still present: $f" >&2; }; done < "$REL/$STAMP/deleted.txt"
echo sources-shipped > "$REL/$STAMP/phase"
echo "$n $bad"
EOF
)
[ "${got#* }" = 0 ] || die "shipped sources do not match $REL_SHORT ($got)"
say "    ${#SHIP[@]} shipped, ${#DEL[@]} removed, all verified; previous versions in $REL_DIR/$STAMP/src/"

# ── 7. swap + restart ────────────────────────────────────────────────────────
step 7/10 "swap the build in and restart pm2 $PM2_NAME"
ERR_OFFSET=$(remote "ERRLOG=$ERRLOG" <<'EOF'
size_of "$ERRLOG"
EOF
)
remote "STAMP=$STAMP" <<'EOF'
cd "$APP"
if [ ! -d .next.new ] || [ -e ".next.bak-$STAMP" ]; then echo "no .next.new, or .next.bak-$STAMP already exists" >&2; exit 1; fi
mv .next ".next.bak-$STAMP"
mv .next.new .next
echo swapped > "$REL/$STAMP/phase"
pm2 restart "$PM2_NAME" < /dev/null > /dev/null
EOF
say "    swapped (previous build kept as $APP_DIR/.next.bak-$STAMP) and restarted"

# ── 8. health ────────────────────────────────────────────────────────────────
step 8/10 "health"
health "$NEW_BUILD" "$PRE_RESTARTS" || die "release $STAMP is UNHEALTHY"

# ── 9. error log ─────────────────────────────────────────────────────────────
step 9/10 "pm2 error log since the restart (after ${LOG_SETTLE}s)"
sleep "$LOG_SETTLE"
scan_log "$ERRLOG" "$ERR_OFFSET" || die "release $STAMP logged errors after the restart"

# ── 10. record ───────────────────────────────────────────────────────────────
step 10/10 "record $REL_SHORT / $NEW_BUILD in deploy/LIVE.json"
remote "STAMP=$STAMP" <<'EOF'
echo healthy > "$REL/$STAMP/phase"
EOF
live_write "$REL_COMMIT" "$NEW_BUILD" "$STAMP"
live_commit "Record GradeIQ release $STAMP as live: $REL_SHORT, build $NEW_BUILD"
TOUCHED=0
cat <<DONE

RELEASED GradeIQ $REL_SHORT (build $NEW_BUILD) — $PUBLIC_URL
  previous build:  $APP_DIR/.next.bak-$STAMP
  previous files:  $REL_DIR/$STAMP/src/
  DB backup:       $REL_DIR/$STAMP/gradeiq.db
  undo:            bash deploy/rollback.sh $STAMP
DONE
