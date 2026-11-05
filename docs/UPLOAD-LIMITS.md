# Upload size caps, the anonymous rate limit, and uploads retention (SUP-80)

The session routes take photos, frames and video from anyone holding a session
id, write them to `data/uploads` and send many of them to a paid vision model.
A session is created with nothing but a POST. Until SUP-80 nothing bounded the
size of a request, how many a caller could send, or how long the files stayed.

Code: `lib/uploadLimits.ts` (the gate every route runs), `lib/lookupBudget.ts`
(the shared limiter from SUP-72, now with an uploads budget),
`scripts/uploads-retention.mjs` (the retention job). Tests:
`lib/uploadLimits.test.mjs`, `scripts/uploads-retention.test.mjs`, and N22–N24
in `scripts/e2e-keycloak/run.sh`.

## What a request meets, in order

| Step | Answer | What happens |
|---|---|---|
| Declared `Content-Length` over the route's cap | **413** `payload too large` | Nothing read, nothing counted. Logged `uploads / too-large` on the session (once per session, route and hour). |
| The caller's allowance is spent | **429** `rate-limited`, `Retry-After` | Nothing read, nothing written, **no model call**. Every refusal is counted (`call_budget`); the session trail gets `uploads / rate-limited` once per session, route and hour (a refusal costs the caller nothing, so one row per refusal would let a flood grow the trail); one line per address (or session) per hour in `pm2 logs gradeiq`. |
| The body runs past the cap while it is read (no or a lying `Content-Length`) | **413** | The stream is cancelled at the cap — never read to the end. Logged. |
| Otherwise | the route's own answer | Unchanged. A body that is not JSON is still read as `{}`. |

The size caps apply to everyone. The rate limit never applies to SwapUp's server
key (`x-gradeiq-server-key`), CounterIQ's retail key (`x-gradeiq-retail-key`) or
staff (a portal or Keycloak sign-in), and their calls are not counted.

## Size caps (per request)

Images travel as base64 data URLs inside JSON, so a file costs 4/3 of its size on
the wire. "Legit max" is the most GradeIQ's own pages can send, read from the code
that builds the request.

| Route | Who sends it, and what | Legit max | Cap |
|---|---|---|---|
| `POST /api/sessions/[id]/cosmetic` | SwapUp tablet (`V2Cam`): ≤6 photos + ≤6 torch twins, ≤1440 px, JPEG 0.86 (≤ ~1.2 MB each, high detail). The final submit carries none. Classic flow (`CosmeticCapture`): 1024 px, JPEG 0.72. | ~20 MB | **32 MB** |
| `POST /api/sessions/[id]/display` | `V2Cam` sweep (≤1080 px, 0.86) or `ScreenTestControl` (≤1280 px, 0.72): ≤8 captures | ~13 MB | **16 MB** |
| `POST /api/sessions/[id]/ocr` | `V2Cam` Settings scan: ≤8 frames as above (~13 MB). `V2Flow` battery step: ONE picked screenshot or camera photo, sent as-is (a 10 MB camera original ≈ 14 MB) | ~14 MB | **24 MB** |
| `POST /api/sessions/[id]/camera-frames` | `DeviceTest`: ≤8 stills at 640 px, 0.72 (50–80 KB); the route keeps ≤400 KB each | 4.4 MB | **6 MB** |
| `POST /api/sessions/[id]/lens-verify` | `DeviceTest`: ≤4 shots downscaled to 1280 px, 0.82 (the route keeps ≤500 KB each, 2.7 MB). A shot the browser cannot decode goes as the original photo, which the route then drops by itself | ~17 MB | **24 MB** |
| `POST /api/sessions/[id]/video` | `V2Cam` rotation take, now recorded at **2 Mbps** (`ROTATION_VIDEO_BPS`; it was left to the browser, so its size was unknowable). 3 minutes ≈ 45 MB ≈ 60 MB as a data URL; the cap holds ~4½ minutes | ~60 MB | **96 MB** |
| `POST /api/imei/ocr` | `ImeiScanner`: one frame at the camera's own resolution, 0.85. `V2Flow`: one picked screenshot or photo as-is | ~14 MB | **24 MB** |
| `POST /api/sessions/[id]/camera-assess` | no body (reads the stored stills) | — | rate limit only |

