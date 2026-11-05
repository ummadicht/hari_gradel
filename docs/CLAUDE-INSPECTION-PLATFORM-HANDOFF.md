# GradeIQ inspection-platform handoff for Claude

Date: 2026-08-05  
Repository: `/Users/ammar/projects/gradeiq`

## Mission

Evolve the existing GradeIQ application into an evidence-driven retail and
warehouse inspection platform without rewriting the working product.

The immediate objective is not a native app installed on every tested phone.
The immediate product remains:

```text
Retail Desk / GradeIQ PWA
  + store-controlled AR cosmetic capture
  + temporary browser functional tests on the phone under test
  + Gemini Pro cosmetic interpretation
  + deterministic GradeIQ grading and pricing
```

Later, warehouse customers may add a retailer-controlled USB Station Agent for
deeper diagnostics. A managed native agent is only for organization-owned
fleets. Neither is a dependency for the current retail release.

## Non-negotiable execution rules

1. Start by reading this document and inspecting the working tree. Do not assume
   `HEAD` represents the current product.
2. The worktree is intentionally dirty and contains substantial user work.
   Preserve it. Do not reset, discard, mass-format, or overwrite unrelated
   changes.
3. Use small additive changes. Do not perform a framework rewrite.
4. Keep existing routes working while adding cleaner internal boundaries.
5. Do not migrate SQLite to PostgreSQL during the first implementation phase.
6. Do not introduce a mandatory App Store install, MDM enrollment, or factory
   reset into the retail journey.
7. Gemini Pro is the only production cosmetic vision model. Do not let Flash or
   a fallback provider decide a production grade.
8. Gemini returns physical evidence; deterministic GradeIQ code calculates the
   commercial grade.
9. An unassessable surface is never equivalent to a clean surface.
10. A finalized result must not be silently changed by a background pass.
11. Do not deploy until the requested phase is tested and explicitly approved.
12. Never upload continuous camera frames for telemetry. Upload selected evidence
    images and bounded numeric capture measurements only.

## Product decision

GradeIQ is an inspection operating system, not an application that must live on
every asset being inspected.

### Supported modes

| Mode | Tested-phone installation | Purpose |
|---|---:|---|
| Retail Express | None | Identity, external cosmetics, offer |
| Retail Standard | Temporary browser session | Web-supported functional tests |
| Warehouse Deep | None; optional USB connection | Deeper diagnostics and erasure |
| Managed Fleet | Optional managed native agent | Organization-owned recurring fleet |

The first two modes already exist in substantial form in this repository and
are the implementation priority.

## Current system: read before changing

The repository currently uses:

- Next.js 16 and React 19.
- `better-sqlite3` with a shared synchronous connection.
- Local filesystem uploads under `data/uploads`.
- Next.js route handlers for sessions, capture and grading.
- PM2/`next start` on a shared GCP VM.
- A browser-native functional-test journey.
- Two-device QR handoff and cosmetic capture.
- Direct generative vision provider calls.
- Append-only `session_events` and `grading_runs`.

Important current files:

| File | Current responsibility |
|---|---|
| `app/components/V2Cam.tsx` | Advanced two-device cosmetic/display/settings capture |
| `app/components/CosmeticCapture.tsx` | Earlier cosmetic capture flow |
| `app/api/sessions/[id]/cosmetic/route.ts` | Gate, infer, persist, regrade/refine |
| `lib/captureGate.ts` | Pure capture-set validation math |
| `lib/captureGateServer.ts` | Authoritative server capture validation |
| `lib/capture/frameAnalyzer.ts` | New observation-mode frame measurements |
| `lib/capture/useGuidedCapture.ts` | New capture telemetry hook |
| `lib/captureTelemetry.ts` | New SQLite telemetry store |
| `app/api/sessions/[id]/capture-telemetry/route.ts` | New telemetry endpoint |
| `lib/visionProvider.ts` | Provider/model selection and direct API calls |
| `lib/visionAgents.ts` | Vision pass, specialists, composite grade, reconciliation |
| `lib/inspectionCatalog.ts` | Large consolidated cosmetic prompt/catalog |
| `lib/inspectionSchema.ts` | Emerging inspection response schema |
| `lib/gradingRuns.ts` | Append-only grading-run history |
| `lib/db.ts` | SQLite initialization, migrations and session access |
| `scripts/grade-consistency.ts` | Repeatability harness over stored sessions |
| `docs/MULTITENANT-DESIGN.md` | Existing org/store/version/agreement design |

### Current strengths to preserve

- Guided angle capture.
- Client and server quality gates.
- Screen-off front capture.
- Torch/raking-light twin capture where supported.
- Display-pattern sweep.
- Functional browser tests.
- QR handoff.
- Append-only event/run history.
- Pro-only switch.
- Capture-at-end option.
- Existing reports, offers, passports and tenant journeys.

