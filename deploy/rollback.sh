#!/usr/bin/env bash
# Undo a GradeIQ release made by deploy/release.sh, using the backups it kept.
#
#   bash deploy/rollback.sh --plan STAMP   read-only: check the VM and say what would happen
#   bash deploy/rollback.sh STAMP          roll release STAMP back
#   DRY_RUN=1 is the same as --plan. STAMP is printed by release.sh
#   (e.g. 20261021T140000Z-1a2b3c4); `ls ~/gradeiq-releases` on the VM lists them.
#
# What it does:
#   1. reads the release's manifest on the VM and checks the VM is still exactly
#      what that release left (its build, or the old build if it never got as far
#      as the swap, and every file it shipped) — so it cannot undo someone else's
#      later change
#   2. puts back every source file it replaced or deleted, and moves the files it
#      added out of the app dir (into the release's backup dir)
#   3. swaps the previous build back in (.next.bak-STAMP → .next; the release's
#      build is kept as .next.undone-STAMP) and pm2 restart, without --update-env
#   4. health checks + error-log scan (exit non-zero on failure)
#   5. rewrites deploy/LIVE.json to the release's baseline and commits it
# It does NOT restore the database: data written since the release would be lost.
# The release's DB backup path is printed for a deliberate, manual restore.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(git -C "$HERE/.." rev-parse --show-toplevel)
# shellcheck source=deploy/release-lib.sh
. "$HERE/release-lib.sh"

PLAN=0
case "${DRY_RUN:-0}" in 1 | true | yes) PLAN=1 ;; esac
STAMP=""
while [ $# -gt 0 ]; do
  case $1 in
    --plan | --dry-run) PLAN=1 ;;
    -h | --help) sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option $1" ;;
    *) STAMP=$1 ;;
  esac
  shift
done
[ -n "$STAMP" ] || die "which release? bash deploy/rollback.sh STAMP"
[[ "$STAMP" =~ ^[0-9]{8}T[0-9]{6}Z-[0-9a-f]+$ ]] || die "not a release stamp: $STAMP"

say "GradeIQ rollback of release $STAMP  [$VM:$APP_DIR]"
[ "$PLAN" = 1 ] && say "PLAN ONLY — nothing on the VM or in git will change"

# ── 1. preflight ─────────────────────────────────────────────────────────────
step 1/5 "preflight (read-only)"
pre=$(remote "STAMP=$STAMP" <<'EOF'
B="$REL/$STAMP"
[ -f "$B/manifest.txt" ] || { echo "nomanifest"; exit 0; }
sed -n 's/^\([A-Z_]*=[A-Za-z0-9._:-]*\)$/m \1/p' "$B/manifest.txt"
echo "phase $(cat "$B/phase" 2>/dev/null || echo unknown)"
echo "undone $([ -e "$B/ROLLED_BACK" ] && echo yes || echo no)"
echo "build $(cat "$APP/.next/BUILD_ID" 2>/dev/null || echo absent)"
echo "bak $(cat "$APP/.next.bak-$STAMP/BUILD_ID" 2>/dev/null || echo absent)"
echo "next_new $(cat "$APP/.next.new/BUILD_ID" 2>/dev/null || echo absent)"
if [ -e "$REL/.lock" ]; then echo "lock $(cat "$REL/.lock/owner" 2>/dev/null || echo unknown-owner)"; else echo "lock none"; fi
echo "pm2 $(pm2_state)"
echo "srcbak $([ -d "$B/src" ] && echo yes || echo no)"
cd "$APP"
bad=0 n=0
while read -r want f; do
  [ -n "$f" ] || continue
  n=$((n + 1))
  # (Only enforced once the release got to "sources-shipped": before that a
  # file may legitimately still be the old version.)
  [ "$(hash_of "$f")" = "$want" ] || { bad=$((bad + 1)); echo "changed $f"; }
done < "$B/shipped.sha256"
echo "shipped $n $bad"
EOF
) || die "could not reach $VM"
[ "$pre" != nomanifest ] || die "no release $STAMP on the VM ($REL_DIR/$STAMP/manifest.txt)"
field() { printf '%s\n' "$pre" | sed -n "s/^$1 //p" | head -1; }
m() { printf '%s\n' "$pre" | sed -n "s/^m $1=//p" | head -1; }
BASE_COMMIT=$(m BASE_COMMIT) BASE_BUILD=$(m BASE_BUILD) NEW_COMMIT=$(m NEW_COMMIT) NEW_BUILD=$(m NEW_BUILD)
[ -n "$BASE_BUILD" ] && [ -n "$NEW_BUILD" ] && [ -n "$BASE_COMMIT" ] || die "the manifest of $STAMP is incomplete"
phase=$(field phase) live_build=$(field build) bak_build=$(field bak)
read -r pm2_status PRE_RESTARTS ERRLOG <<< "$(field pm2)"
read -r n_shipped n_changed <<< "$(field shipped)"
say "    release $STAMP: ${BASE_COMMIT:0:7}/$BASE_BUILD → ${NEW_COMMIT:0:7}/$NEW_BUILD, got as far as: $phase"
say "    VM now serves $live_build · kept previous build $bak_build · pm2 $pm2_status · lock $(field lock)"
FAIL=()
[ "$(field undone)" = no ] || FAIL+=("release $STAMP was already rolled back")
[ "$(field lock)" = none ] || FAIL+=("a release holds the lock ($(field lock)). If it is dead, check the VM, then remove $REL_DIR/.lock")
SWAPPED=no
if [ "$bak_build" != absent ]; then
  SWAPPED=yes
  [ "$bak_build" = "$BASE_BUILD" ] || FAIL+=(".next.bak-$STAMP holds build $bak_build, not the release's baseline $BASE_BUILD")
  [ "$live_build" = "$NEW_BUILD" ] || FAIL+=("the VM serves $live_build, not $NEW_BUILD from release $STAMP — a later release? Roll that back first")
