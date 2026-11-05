# GradeIQ handoff — for ChatGPT

Date: 2026-08-05
Repository: `/Users/ammar/projects/gradeiq-live` (GitHub `thesuperiq/gradeiq`).
`/Users/ammar/projects/gradeiq` is an old, diverged copy — do not build, test
or deploy from it.
Supersedes: `docs/CLAUDE-INSPECTION-PLATFORM-HANDOFF.md` for Phases 0–1, which
are now **complete and deployed**. That document's Phases 2–5 still stand.

Read this before touching anything. Most of what follows was learned by
breaking something and fixing it; re-deriving it costs a build failure or a
production incident.

---

## 1. State of play

| | |
|---|---|
| Phase 0 (baseline) | done |
| Phase 1 (capture telemetry repair) | done, **deployed**, verified on prod |
| Phase 2–5 | not started |
| Live URL | `https://swapmore.com/apps/gradeiq` |
| Deployed at | 2026-08-05, `gradeiq-v6` service-worker cache |

The original handoff said "no deployment". The repository owner explicitly
approved deploying Phase 1 afterwards. Do not treat that as standing permission
— ask before each deploy.

### Production data as of this writing

```
sessions              61
grading_runs         108   (4 carry a model string; the column is new)
  sessions graded >1x  33
  of those, DISAGREE   20
capture_telemetry     12   (all pre-Phase-1 shape; migrated in place, not lost)
```

**20 of 33 re-graded sessions produced a different grade.** Do not quote 61% as
a model-determinism figure — those repeats span different code versions, tiers
and sometimes re-taken photos. It is an upper bound and an unanswered question,
not a measurement. Producing the honest version of this number is the
recommended next task (§6).

---

## 2. Non-negotiable rules (carried forward, plus additions)

1. Small additive changes. No framework rewrite.
2. Do not migrate SQLite → PostgreSQL yet. `better-sqlite3` is **synchronous**;
   `pg` is not. This is a sync→async refactor of ~71 call sites in 56 files, not
   a driver swap. The real blocker to horizontal scaling is **media on local
   disk**, not the database.
3. Gemini Pro only for production cosmetic grades. No Flash, no fallback
   provider, no automatic routing.
4. Gemini returns physical evidence. Deterministic GradeIQ code calculates the
   commercial grade. This is already true — `finalGrade()` in
   `lib/visionAgents.ts` is pure rules.
5. An unassessable surface is never a clean surface.
6. Never upload continuous camera frames. Measurements only.
7. **The worktree is intentionally dirty** (55 changed/untracked files). It
   contains substantial user work unrelated to this thread. Do not reset,
   stash, mass-format or "clean up".
8. Ask before deploying. Ask before committing.

---

## 3. Things that will bite you

### The old deploy script lied about success (retired)

`deploy/deploy.sh` printed `Done → https://…` even when its health check
failed, and it targeted the old box. It is retired (SUP-45) and now refuses to
run. Releases go through `deploy/release.sh`, whose health checks and
error-log scan exit non-zero and print the rollback command — see
`deploy/README.md`.

### The service worker serves stale JS

`public/sw.js` has `const CACHE = "gradeiq-v6"`. **Bump it on every deploy that
changes client code**, or returning users keep the old bundle. This cost real
debugging time twice.

### `CREATE TABLE IF NOT EXISTS` is a no-op on an existing table

A `CREATE INDEX` referencing a *new* column, placed in the same `db.exec()` as
the `CREATE TABLE`, will succeed on a fresh database and **fail the module load
— and therefore `npm run build`** — on any database that already has the table.
This broke the Phase 1 build. Indexes on migrated columns must be created
*after* the `ALTER TABLE` loop. See the comment in `lib/captureTelemetry.ts`.

Corollary: **unit tests against a temp DB will not catch this.** Always load the
module against the real dev database before building:

```bash
node --experimental-strip-types --no-warnings \
  --import ./lib/capture/ts-resolve.mjs \
  -e "await import('./lib/captureTelemetry.ts')"
```

### Dev and prod databases have diverged

Dev has 109+ sessions, prod has 61. Migrations must be idempotent and run at
module load — which is the existing pattern in `lib/db.ts`. Never assume a
column exists.

### ESLint is broken

`npm run lint` fails with an `@eslint/eslintrc` circular reference
(`property 'react' closes the circle`). This is a **tooling failure, not a lint
result** — do not report it as clean code, and do not report it as lint errors.
Nobody has been linting this repo. Fixing it is unclaimed work.

### There is no GA Gemini 3.x Pro

