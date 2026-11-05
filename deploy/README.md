# Releasing GradeIQ → swapmore.com/apps/gradeiq

## Where it runs

| what | where |
|---|---|
| **Live GradeIQ** | VM `104.197.168.25` (denovo-erp), `~/gradeiq`, pm2 **`gradeiq`** on **:3700** |
| Public URL | `https://swapmore.com/apps/gradeiq` — Caddy on `35.253.69.52` (the swapmore.com box) routes `/apps/gradeiq` and `/apps/gradeiq/*` to the live process |
| Old copy | `35.253.69.52:~/gradeiq` — **stopped**. Do not start it, do not deploy to it |
| Release baseline | `deploy/LIVE.json` — the commit and `BUILD_ID` the live VM serves |
| Release backups | `104.197.168.25:~/gradeiq-releases/<STAMP>/` (manifest, replaced sources, DB copy) and `~/gradeiq/.next.bak-<STAMP>` (previous build) |

ssh: `ssh -i ~/.ssh/denovo_gcp ammar@104.197.168.25`.

GradeIQ is served as a **subpath**: it is built with
`NEXT_PUBLIC_BASE_PATH=/apps/gradeiq`, so Next's `basePath` puts every page and
asset under `/apps/gradeiq`. Non-Link URLs (fetch, `<a href>`, QR, `<img src>`)
are prefixed by `lib/basePath.ts` → `withBase()`.

## Release

```bash
git checkout main && git pull            # LIVE.json must be current
bash deploy/release.sh --plan            # read-only: what ships, does the VM still match?
bash deploy/release.sh                   # release HEAD (or: bash deploy/release.sh <commit>)
git push                                 # release.sh commits deploy/LIVE.json; push it
```

`--plan` (or `DRY_RUN=1`) changes nothing anywhere. It prints the files that
would ship, runs the read-only preflight against the VM, and lists the gates
and steps. It exits non-zero if the real release would abort at preflight.

What `release.sh` does, and stops on:

1. **Diff** `LIVE.json`'s commit → the release commit. Refuses a commit that
   does not contain the live one, one that is not pushed, anything under
   `data/`, and a change to runtime dependencies (`package-lock.json`): it never
   runs npm on the VM, so the VM's `node_modules` would not match. `.env*` files
   are never shipped, even if committed. `deploy/LIVE.json` is never shipped.
2. **Preflight, read-only:** the VM's `.next/BUILD_ID` is `LIVE.json`'s, and
   every file it is about to replace or delete is byte-for-byte the live
   commit's version (new files must not exist yet). pm2 is online, no other
   release holds `~/gradeiq-releases/.lock`, there is disk for a second `.next`
   and a DB copy. A mismatch means someone changed the VM outside this script:
   it stops and prints a `diff` command for each file.
3. **Build** the release commit in a clean worktree with its **own**
   `node_modules` (`npm ci`), then the release gates that exist on that commit:
   `node scripts/check-authz.mjs` and `npm test` (skipped with a notice when
   absent), then `next build --webpack` with the base path. Refuses a build with
   Turbopack chunks (they break better-sqlite3 on the VM).
4. **Back up the DB** on the VM (`better-sqlite3` online backup of
   `data/gradeiq.db`, integrity-checked) into the release's backup dir.
5. **Upload** `.next` (without `cache/` and `dev/`) to `~/gradeiq/.next.new`
   and check its `BUILD_ID` and file count.
6. **Back up** every source file it replaces or deletes, then ship the release
   commit's versions straight from git (`git archive`, never from a working
   tree) and check every hash.
7. **Swap**: `.next` → `.next.bak-<STAMP>`, `.next.new` → `.next`, then
   `pm2 restart gradeiq` — *without* `--update-env`, so the app keeps its
   environment exactly as it is.