### Current architectural weaknesses

1. The cosmetic route owns too many stages.
2. Images are local to one VM.
3. SQLite prevents horizontal application scaling.
4. Vision findings and commercial grading remain too coupled.
5. A very large prompt asks the model to perform multiple responsibilities.
6. Capture implementations and thresholds have diverged.
7. Capture telemetry is incomplete and not yet safe enough for calibration.
8. The current plain-node capture tests execute a copied measurement function
   instead of the production TypeScript implementation.

## Target flow

```text
Create inspection
  -> identify device
  -> select inspection mode
  -> collect required surface evidence
  -> deterministic quality gate
  -> one Gemini Pro structured inspection
  -> focused Pro verification only for grade-changing ambiguity
  -> normalize confirmed findings
  -> deterministic tenant grading policy
  -> immutable grade, offer and evidence report
```

Normal latency objective after upload:

- deterministic preparation: 0.5-2 seconds;
- one Gemini Pro call: measure in production, initially budget 5-15 seconds;
- validation, grading and persistence: under 1 second;
- typical total: 8-18 seconds;
- focused verification: additional 5-15 seconds only when required.

Do not create per-tile model calls on the normal path. Prepare crops/contact
sheets deterministically and use a single Pro request for the ordinary case.

## Immediate implementation plan

Complete these phases in order. Stop after each phase, show the diff and test
results, and wait for approval before broadening scope.

---

## Phase 0: establish a safe baseline

### Tasks

1. Inspect `git status`, relevant diffs and existing untracked files.
2. Run:

   ```bash
   npm run test:capture
   npx tsc --noEmit
   npm run build
   ```

3. Record whether lint is blocked by the existing ESLint circular-configuration
   error. Do not misreport that tooling failure as a source-code lint result.
4. Do not edit unrelated functional-test, authentication, pricing or identity
   changes already present in the worktree.

### Acceptance

- Current build behavior is documented.
- No existing changes are destroyed.
- The exact files intended for Phase 1 are listed before edits.

---

## Phase 1: repair Release 1 capture telemetry

The current observation-mode implementation is a useful foundation, but its
data cannot yet support threshold selection.

### Known defects to correct

#### 1. Dynamic capture-step attribution

`V2Cam` currently gives `useGuidedCapture` a label from the static `ANGLES`
fallback. Tenant-specific `angles` can differ.

Use a stable step identifier from the active journey configuration. If capture
steps do not yet have stable IDs, add a backward-compatible generated ID and
store both ID and display label.

Expected telemetry fields:

```ts
{
  stepId: string;
  stepLabel: string;
  surface: string;
  photoIndex: number;
}
```

#### 2. Attempts, retakes and abandonment

`recordCapture()` currently runs only after an accepted frame. This means
`attempt` is normally 1, `retakeCount` normally 0, and abandoned steps are not
recorded.

Record bounded events for:

- quality-rejected shutter;
- duplicate-view rejection;
- accepted frame;
- operator skip/exit;
- replacement of an already captured angle;
- server capture-gate retake.

Do not insert a row every 250 ms. Continuous sampling remains in memory; only
meaningful capture-attempt events are sent.

Recommended controlled outcomes:

```ts
type CaptureOutcome =
  | "captured"
  | "rejected_quality"
  | "rejected_duplicate"
  | "rejected_server"
  | "replaced"
  | "abandoned";
```

#### 3. Endpoint abuse and idempotency

The telemetry route is unauthenticated and inserts without a bound. Add:

- client-generated `eventId` UUID;
- unique constraint on `event_id`;
- controlled enum validation;
- request-size guard where supported;
- maximum event count per session/step;
- rate limiting consistent with the current deployment;
- structured logging/metric on rejected or failed writes.

Do not block a valid photograph if telemetry fails.

If full store-device authentication is not available yet, use a short-lived
signed capture token or at minimum enforce session state, origin expectations,
idempotency and strict per-session bounds. Document the remaining risk.

#### 4. Actual versus experimental verdict

The current analyzer thresholds do not exactly reproduce the current V2Cam
acceptance thresholds. Preserve both facts:

```json
{
  "measurements": {},
  "actualVerdict": {
    "accepted": true,
    "reason": ""
  },
  "experimentalInstruction": "REDUCE_GLARE",
  "measurementProfile": "frame-measure-v2",
  "acceptanceProfile": "v2cam-legacy-v3"
}
```

Do not claim there is one acceptance policy until both capture surfaces really
use the same code and profile.

#### 5. Test the production implementation

Replace the manually transliterated `measurePixels` test with Vitest or another
TypeScript-aware test that imports the actual function from
`lib/capture/frameAnalyzer.ts`.