Production runs `gemini-3.1-pro-preview`. The only non-preview Pro models the
API key can see are `gemini-2.5-pro` (older generation) and `gemini-pro-latest`
(a floating alias — worse for reproducibility). Downgrading a generation to
satisfy "GA" trades measurable scratch-detection quality for nominal stability.

Mitigation in place: `grading_runs.model` now records the exact model string per
run, so an alias re-point is **detectable**. It is not prevented.

### The response schema is load-bearing, not a nicety

`generationConfig.responseSchema` (from `lib/inspectionSchema.ts`) is currently
the only thing keeping the model's output parseable. With it disabled, a real
6-photo call returned:

```json
[ { "components": { "front": "black", "back": "silver", "display": "black" } } ]
```

— an array, with `components` mapping surfaces to *colours*. `out.components` is
then undefined and the whole pass stubs out. The ~31K consolidated prompt in
`lib/inspectionCatalog.ts` has already lost shape adherence. **This is the
strongest argument for Phase 3's prompt decomposition.**

Also: the API rejects `""` inside an enum (`enum[5]: cannot be empty`). The
schema uses `"UNASSESSED"` and `runVisionPass` maps it back to `""`. Keep the
prompt's JSON template and the schema in agreement — putting prose *inside* a
value slot of that compact template drifts the whole output shape.

There is a kill switch: setting `vision_schema=false` disables it. **Do not
enable that on prod** — grading produces nothing without the schema today.

---

## 4. What Phase 1 actually built

| file | role |
|---|---|
| `lib/capture/frameAnalyzer.ts` | measurement math + DOM sampler. `measurePixels()` is pure and directly tested |
| `lib/capture/captureEvents.ts` | controlled vocabularies, bounds, profile names |
| `lib/capture/useGuidedCapture.ts` | React integration. Measures, records, **decides nothing** |
| `lib/captureTelemetry.ts` | SQLite store + in-place migration from the Release 1 shape |
| `app/api/sessions/[id]/capture-telemetry/route.ts` | validation, idempotency, bounds |
| `lib/capture/*.test.mjs` | 43 assertions |
| `lib/capture/ts-resolve*.mjs` | ESM resolver hook so tests can import production `.ts` |

### Testing without a framework

No Vitest. Node 22 strips types natively:

```bash
npm test                 # every lib/**/*.test.mjs (and scripts/**/*.test.mjs)
npm test -- lib/capture  # just the files under one directory
npm run test:capture     # the original capture + grading subset
```

`scripts/run-tests.mjs` runs each test file in its own Node process with its
own throwaway `cwd`, so `lib/db.ts` (which resolves its file from
`process.cwd()`) creates a fresh database per file and never touches
`data/gradeiq.db`. Everything is resolved relative to the checkout, so a fresh
clone runs its own tests against its own `node_modules`. The
resolver hook exists because production code correctly uses extensionless
relative imports, which bare Node ESM rejects. Do not "fix" the source imports
to satisfy the test runner.

### The two-profile rule — do not collapse this

Telemetry stores **two** version tags, deliberately:

```
measurement_profile: frame-measure-v2     ← the arithmetic
acceptance_profile:  v2cam-legacy-v3      ← the rules that actually accepted the frame
```

They are not the same and **do not currently agree**. `V2Cam.assess()` measures
`GUIDE_W 0.6 × GUIDE_H 0.56` of its own crop; `frameAnalyzer` uses `0.6 × 0.6`
of the raw frame. Different regions → different numbers. There is a test that
asserts the two surfaces still carry different sharpness thresholds
(`cosmetic` 65, `v2cam` 90). **If that test starts passing trivially, someone
merged the profiles — that is a behaviour change, not a refactor.**

Aligning them is Phase 2, and only after telemetry says which threshold is
right.

### Outcomes now recorded

`captured`, `rejected_quality`, `rejected_duplicate`, `rejected_server`,
`replaced`, `abandoned`. Before Phase 1 only `captured` was recorded, so
`attempt` was always 1 and `retakeCount` always 0.

Step identity is the **stable journey step id**, not the display label —
`captureSteps` in the journey config already carry `id`; V2Cam had been dropping
it.

---

## 5. Verified on production

```
migration     12/12 rows preserved, 0 blank event_id, 4 indexes present
enum          invented outcome        → 400
              missing eventId         → 400
idempotency   same eventId replayed   → {ok:false, reason:"duplicate"}, 1 row
size guard    9KB body                → 413
client bundle rejected_duplicate / rejected_server / abandoned / stepId present
```