8. **Health**, exit non-zero on failure: the home page answers 200 and carries
   the **new BUILD_ID** (so the running process really is the new build), an
   unknown session is 404, an anonymous IMEI lookup is **401** (the auth gate
   holds), the BUILD_ID on disk is the new one, pm2 is online and not
   crash-looping.
9. **Error log**: the lines pm2 wrote to the error log since the restart must
   not contain errors. Exit non-zero otherwise.
10. **Record**: rewrite `deploy/LIVE.json` (commit + BUILD_ID + stamp) and
    commit only that file.

When anything fails after the VM was touched it prints the two ways out:

```bash
bash deploy/rollback.sh <STAMP>          # put the VM back exactly as it was
bash deploy/release.sh --record <STAMP>  # it is fine after all: keep it, record it in LIVE.json
```

It never: copies `.env*`, runs `rsync --delete` on the app dir, runs npm on the
VM, edits Caddy, pm2's process list, cron or env, or deletes a backup.

### Rollback

```bash
bash deploy/rollback.sh --plan <STAMP>   # read-only check
bash deploy/rollback.sh <STAMP>
git push
```

It checks the VM is still exactly what that release left (its build, every file
it shipped — so it cannot undo someone's later change), restores every replaced
or deleted file from the backup, moves the files the release added into the
backup dir, swaps `.next.bak-<STAMP>` back in (the release's build is kept as
`.next.undone-<STAMP>`), restarts pm2, runs the same health and log checks, and
commits `deploy/LIVE.json` back to the previous baseline. A release that never
reached the swap is undone without a restart.

It does **not** restore the database — that would discard everything written
since the release. The pre-release copy is
`~/gradeiq-releases/<STAMP>/gradeiq.db`; restoring it is a deliberate, manual
step (`pm2 stop gradeiq` first).

### Housekeeping

Backups are never deleted by the scripts. When disk gets tight, remove old
`~/gradeiq/.next.bak-*`, `~/gradeiq/.next.undone-*` and
`~/gradeiq-releases/<STAMP>/` by hand — keep at least the last release's.

### Dependency changes

`release.sh` refuses a release whose runtime dependencies differ from the live
commit's. Updating `node_modules` on the VM is its own reviewed step; do it
first, then re-run with `GIQ_ALLOW_DEP_CHANGE=1`.

### Knobs

`GIQ_VM` (`ammar@104.197.168.25`), `GIQ_SSH_KEY` (`~/.ssh/denovo_gcp`),
`GIQ_APP_DIR` (`gradeiq`), `GIQ_RELEASES_DIR` (`gradeiq-releases`),
`GIQ_PM2_NAME` (`gradeiq`), `GIQ_PUBLIC_URL`
(`https://swapmore.com/apps/gradeiq`), `GIQ_HEALTH_TRIES`/`GIQ_HEALTH_WAIT`
(20 × 3 s), `GIQ_LOG_SETTLE` (10 s), `GIQ_KEEP_BUILD=1` (keep the build
worktree), `GIQ_ALLOW_UNPUSHED=1`, `GIQ_ALLOW_NON_DESCENDANT=1`,
`GIQ_ALLOW_DEP_CHANGE=1`.

### Testing the scripts

```bash
bash scripts/release-test/run.sh               # ~1 min, fake build
bash scripts/release-test/run.sh --with-build  # + a real npm ci / gates / next build release
```

Runs both scripts against a stand-in VM on your Mac: `GIQ_SSH` points at a
local ssh stand-in that runs commands in a fake home, pm2 is
`scripts/release-test/fake-pm2.sh`, Caddy + the app is
`scripts/release-test/stub-app.mjs` (or a real `next start` with
`--with-build`), and the real `ssh` is shadowed by a stub that fails. It proves
plan mode changes nothing, every preflight mismatch aborts with the VM
untouched, a failed health check or a logged error exits non-zero with the
rollback command, rollback restores the app dir byte-for-byte, env files never
ship and no secret reaches the output. The test-only `GIQ_FAKE_BUILD` hook is
refused unless `GIQ_SSH` and `GIQ_VM` point at a stand-in.

## Env and keys

Releases never read, copy or merge env files. The VM's `~/gradeiq/.env.local`
is set on the VM only: `deploy/set-keycloak-env.sh` and
`deploy/set-auth-mode.sh` (see `docs/KEYCLOAK-CUTOVER.md`).
`NEXT_PUBLIC_BASE_PATH=/apps/gradeiq` must stay in it: `next start` reads the
base path again at runtime.

`GRADEIQ_SERVER_KEY` — the key SwapUp sends as `x-gradeiq-server-key` to call
`GET /api/imei/{imei}` and `POST /api/imei/ocr` server-to-server. Unset = that
header is ignored and only staff sessions (plus GradeIQ's own seller pages, for
OCR) get in.

Machine-to-machine without Keycloak (`KEYCLOAK_ISSUER` unset — lib/m2m.ts):
`PRICEBOOK_SYNC_SECRET` must equal SwapMore's own `PRICEBOOK_SYNC_SECRET` (it
sends it as `x-sync-secret` to `POST /api/clients/{id}/pricebook`; unset here =
503), and `SUPERIQ_TOKEN` must equal SuperIQ's Phonecheck webhook secret (the
Bearer its legacy `/api/diagnostics/ingest` accepts; unset = "Push to SuperIQ"
answers 503 "not configured"). Once `KEYCLOAK_ISSUER` is set, both are ignored
and the callers must be on Keycloak tokens at the same restart.

