#!/usr/bin/env bash
# RETIRED (SUP-45). This used to rsync the whole working tree with --delete to
# the OLD box (35.253.69.52), npm install on the VM, merge .env.local, rewrite
# Caddy, and print "Done" even when its health check failed. Live GradeIQ runs
# on ammar@104.197.168.25 (~/gradeiq, pm2 gradeiq :3700), and it is released
# only with deploy/release.sh — see deploy/README.md.
echo "deploy/deploy.sh is retired and does nothing." >&2
echo "Release GradeIQ with:  bash deploy/release.sh --plan   then   bash deploy/release.sh" >&2
echo "Undo a release with:   bash deploy/rollback.sh <STAMP>   (see deploy/README.md)" >&2
exit 1