**Not verified:** the browser camera path on real hardware. Nobody has confirmed
the five outcomes fire in the right order while holding a phone, and the extra
250ms `getImageData` loop has not been measured on a low-end Android. Browser
automation could not get past V2Cam's two-checkbox gate reliably.

Watch for `abandoned` events with near-zero `durationMs` — that would mean a
React remount is firing a false abandonment from the `useEffect` cleanup.

---

## 6. Recommended next work, in order

### a. Real-device capture pass (blocks Phase 2 and Phase 4)

One iPhone session, one low-end Android session, through
`https://swapmore.com/apps/gradeiq`. Phase 2 and 4 thresholds are supposed to
come from this data; right now they are guesses in `deriveInstruction()`.

### b. The grade-agreement report — recommended first build

Design already written: `docs/MULTITENANT-DESIGN.md` §4. Uses data that already
exists (108 grading runs). Must control for tier, `pins` and whether the photo
set changed, or it measures deploy history rather than the model. Report exact
agreement, within-one-band, **signed bias** (positive = systematically generous
= the retailer overpays), and always `n`.

This is the number a design partner asks for first, and it turns the 20-of-33
observation into something defensible.

### c. Phase 3 — evidence-first cosmetic grading

Per the original handoff §Phase 3. The prompt decomposition is the urgent part,
for the reason in §3 above.

### Parked, with reasons

| item | blocked on |
|---|---|
| Phase 2 shared measurement engine | real capture telemetry (6a) |
| Phase 4 AR guidance | thresholds from that telemetry |
| Phase 5 / PostgreSQL | a second app instance; media on local disk is the real blocker |
| orgs / stores / pins | not blocked, but the agreement number is what makes a pilot happen |

---

## 7. Infrastructure you must know about

Both boxes: `ssh -i ~/.ssh/denovo_gcp ammar@<ip>`.

| box | ip | runs |
|---|---|---|
| denovo-erp | `104.197.168.25` | **live GradeIQ**: `~/gradeiq`, pm2 `gradeiq` on :3700 (the box is shared with other apps) |
| swapmore.com | `35.253.69.52` | swapmore :8095, CounterIQ, noviq-close, and the **Caddy** that serves `swapmore.com/apps/gradeiq` by routing `/apps/gradeiq` and `/apps/gradeiq/*` to the live GradeIQ above |

The old GradeIQ copy on `35.253.69.52` (`~/gradeiq`, pm2 `gradeiq`) is
**stopped**. Do not start it and do not deploy to it.

Release only with `deploy/release.sh` (`--plan` first) and undo with
`deploy/rollback.sh <STAMP>`; `deploy/LIVE.json` records what the live VM
serves. The build runs **on your Mac**, in a clean worktree — never build or
`npm install` on a VM: a build on the shared box has already OOM'd and taken
swapmore.com down. Details: `deploy/README.md`.

`~/denovo` on `35.253.69.52` is a **dead copy** of SuperIQ, frozen since the
ERP moved out on 2026-07-23. Do not read it, do not back it up, do not restore
from it.

Nobody has confirmed whether `35.253.69.52` is a reserved static IP. **Do not
stop that VM** until someone does — an ephemeral address change breaks
swapmore.com DNS, and with it the public GradeIQ URL.

### Backups — outstanding, needs the repository owner

`deploy/estate-backup.sh` (in `~/projects/denovo-refurb`) runs nightly on both
boxes in `DRY_RUN=1` mode — snapshot and verify, no upload. A launchd agent
pulls to the owner's Mac daily as an interim off-box copy.

**Still blocked:** the GCS bucket and a write-only (`roles/storage.objectCreator`)
service-account key. Steps are in `denovo-refurb/deploy/BACKUP-SETUP.md`. Until
that key exists at `~/.config/backup-sa.json` on both boxes, the only off-box
copy of the estate lives on a laptop. This is the highest-downside open item and
only the owner can clear it.

---

## 8. First commands

```bash
cd /Users/ammar/projects/gradeiq-live
npm ci                             # this checkout's own node_modules
npm test                           # every unit test file must PASS
npx tsc --noEmit                   # expect clean
npm run build                      # expect success; lint is separately broken
```

Then read, in this order: `lib/capture/frameAnalyzer.ts`,
`lib/capture/captureEvents.ts`, `lib/captureTelemetry.ts`,
`docs/MULTITENANT-DESIGN.md` §4.

Before any schema change, load the module against the **real dev database**
(§3) — the temp-DB tests will not catch migration ordering bugs.