else
  [ "$live_build" = "$BASE_BUILD" ] || FAIL+=("release $STAMP never swapped its build in, but the VM serves $live_build, not the baseline $BASE_BUILD")
fi
case "$phase" in
  sources-shipped | swapped | healthy)
    [ "${n_changed:-1}" = 0 ] || FAIL+=("$n_changed of the $n_shipped files release $STAMP shipped have changed on the VM since: $(printf '%s\n' "$pre" | sed -n 's/^changed //p' | tr '\n' ' ')") ;;
  sources-backed-up) say "    the release stopped while shipping sources — every file is put back from the backup" ;;
  *) [ "$(field srcbak)" = no ] || FAIL+=("unexpected phase $phase with a source backup") ;;
esac
if [ ${#FAIL[@]} -gt 0 ]; then
  printf '    PREFLIGHT FAILED:\n'; printf '      - %s\n' "${FAIL[@]}"
  die "nothing was changed"
fi
say "    preflight ok"

if [ "$PLAN" = 1 ]; then
  cat <<PLAN

PLAN — what \`bash deploy/rollback.sh $STAMP\` would do now:
  2. put back the files it replaced/deleted from $REL_DIR/$STAMP/src/, move the files it added out of $APP_DIR
  3. $( [ $SWAPPED = yes ] && echo "mv .next .next.undone-$STAMP && mv .next.bak-$STAMP .next && pm2 restart $PM2_NAME" || echo "build was never swapped in: only move the unused .next.new aside (no restart)")
  4. health: $PUBLIC_URL serves $BASE_BUILD, API 404, anonymous IMEI 401, pm2 online; no new log errors
  5. deploy/LIVE.json → ${BASE_COMMIT:0:7} / $BASE_BUILD, committed
  The DB is NOT restored; its pre-release backup is $REL_DIR/$STAMP/gradeiq.db
PLAN
  exit 0
fi

LOCKED=0
cleanup() {
  local rc=$?
  if [ "$LOCKED" = 1 ]; then
    remote "STAMP=rollback-$STAMP" <<'EOF' || echo "WARNING: could not release the lock $REL_DIR/.lock — remove it by hand" >&2
[ "$(cat "$REL/.lock/owner" 2>/dev/null)" = "$STAMP" ] && rm -f "$REL/.lock/owner" && rmdir "$REL/.lock"
true
EOF
  fi
  exit $rc
}
trap cleanup EXIT

# ── 2. sources ───────────────────────────────────────────────────────────────
step 2/5 "put the release's source files back"
ERR_OFFSET=$(remote "ERRLOG=$ERRLOG" <<'EOF'
size_of "$ERRLOG"
EOF
)
out=$(remote "STAMP=$STAMP" <<'EOF'
mkdir -p "$REL"
mkdir "$REL/.lock" 2>/dev/null || { echo "lock-busy"; exit 1; }
echo "rollback-$STAMP" > "$REL/.lock/owner"
echo locked-by-us
B="$REL/$STAMP"
cd "$APP"
restored=0 removed=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  if [ -f "$B/src/$f" ]; then
    mkdir -p "$(dirname "$f")"; cp -p "$B/src/$f" "$f"; restored=$((restored + 1))
  elif grep -qxF -- "$f" "$B/added.txt" && [ -e "$f" ]; then
    mkdir -p "$B/undone-added/$(dirname "$f")"; mv "$f" "$B/undone-added/$f"; removed=$((removed + 1))
  fi
done < <(cat "$B/shipped.txt" "$B/deleted.txt")
echo "sources $restored $removed"
while IFS= read -r f; do [ -z "$f" ] || echo "file $(hash_of "$f") $f"; done < <(cat "$B/shipped.txt" "$B/deleted.txt")
EOF
) || { [[ "$out" == *locked-by-us* ]] && LOCKED=1; die "could not restore sources: $out"; }
LOCKED=1
say "    $(printf '%s\n' "$out" | sed -n 's/^sources \([0-9]*\) \([0-9]*\)$/\1 restored from the backup, \2 added files moved to the backup dir/p')"
if git -C "$REPO" cat-file -e "$BASE_COMMIT^{commit}" 2>/dev/null; then
  odd=0
  while read -r kind h f; do
    [ "$kind" = file ] || continue
    [ "$h" = "$(git_hash "$BASE_COMMIT" "$f")" ] || { odd=$((odd + 1)); say "    WARNING: $f is not the ${BASE_COMMIT:0:7} version after restoring it"; }
  done <<< "$out"
  if [ "$odd" = 0 ]; then say "    every restored file matches ${BASE_COMMIT:0:7}"; fi
fi

# ── 3. build ─────────────────────────────────────────────────────────────────
if [ "$SWAPPED" = yes ]; then
  step 3/5 "swap the previous build back in and restart pm2 $PM2_NAME"
  remote "STAMP=$STAMP" <<'EOF'
cd "$APP"
if [ ! -d ".next.bak-$STAMP" ] || [ -e ".next.undone-$STAMP" ]; then echo "no .next.bak-$STAMP, or .next.undone-$STAMP exists" >&2; exit 1; fi
mv .next ".next.undone-$STAMP"
mv ".next.bak-$STAMP" .next
pm2 restart "$PM2_NAME" < /dev/null > /dev/null
EOF
  say "    swapped back (the release's build is kept as $APP_DIR/.next.undone-$STAMP) and restarted"
else
  step 3/5 "the build was never swapped in — moving the unused upload aside"
  remote "STAMP=$STAMP" <<'EOF'
cd "$APP"
if [ -d .next.new ]; then mv .next.new ".next.undone-$STAMP"; fi
EOF
fi

# ── 4. health ────────────────────────────────────────────────────────────────
step 4/5 "health"
remote "STAMP=$STAMP" <<'EOF'
date -u +%Y-%m-%dT%H:%M:%SZ > "$REL/$STAMP/ROLLED_BACK"
EOF
health "$BASE_BUILD" "$PRE_RESTARTS" || die "still UNHEALTHY after the rollback — look at the VM now (pm2 logs $PM2_NAME)"
if [ "$SWAPPED" = yes ]; then
  sleep "$LOG_SETTLE"
  scan_log "$ERRLOG" "$ERR_OFFSET" || die "errors logged after the rollback restart"
fi

# ── 5. record ────────────────────────────────────────────────────────────────
step 5/5 "deploy/LIVE.json → ${BASE_COMMIT:0:7} / $BASE_BUILD"
if [ -f "$LIVE_FILE" ] && [ "$(live_get build_id)" = "$BASE_BUILD" ] && [ "$(live_get commit)" = "$BASE_COMMIT" ]; then
  say "    deploy/LIVE.json already says so"
else
  git -C "$REPO" cat-file -e "$BASE_COMMIT^{commit}" 2>/dev/null || say "    note: ${BASE_COMMIT:0:7} is not in this clone (git fetch)"
  live_write "$BASE_COMMIT" "$BASE_BUILD" "rollback-of-$STAMP"
  live_commit "Record rollback of GradeIQ release $STAMP: ${BASE_COMMIT:0:7}, build $BASE_BUILD is live again"
fi
cat <<DONE

ROLLED BACK release $STAMP — ${BASE_COMMIT:0:7} (build $BASE_BUILD) is live again.
  The database was NOT restored. If the release damaged data, its pre-release
  backup is $REL_DIR/$STAMP/gradeiq.db — restoring it discards everything
  written since $STAMP, so decide that deliberately (pm2 stop first).
DONE