`GRADEIQ_RETAIL_KEY` — the key CounterIQ sends as `x-gradeiq-retail-key` on
`POST /api/sessions`. Its creates get the paid IMEI lookup with no daily limit.
Every CounterIQ desk reaches GradeIQ from ONE address (its VM, through Caddy),
so without the key the per-IP limit below switches the blacklist check off for
all of a deployment's desks after `GRADEIQ_ANON_LOOKUP_CAP` phones a day. It
buys lookups and nothing else (not `/api/imei`, not clearing a recorded fault),
so it is a separate key from `GRADEIQ_SERVER_KEY`. Set the same value as
`GRADEIQ_RETAIL_KEY` in each CounterIQ deployment's env. Unset = the header is
ignored.

`GRADEIQ_ANON_LOOKUP_CAP` (default 20) — paid IMEI lookups (Phonecheck) one IP
may trigger per UTC day without a key or a sign-in, and only from a known
channel: a client's embed (`?client=swapmore`) or a retail desk that sends no
key (`channel: "retail"`). `GRADEIQ_ANON_LOOKUP_TOTAL_CAP` (default 200) is the
same allowance for ALL such callers together, so many addresses (a proxy pool, a
block of IPv6 addresses) cannot run the bill up either; reaching it writes one
`[lookups] … reached the daily total` line to the server log and shows "daily
total reached" in the console. Past either, or from anywhere else, a session is
still created but with the free TAC answer and an unverified identity
(lib/lookupBudget.ts). The IP is the first `X-Forwarded-For` entry, so keep
:3700 behind Caddy. Staff see the day's count in the console under
Integrations.

`deploy/merge-env.awk` belonged to the retired `deploy/deploy.sh`; no release
path uses it.

## Retired: deploy/deploy.sh

It rsynced the whole working tree with `--delete` to the old `35.253.69.52`
box, ran `npm install` there, merged `.env.local`, rewrote Caddy, and printed
"Done" even when its health check failed. It now refuses to run.

## SwapMore app integration

`swapmore/src/routes/sell.tsx` + `grading.tsx` link to `/apps/gradeiq/trade-in`
(same-origin).

## Local dev

`NEXT_PUBLIC_BASE_PATH` is unset locally → GradeIQ serves at root
(`localhost:3700`), `withBase()` is a no-op. Only the release build sets it.
