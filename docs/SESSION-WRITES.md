# Who may rewrite a grade (SUP-66)

The session routes under `/api/sessions/[id]/*` are reached with nothing but the
session id — the UUID in the seller's QR, in SwapUp's camera link, in
CounterIQ's link. Until SUP-66 that id was enough to set any cosmetic grade as
conclusive, turn a failed test into a pass, stamp a lens "checked by hand", and
do all of it after the offer was accepted.

The rules live in `lib/sessionWriteRules.ts` (pure, unit tested) and
`lib/sessionWriteAuth.ts` (who is calling). Tests: `lib/sessionWrites.test.mjs`.
Every route's caller class is in `scripts/authz-map.json`, checked by
`npm run check:authz`.

## The rules

**Staff** = any portal / Keycloak sign-in (`portalUser`, in both
`GIQ_AUTH_MODE` settings), for a session of their own tenant, an untenanted
`default` session, or any session if super. A client admin of another tenant
is not staff for that session.

**Final** = the offer was accepted (`accepted = 1`), the payout gate passed
(`verification.payout.passed`), or the retail purchase built on the session is
`accepted`, `cleared`, `paying` or `paid`. A blocked accept is not final.

### `POST /grade-manual`

| Caller | Result |
|---|---|
| no sign-in, no grade yet (or only a stub — no model answered) | 200, stored **provisional**: `conclusive:false`, `confidence:0`, `provisional:true`, `by:"seller"`. The passport reads PENDING, not VERIFIED, and `/offer` prices it at the **lowest grade (D)** with no uncertainty share, showing the picked grade's price as the ceiling "once the store confirms" (lib/offer.ts). Priced at the pick, a seller could pick Premium, accept, and lock the session at the Premium price. A staff confirmation re-prices it in full. |
| no sign-in, over the seller's own earlier pick | 200 (a misclick can be corrected) |
| no sign-in, over an AI grade (Flash/Pro) or a staff grade | **409** |
| no sign-in, session final | **409** |
| staff | 200, `conclusive:true`, `by:"staff"` — may overrule anything; the name goes to the event trail only |

### `POST /functional`

Without a sign-in the write is judged **per result**, not as a whole: a result
it may not change keeps its stored value, and **everything else in the write
saves** (200). Refusing the whole write (the first version of SUP-66) threw
away a self-test re-run's other results and its camera detail whenever one
test that had failed now passed — while the phone showed the run as finished.

| Write | No sign-in | Staff / SwapUp server key |
|---|---|---|
| a value other than pass / fail / skip, malformed lens list | 400 | 400 |
| first results, new tests, skip→pass, pass→fail, anything worse | 200 | 200 |
| fail→pass, fail→skip, a fail dropped by a non-merge write | 200, **the fail is kept** | 200, logged `staff-override` |
| a failed lens passed or set to manual | 200, **the lens is kept** | 200, logged |
| a lens stamped `by:"operator"` or `by:"vision"` not already on record | 200, **not taken** | 200, logged |
| a lens staff (`operator`) or the photo check (`vision`) decided — any change but to `fail` | 200, **the lens is kept** | 200, logged |
| a `manual` lens (the browser could not open it) to `pass`, unless it was stored `by:"browser"` | 200, **the lens is kept** | 200, logged |
| a lens on record left out of the list | 200, **the lens is kept** | 200, dropped (logged if failed, decided or pending) |
| `camera` raised above what the lens record supports (a lens unchecked → at most `skip`; a lens faulty → `fail`) | 200, **the stored value is kept** | 200 |
| any write once final | **409**, nothing saved | 200, logged |