Tests must cover:

- exposure;
- contrast;
- sharpness;
- glare coverage and centroid;
- stability;
- invalid/small dimensions;
- attempt event normalization;
- telemetry idempotency;
- per-session event bound;
- dynamic step IDs;
- storage failure logging without blocking capture.

### Phase 1 acceptance

- Production `measurePixels()` is directly tested.
- Custom journey steps are correctly attributed.
- Failed and abandoned attempts are measurable.
- Duplicate requests do not duplicate telemetry.
- A known session ID cannot grow telemetry without a strict bound.
- Capture still works if telemetry storage is unavailable.
- `npm run test:capture`, TypeScript and production build pass.
- Behavior remains observation-only unless explicitly approved otherwise.

---

## Phase 2: one shared capture measurement engine

Do this only after Phase 1 data integrity is fixed.

### Tasks

1. Move measurement math into pure modules without a top-level `"use client"`.
2. Use one DOM adapter to sample `HTMLVideoElement` frames.
3. Replace the duplicated measurement math in `V2Cam` and
   `CosmeticCapture`, while keeping their existing acceptance profiles as data.
4. Keep the authoritative server gate separate, but align metric definitions and
   version names where client/server measurements are comparable.
5. Ensure the sampled region matches the visible guide rectangle exactly.
6. Measure at a conservative interval on low-end devices and record sampling
   cost where practical.

Suggested structure:

```text
lib/capture/
  frameMath.ts             # pure, directly tested
  videoFrameSampler.ts     # browser/canvas adapter
  captureProfiles.ts       # versioned thresholds
  guidanceEngine.ts        # observation first, enforcement later
  captureEvents.ts         # controlled event contracts
  useGuidedCapture.ts      # React integration
```

### Acceptance

- `V2Cam` and `CosmeticCapture` no longer carry independent Laplacian/exposure
  implementations.
- Existing acceptance behavior is preserved by named versioned profiles.
- There is still no mandatory AR enforcement.
- Performance is manually checked on a current iPhone and a lower-end Android.

---

## Phase 3: evidence-first cosmetic grading

### Core rule

Gemini Pro identifies structured physical evidence. It does not calculate the
retail grade or offer.

### Canonical physical finding

```ts
type Surface =
  | "DISPLAY"
  | "BACK"
  | "FRAME_LEFT"
  | "FRAME_RIGHT"
  | "FRAME_TOP"
  | "FRAME_BOTTOM"
  | "CAMERA_GLASS"
  | "CAMERA_HOUSING";

type AssessmentStatus =
  | "CLEAR"
  | "DEFECT_CONFIRMED"
  | "UNASSESSABLE"
  | "VERIFICATION_REQUIRED";

type ConfirmedFinding = {
  id: string;
  surface: Surface;
  zone: string;
  defectType: "SCRATCH" | "CRACK" | "SCUFF" | "CHIP" | "DENT" | "DISCOLORATION";
  severity: "MICRO" | "LIGHT" | "MODERATE" | "SEVERE";
  extent: "LOCALIZED" | "MULTIPLE" | "WIDESPREAD";
  box?: [number, number, number, number];
  evidenceAssetIds: string[];
  verification: "CONFIRMED" | "CONTESTED";
};
```

### Tasks

1. Define a strict provider-enforced JSON response schema.
2. Split the large consolidated responsibility:
   - deterministic capture quality before Gemini;
   - one Pro physical-condition inspection;
   - optional focused Pro verification;
   - deterministic completeness and policy evaluation afterward.
3. Do not silently salvage schema-invalid JSON into a clean result.
4. Do not run a second complete inspection merely because the first grade is D.
   Verify only the disputed finding/crop and compare physical evidence.
5. Enforce required-zone completeness. Missing/unassessable zones block Grade A
   and trigger a targeted retake or review.
6. Persist the exact input asset hashes, prompt hash, schema hash, model ID,
   returned model version, response hash and policy version.

### Gemini Pro configuration

- Use a currently supported pinned GA Pro model on Vertex AI when that migration
  is implemented.
- No preview or `latest` alias in production.
- No automatic routing.
- No alternate-model fallback for a production grade.
- Temperature zero and fixed seed are best-effort consistency controls, not a
  determinism guarantee.

### Deterministic grading

Add a pure policy evaluator. The same confirmed findings and policy version must
always produce the same grade.

```ts
type GradeDecision = {
  grade: "Premium" | "A" | "B" | "C" | "D";
  policyVersion: string;
  triggeredRules: string[];
  findingIds: string[];
};
```

Existing pricing code should consume `GradeDecision`, not free-form Gemini
prose.

### Acceptance

