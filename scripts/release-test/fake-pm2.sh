#!/usr/bin/env bash
# Stand-in for pm2 on the stand-in VM (scripts/release-test/run.sh). Knows one
# app. State lives in $FAKE_VM_STATE; every call is logged to calls.log.
#   jlist             what deploy/release-lib.sh reads (status, restarts, error log)
#   restart NAME …    bumps the restart count and "serves" the BUILD_ID now in
#                     the app dir. Test knobs, read from the caller's env:
#                       FAKE_APP_AFTER_RESTART=down   the app stops answering
#                       FAKE_PM2_ERR_ON_RESTART=text  written to the error log
#                       FAKE_PM2_REAL_NEXT=1          really run `next start` on $FAKE_NEXT_PORT
set -euo pipefail
S=${FAKE_VM_STATE:?}
APP=${FAKE_VM_APP:?}
printf '%s\n' "$*" >> "$S/calls.log"
case "${1:-}" in
  jlist)
    # A real jlist carries the app's whole environment — secrets included. The
    # release scripts must only ever print status / restarts / log path.
    printf '[{"name":"gradeiq","pm2_env":{"status":"%s","restart_time":%s,"pm_err_log_path":"%s","GRADEIQ_SERVER_KEY":"%s"}}]\n' \
      "$(cat "$S/status")" "$(cat "$S/restarts")" "$S/gradeiq-error.log" "${FAKE_SECRET:-}"
    ;;
  restart)
    [ "${2:-}" = gradeiq ] || { echo "[PM2][ERROR] Process or Namespace ${2:-} not found" >&2; exit 1; }
    echo $(($(cat "$S/restarts") + 1)) > "$S/restarts"
    echo online > "$S/status"
    echo "${FAKE_APP_AFTER_RESTART:-up}" > "$S/mode"
    cat "$APP/.next/BUILD_ID" > "$S/serving"
    if [ -n "${FAKE_PM2_ERR_ON_RESTART:-}" ]; then printf '%s\n' "$FAKE_PM2_ERR_ON_RESTART" >> "$S/gradeiq-error.log"; fi
    if [ "${FAKE_PM2_REAL_NEXT:-}" = 1 ]; then
      if [ -f "$S/next.pid" ]; then kill "$(cat "$S/next.pid")" 2>/dev/null || true; sleep 1; fi
      (cd "$APP" && nohup node node_modules/next/dist/bin/next start -p "${FAKE_NEXT_PORT:?}" \
        >> "$S/gradeiq-out.log" 2>> "$S/gradeiq-error.log" < /dev/null & echo $! > "$S/next.pid")
    fi
    echo "[PM2] [gradeiq](0) ✓"
    ;;
  *) echo "fake pm2: unsupported: $*" >&2; exit 2 ;;
esac