A 200 that kept something answers `refused: [...]` (e.g. `"mic: fail → pass"`),
`code: "needs-staff"` and `notice` — one plain sentence for the seller ("Saved —
except Microphone, kept as recorded before. Only the store can change that
result.") — and is logged as `functional-tests / write-refused` with
`status: 200`. A 409 is logged the same way with `status: 409`.

The camera record **merges** instead of being replaced, and no `/functional`
write sets `assessment`, `frames` or `lensShots` (dropped, recorded as
`ignored`) — only `/camera-assess`, `/camera-frames` and `/lens-verify` write those.

## Callers (who writes what)

| Caller | Writes | Effect of SUP-66 |
|---|---|---|
| GradeIQ v2 self-test on the phone (`DeviceTest`, also for CounterIQ's QR) | `/functional` merge, `/camera-frames`, `/lens-verify`, `/attest`, `/device` | First results save. A re-run saves everything except a recorded fail (or a lens it may not pass), which stays. The phone no longer fires and forgets: before it hands back it shows a save that failed (with Try again) or kept something ("Some results kept as before"). A Face ID "Try again" after a recorded fail no longer clears the fail. |
| Classic flow (`/s/[id]` `Gauntlet`) | `/functional` **non-merge** | First play saves; a replay saves, keeping any recorded fail it would drop or soften. |
| Report `ManualChecks` | `/functional` merge | Sellers can still mark untested/skipped tests. Lens Working/Faulty buttons are **staff only** (they write an operator stamp), and so is "Working" on the Cameras row while a lens is unchecked; sellers see "Needs a hands-on check". The buttons now show what the record holds, and the server's message when it kept a result or refused the tap. |
| Report / capture `GradeSelect` | `/grade-manual` | On the report, sellers no longer see the picker over an AI grade (they are offered a retake). Anywhere a pick is refused, the picker shows the server's message instead of silently resetting. |
| SwapUp server (`lib/server/gradeiq.ts` call 3) | `/functional` full map, `merge:true`, **no server key today** | The forward always saves (200). When a customer re-runs a failed test in SwapUp Check and it passes, GradeIQ keeps the fail until SwapUp sends its key (below); SwapUp's own verdict is unaffected and its sync no longer retries (it used to get a 403 and retry with backoff indefinitely). SwapUp never calls `/accept`, so it does not meet the 409. |
| SwapUp store tablet (GradeIQ `/v2/cam/[id]`) | `/cosmetic`, `/display`, `/screen`, `/video`, `/ocr` | Unchanged (not in SUP-66's scope). Size caps and the anonymous rate limit: docs/UPLOAD-LIMITS.md (SUP-80). |
| Station / enterprise desk (`/staff/[id]` signed in) | `/grade-manual`, `/functional` | Staff path: unchanged, now logged. |
| CounterIQ (`retail-portal/lib/gradeiq.ts`) | `POST /api/sessions` only; reads `GET /api/sessions/[id]`, `/screen` | Writes unchanged. Its creates should carry the retail key (below): without it every desk on a deployment shares ONE address's anonymous allowance (SUP-72), and from the 21st IMEI of the day the blacklist check is skipped. |

## Still to do (needs another repo)

1. **CounterIQ sends the retail key on `POST /api/sessions` — before or with
   this release.** In `retail-portal/lib/gradeiq.ts` `createGradeSession`:
   `headers: { "Content-Type": "application/json", ...(process.env.GRADEIQ_RETAIL_KEY ? { "x-gradeiq-retail-key": process.env.GRADEIQ_RETAIL_KEY } : {}) }`,
   and set `GRADEIQ_RETAIL_KEY` (the same value as GradeIQ's) in the env of each
   CounterIQ deployment (`deploy/deploy.sh`, `deploy-spectrum.sh`,
   `deploy-snktrading.sh` — VM-only, never in the repo). GradeIQ then gives
   every retail create the paid lookup with no daily limit
   (`lib/lookupBudget.test.mjs`: 25 creates from one address, all paid).
2. **SwapUp sends its server key on call 3.** In `swapup/lib/server/gradeiq.ts`
   `postFunctional`, add the header when `GRADEIQ_SERVER_KEY` is set:
   `headers: cfg.serverKey ? { "x-gradeiq-server-key": cfg.serverKey } : undefined`.
   GradeIQ then treats the forward as trusted (a re-run pass may clear a fail,
   logged `by:"server"`). Without it the forward still saves — the fail is kept
   and the 200 lists it in `refused` — so this is no longer a release blocker.
   Treating a 409 from `/functional` as final in `gradeiqBridge.ts runSync` is
   still worth doing, though SwapUp sessions do not become final today.
3. **A per-session write token** (issued at `POST /api/sessions`, required on
   every write) needs SwapUp to store it and add it to `cameraUrl()` and every
   call, CounterIQ to carry it in the QR link, and GradeIQ's own pages to keep
   it. Not done here, so no caller breaks; the monotonic rules above already
   stop the rewrite.
