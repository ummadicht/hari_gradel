# GradeIQ — org / store / pins / agreement

Design for the four items that have to land before a two-store design-partner
pilot is both *runnable* and *measurable*. Written against the repo as it stands
on 2026-08-03 (109 local sessions, 53 prod sessions, 99 prod grading runs).

Everything here stays on the current stack — SQLite, Next.js on the shared GCP
VM. None of it requires the GCP migration; all of it is a prerequisite for it.

---

## 0. The one decision everything else rests on

**`organizations.id` reuses the existing `client_id` strings.**

`client_id` is already a real column on `sessions`, `api_keys`, `purchases`,
`credit_ledger`, `portal_users` and `oidc_sessions`, and the same strings appear
in `?client=` embed URLs and in the pricebook push from swapmore.com. If the new
`organizations` table invents its own primary key, every one of those becomes a
migration with a rewrite step and an external-contract break.

Reusing the strings makes the whole workstream **additive**: no existing row
changes, no URL changes, no change to the swapmore.com push, no change to how
`api_keys` scope. `organizations` becomes a table that describes ids that are
already in use, rather than a new identity for them.

Seed rows are exactly today's `CLIENTS` registry:

```
swapmore     SwapMore US        USD  pricing=swapmore
swapmore-in  SwapMore India     INR  pricing=swapmore
denovo       DeNovo / SuperIQ   USD  pricing=heuristic
inzman       Gadget Rebirth     INR  pricing=swapmore
default      GradeIQ            EUR  pricing=heuristic
```

---

## 1. Organizations and stores

### Schema

```sql
CREATE TABLE IF NOT EXISTS organizations (
  id          TEXT PRIMARY KEY,                    -- == today's client_id
  name        TEXT NOT NULL,
  currency    TEXT NOT NULL DEFAULT 'USD',
  pricing     TEXT NOT NULL DEFAULT 'heuristic',   -- swapmore | heuristic
  status      TEXT NOT NULL DEFAULT 'active',      -- active | suspended
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS stores (
  id              TEXT PRIMARY KEY,                -- st_<slug>
  org_id          TEXT NOT NULL,
  name            TEXT NOT NULL,
  external_ref    TEXT NOT NULL DEFAULT '',        -- the customer's own store number
  timezone        TEXT NOT NULL DEFAULT 'UTC',
  default_journey TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_stores_org ON stores(org_id, status);

CREATE TABLE IF NOT EXISTS store_devices (
  id           TEXT PRIMARY KEY,                   -- dev_<rand>
  org_id       TEXT NOT NULL,
  store_id     TEXT NOT NULL,
  label        TEXT NOT NULL DEFAULT '',
  token_sha256 TEXT NOT NULL,                      -- hash only, same rule as api_keys
  enrolled_by  TEXT NOT NULL DEFAULT '',
  enrolled_at  TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT,
  revoked_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_devices_store ON store_devices(store_id, revoked_at);
```

`store_devices.token_sha256` follows the rule `api_keys` already established:
the plaintext token is shown once at enrollment and never stored.

### The pure / server split (required, not optional)

`lib/clients.ts` is imported by `app/components/v2/SessionResume.tsx`, which is
a `"use client"` component. It cannot start reading SQLite. The split:

| file | role |
|---|---|
| `lib/clients.ts` | stays **pure** — types, `SEED_CLIENTS`, `normalizeClientId()` |
| `lib/orgs.ts` | **server-only** (`import "server-only"`) — DB-backed `resolveOrg()`, `listOrgs()`, `createOrg()`, `listStores()` |

`SessionResume` uses `resolveClient(clientId).id` for one thing: a localStorage
key prefix. It changes to `normalizeClientId(clientId)`, whose semantics also
need a correction — today an unrecognised id folds to `"default"`, which with
dynamic orgs would collide the resume key of every new tenant onto one key. It
should slugify and return as-is, falling back to `"default"` only when empty.
The key needs stability, not membership validation.

### Type widening

`ClientId` is a closed union today. Dynamic orgs require `type ClientId = string`.
That loses compile-time exhaustiveness, so the runtime check has to be real:
`isClientId()` becomes a DB existence lookup (cached in-process, invalidated on
org write). `resolveOrg()` keeps the existing fallback-to-`default` behaviour, so
an unknown id degrades exactly as it does now rather than throwing.