## The anonymous rate limit

Every gated call counts one, whatever it carries. `/camera-assess` counts only
when it really calls the model (its cached answer is free).

| Limit | Default | Env |
|---|---|---|
| per session, per UTC day | **60** | `GRADEIQ_ANON_UPLOAD_SESSION_CAP` |
| per address (first `X-Forwarded-For` entry), per UTC hour | **600** | `GRADEIQ_ANON_UPLOAD_IP_HOURLY_CAP` |

How many calls a real session makes, from the code:

| Caller | Calls | Typical | Heavy |
|---|---|---|---|
| SwapUp store tablet, GradeIQ `/v2/cam/[id]` (`V2Cam`) | `/cosmetic` validate (1 + 1 per retake) and final (1), `/video` (1 per rotation take — a retake records again), `/display` (1 per screen pass), `/ocr` (1 per Settings scan) | 5 | 13 (3 retakes, 2 screen passes, 2 scans) |
| The seller's phone, GradeIQ v2 self-test (`DeviceTest`, `V2Flow`) | `/camera-frames` + `/camera-assess` (1 each per camera run), `/lens-verify` (1 per submit), `/ocr` (battery screenshot), `/api/imei/ocr` (no session yet) | 4 | 9 (3 camera runs, 2 lens submits) |
| Station / enterprise desk (`/staff/[id]`, signed in) | staff | not limited | not limited |
| CounterIQ (`POST /api/sessions` with the retail key) | no uploads | — | — |

- **Per session**: 9 typical, 22 heavy → 60 is well over twice the heaviest.
- **Per address**: a store's tablets and the phones on its Wi-Fi share one
  address. A desk session takes about 10 minutes, so three desks make 18
  sessions an hour: ~160 calls typical, ~400 if every one is heavy → 600.

The test "a heavy session … and a busy store's hour stay well under the
defaults" pins these numbers.

What the limit does **not** do: there is no total across all addresses (SUP-72
has one for lookups, where running out degrades to the free TAC answer; here it
would stop every store grading at once). An address can still write up to
600 × its route's cap per hour; the retention job below and disk monitoring are
the backstop.

A 429 reaches GradeIQ's own pages only far beyond any real session. They do not
yet show it specially (the tablet treats any non-422 answer to `/cosmetic` as
"photos accepted"); worth doing if the limits are ever lowered.

## Retention (`scripts/uploads-retention.mjs`) — dry run, not scheduled

```
node scripts/uploads-retention.mjs                         # dry run: totals
node scripts/uploads-retention.mjs --list                  # dry run: every file it would remove
node scripts/uploads-retention.mjs --days 365 --keep-client swapmore-in
node scripts/uploads-retention.mjs --apply                 # actually delete
```

Run from the app directory (on the VM, `~/gradeiq`). The age defaults to
**180 days** (`--days`, `GRADEIQ_UPLOAD_RETENTION_DAYS`). The database is opened
read-only; a dry run writes nothing anywhere. It refuses to run without the
database.

A file is removed only when it was last written before the cutoff AND none of
these protects it:

- a **final** session owns it — accepted, payout passed, or a retail purchase on
  it accepted / cleared / paying / paid (the `lockReason` rule from SUP-66);
- a session that owns it was **updated after the cutoff** (still in use);
- a session that owns it is in a **kept tenant** (`--keep-client`,
  `GRADEIQ_UPLOAD_RETENTION_KEEP_CLIENTS`);
- a **purchase record** mentions it.

A session owns a file when any of its columns mentions `/api/uploads/<file>`, or
the file name starts with its id. Files no session owns go by age alone.

**Before `--apply`:** GradeIQ only knows the outcomes it records. SwapUp never
calls `/accept` and CounterIQ keeps its purchases in its own database, so their
sessions never read as final here — protect them with `--keep-client` (SwapUp is
`swapmore-in`) until they report back. A removed file leaves the session's
reference in place: the report shows a missing picture. Nothing schedules this
job; scheduling it (and the age) is the owner's decision.