- Gemini response contains no authoritative commercial grade.
- One Pro call handles the ordinary path.
- Second Pro call is focused and selective.
- Invalid/unassessable evidence cannot become clean.
- Deterministic policy tests cover every grade boundary.
- Existing reports continue working through a compatibility adapter.

---

## Phase 4: AR guidance rollout

Only enforce guidance after observation data has established thresholds.

### Release sequence

1. Observation only.
2. Display guidance without changing acceptance.
3. Manual capture with recommended best-frame highlighting.
4. Automatic best-frame selection for approved stores.
5. Enforced targeted retakes for proven high-risk failures.

### Guidance features

- silhouette/guide alignment;
- phone size in the guide;
- focus/sharpness;
- exposure;
- glare coverage and affected region;
- motion/stability;
- raking-light progress for scratch-sensitive surfaces;
- targeted instructions with one primary action at a time.

Do not make WebXR a dependency. Use progressive camera/canvas guidance; WebXR
may be an optional enhancement when available.

### Required capture UX

```text
Prepare: remove case, wipe surface
  -> Display: normal + opposing raking-light views
  -> Back: material-appropriate views
  -> Frame: left/right/top/bottom
  -> Cameras: overview + macro when required
  -> Analyze once
  -> Retake only the failed surface
```

Do not show a provisional grade that can later change.

---

## Phase 5: durable GCP migration

Do not begin until the inspection domain and tests are stable locally.

Target:

```text
Next.js/Cloud Run
  -> Cloud Storage for originals and derived evidence
  -> Cloud Tasks for durable inspection jobs
  -> Cloud Run evidence/inference workers
  -> Gemini Pro on Vertex AI
  -> Cloud SQL PostgreSQL
  -> Pub/Sub for finalized-inspection events
  -> BigQuery for quality/agreement analytics
```

### Important PostgreSQL constraint

`better-sqlite3` is synchronous; PostgreSQL clients are asynchronous. This is
not a driver swap.

Migration order:

1. Introduce async repository interfaces backed by SQLite.
2. Convert callers deliberately.
3. Add PostgreSQL implementations.
4. Migrate and reconcile data.
5. Cut over behind configuration.
6. Remove SQLite only after production verification.

Never keep fire-and-forget work inside a Cloud Run request after sending the
response. Use Cloud Tasks.

---

## Future: GradeIQ Station, not mandatory device installation

The first native expansion should be a retailer-controlled desktop USB Station
Agent, not a consumer app requirement.

```text
Phone under test --USB--> GradeIQ Station --signed evidence--> GradeIQ Cloud
```

Potential uses:

- deeper identity and inventory information where platform access permits;
- battery/system information;
- security and activation checks;
- erasure coordination and proof;
- label printing;
- offline warehouse queue.

Keep all station results in the same normalized evidence model used by browser
tests and cosmetic inspection.

A managed GradeIQ device agent is a later product for organization-owned fleets
only. Do not factory-reset or MDM-enroll a customer trade-in merely to inspect
it.

## Testing strategy

### Pull-request tests

- pure capture math;
- telemetry validation/idempotency/bounds;
- response schemas;
- evidence fusion;
- zone completeness;
- grading policies;
- state transitions;
- tenant isolation;
- recorded provider responses;
- Playwright journey with mocked vision.

### Scheduled/live tests

- small pinned Vertex integration suite;
- repeat the same evidence packet multiple times;
- compare structured findings, boxes, severities and final grade;
- exclude API/quota failures from model-consistency calculations;
- run metamorphic variants: mild recompression, metadata removal, small exposure
  changes and controlled blur/glare.

### Release metrics

- cosmetic false-clean rate;
- scratch/crack recall on reviewed fixtures;
- run-to-run finding and grade agreement;
- capture retake and abandonment rate;
- unassessable rate;
- manual-review rate;
- p50/p95 latency;
- model cost per inspection;
- metrics sliced by store, camera, phone material and capture-profile version.

## Definition of done for the current assignment

Unless the user explicitly broadens the assignment, Claude should implement
only Phase 1 and stop with:

1. A concise summary of changed files.
2. Evidence that the actual production measurement function is tested.
3. Test/typecheck/build results.
4. A note of any remaining browser-camera validation that requires a real
   iPhone/Android device.
5. No deployment.
6. No commit unless requested.

## First command sequence for Claude

```bash
cd /Users/ammar/projects/gradeiq
git status --short
git diff -- lib/capture lib/captureTelemetry.ts \
  'app/api/sessions/[id]/capture-telemetry/route.ts' \
  app/components/V2Cam.tsx package.json
npm run test:capture
npx tsc --noEmit
```

Then inspect the exact call sites for accepted, rejected, skipped, replaced and
server-rejected capture attempts before proposing edits.