### Code touch list

`lib/clients.ts`, new `lib/orgs.ts`, `lib/portalAuth.ts` (scope check reads DB),
`app/components/v2/SessionResume.tsx`, and the ~14 API routes that import
`clients` — most only need the import path swapped from `resolveClient` to
`resolveOrg`.

---

## 2. `store_id` on sessions

Add to the existing migration array in `lib/db.ts` — the same additive
`ALTER TABLE … ADD COLUMN` pattern already used for 15 columns:

```ts
["store_id", "TEXT NOT NULL DEFAULT ''"],
["pins",     "TEXT NOT NULL DEFAULT '{}'"],
```

`store_id = ''` means **no store**, which is honest for consumer/digital sessions
and for all 53 historical prod rows. It is not backfilled with an invented store.

### Where it gets stamped

| entry point | source of `store_id` |
|---|---|
| `POST /api/journeys/[journey]/start` | the signed-in staff user's `store_id` |
| `POST /api/sessions` | `body.store`, validated against the caller's org; else the store-device cookie |
| retail purchase flow (`lib/purchase.ts`) | the purchase's store |
| consumer embed `/v2?client=…` | `''` |

Staff→store binding: add a nullable `store_id` to `portal_users` rather than a
memberships join table. One user, one store covers a pilot; a `client`-role user
with `store_id` set sees only that store, one with it null keeps today's
org-wide view (that is the regional manager). The join table is the later change,
and it is a pure widening when it comes.

### Store enrollment

1. Org admin creates the store in the console.
2. GradeIQ mints a one-time enrollment token → QR.
3. Counter device opens it; server issues a long-lived, revocable device cookie
   scoped to `(org_id, store_id)`, storing only the hash.
4. A capability probe runs (camera, mic, network) and writes the result to
   `store_devices.last_seen_at`.

The device credential grants exactly one thing: starting sessions for its store.
It cannot read another store's sessions or touch org config.

---

## 3. Version pinning

A session records, at creation, an immutable snapshot of every version that will
decide its grade:

```json
{
  "journey":  "denovo-tradein",
  "catalog":  "catalog:a91f3c2d",
  "prompt":   "prompt:5e0b17aa",
  "grading":  "grade:c4419f01",
  "pricebook":"prices:2026-08-01"
}
```

**Versions are content hashes, not hand-maintained numbers.** `sha256` of the
built prompt string / catalog / grading-policy constants, first 8 hex chars,
computed once at module load. A hand-bumped counter gets forgotten precisely on
the change that mattered; a content hash cannot be wrong.

`grading_runs` gets the same `pins` column. That is what makes the agreement
metric interpretable: without it, a change in agreement after a prompt edit is
indistinguishable from a change in the device mix.

---

## 4. Grade agreement

### There is a number available today, before any pilot

Prod already holds **99 `grading_runs` across 53 sessions**. Where a session has
more than one run, self-consistency is computable with no ground truth at all:
*given the same photos, does GradeIQ return the same letter?* That is the exact
failure this session's work addressed (one IMEI graded A, B, C and D), and it is
the cheapest credible number to put in front of a design partner. It ships first,
as a report over data that already exists.

### Ground truth

```sql
CREATE TABLE IF NOT EXISTS grade_truth (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  org_id     TEXT NOT NULL,
  store_id   TEXT NOT NULL DEFAULT '',
  source     TEXT NOT NULL,               -- warehouse | reinspection | dispute | partner
  cosmetic   TEXT NOT NULL DEFAULT '',
  functional TEXT NOT NULL DEFAULT '',
  note       TEXT NOT NULL DEFAULT '',
  actor      TEXT NOT NULL DEFAULT '',
  pins       TEXT NOT NULL DEFAULT '{}',
  at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_truth_session ON grade_truth(session_id);
CREATE INDEX IF NOT EXISTS idx_truth_org ON grade_truth(org_id, at);
```

Append-only. A corrected truth is a new row, never an update — the same
discipline `session_events` already follows.

Three intake routes, cheapest first:

1. **Superadmin field** on the session detail. Half a day; works day one.
2. **`POST /api/sessions/[id]/truth`**, gated by a new `truth:write` api_key
   scope. This is the one that matters: SuperIQ already *receives* GradeIQ
   pushes at `/api/diagnostics/ingest`, so the reverse channel closes the loop
   with no human effort — the warehouse grade SuperIQ assigns on intake flows
   back automatically.
3. CSV import, for a pilot partner's existing warehouse export.

### The metric

Grades are ordinal (Premium / A / B / C / D), so exact match alone is the wrong
summary. Report four numbers:

- **exact agreement %** — headline
- **within-one-band %** — the operationally useful figure; a B-vs-A dispute is
  cheap, a D-vs-A one loses the deal
- **signed bias** — `mean(gradeIQ_ordinal − truth_ordinal)`. Positive means
  GradeIQ is systematically generous, i.e. the retailer is overpaying; negative
  means harsh, i.e. losing deals. **This converts directly to money and is the
  number a retailer will actually argue about.**
- **n**, always shown — a 100% agreement on 4 devices is not a claim.

Sliced by org, store, model family, `tier` (stub/flash/pro) and `pins.catalog`.

Surfaces: `GET /api/portal/agreement?from&to&store` and `/superadmin/agreement`.

---

## 5. Rollout

Four deploys, each independently revertable, each verified in the compiled
bundle before the next starts.

| phase | contents | risk |
|---|---|---|
| **A — schema** | create the 4 tables, seed orgs from `SEED_CLIENTS`, add `store_id` + `pins` columns. Nothing reads them. | none; additive only |
| **B — writes** | stamp `store_id` and `pins` on new sessions and grading runs | low; old rows read as `''` / `{}` |
| **C — reads** | `lib/orgs.ts` cutover, pure/server split, org + store CRUD in the console, store filter on the session monitor | medium — this is where the `ClientId` widening lands |
| **D — agreement** | self-consistency report (data exists today), then `grade_truth` + intake + the SuperIQ push-back | low; new surface only |

Phase C is the only one that changes behaviour on an existing path, and it is the
one to canary: deploy with `resolveOrg()` reading the DB but falling back to
`SEED_CLIENTS` on a miss, so a seeding failure degrades to today's behaviour
instead of dropping a tenant.

### Backfill

- `org_id` — already present as `client_id`. Nothing to do.
- `store_id` — stays `''` on all 53 historical prod sessions. They had no store;
  inventing one would corrupt the first per-store report.
- `pins` — stays `{}` on historical rows. The agreement report treats unpinned
  runs as a separate bucket rather than silently mixing them with pinned ones.

### Rollback

Every phase is additive, so rollback is redeploying the previous build; unused
tables and columns are inert. The DDL itself is not reverted. Prod DB backed up
before phase A.

---

## 6. Risks

| risk | mitigation |
|---|---|
| `ClientId` union → `string` loses compile-time exhaustiveness | runtime DB existence check in `isClientId()`; `SEED_CLIENTS` retained as the fallback and as the canary path |
| `lib/clients.ts` is imported by a client component | enforced pure/server split before phase C; `import "server-only"` in `lib/orgs.ts` makes a regression a build error |
| dev and prod DBs have diverged (109 vs 53 sessions) | migrations are idempotent and run on boot — the existing pattern, unchanged |
| in-process org cache goes stale across pm2 restarts / multiple workers | cache invalidated on write and TTL'd; org data is small enough that a 30s TTL costs nothing |
| service worker serves stale JS after deploy | bump `CACHE` in `public/sw.js` every deploy (already burned us once this session) |
| agreement metric read as a quality claim on tiny `n` | `n` is rendered next to every percentage; report refuses to show a headline under a floor |

## 7. Sequence

1. **D-first slice** — self-consistency report over the 99 existing
   `grading_runs`. No schema change, produces a real number immediately.
2. **A** — schema + seed.
3. **B** — stamping.
4. **C** — orgs/stores cutover + console + store filter.
5. **D-rest** — `grade_truth`, the `truth:write` scope, the SuperIQ push-back.

Putting the self-consistency slice first means there is a number to show before
any of the structural work lands, and it is measured on data already in prod.
