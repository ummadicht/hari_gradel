import { NextResponse } from "next/server";
import { lookupGrant, reserveUploadCall, type LookupGrant, type UploadRefusal } from "./lookupBudget";
import { logEvent } from "./events";

/**
 * SIZE CAPS AND THE RATE LIMIT FOR THE ANONYMOUS UPLOAD AND VISION ROUTES (SUP-80).
 *
 * Every route that takes photos, frames or video, or calls a vision model on a
 * seller's behalf, runs `admitUpload` (or `admitCall`) before it reads the body:
 *
 *   413  the declared Content-Length is over the route's cap — nothing read;
 *   429  the caller's per-IP or per-session allowance is spent (the shared
 *        limiter, lib/lookupBudget.ts) — nothing read, nothing written, no
 *        model call; counted, and logged to the session trail (once per
 *        session, route and hour — see logRefusal);
 *   413  the body turned out longer than the cap (Content-Length is the
 *        client's claim; the stream is counted as it arrives and dropped the
 *        moment it passes the cap, so a lying header cannot fill memory).
 *
 * The size caps apply to everyone — they are sized for GradeIQ's own pages.
 * The rate limit never applies to SwapUp's server key, CounterIQ's retail key
 * or staff.
 *
 * Each cap is what the route's legitimate callers can send, from the code that
 * builds the request, with headroom. The working is in docs/UPLOAD-LIMITS.md;
 * keep the two in step. Images travel as base64 data URLs inside JSON, so a
 * file costs 4/3 of its size on the wire.
 */

const MB = 1024 * 1024;

export const UPLOAD_BODY_CAPS = {
  // ≤6 photos + ≤6 torch twins at ≤1440 px, JPEG 0.86 (V2Cam): ≤ ~20 MB.
  cosmetic: 32 * MB,
  // ≤8 screen captures at ≤1080/1280 px (V2Cam / ScreenTestControl): ≤ ~13 MB.
  display: 16 * MB,
  // ≤8 Settings frames from V2Cam (≤ ~13 MB), or ONE battery screenshot or
  // camera photo sent as picked, not downscaled (V2Flow): ≤ ~14 MB.
  ocr: 24 * MB,
  // ≤8 stills at 640 px, JPEG 0.72 (DeviceTest); the route keeps ≤400 KB each: ≤ 4.4 MB.
  "camera-frames": 6 * MB,
  // ≤4 shots downscaled to 1280 px (≤ 2.7 MB); a shot the browser cannot
  // decode goes as the original photo, which the route then drops by itself.
  "lens-verify": 24 * MB,
  // One rotation take recorded at 2 Mbps (V2Cam): a 3-minute sweep ≈ 60 MB.
  video: 96 * MB,
  // ONE frame at the camera's own resolution (ImeiScanner) or one picked
  // screenshot / photo as-is (V2Flow): ≤ ~14 MB.
  "imei-ocr": 24 * MB,
} as const;

export type UploadRoute = keyof typeof UPLOAD_BODY_CAPS;
/** Routes that only spend a model call (no upload) and so only meet the rate limit. */
export type CallRoute = UploadRoute | "camera-assess";

function tooLarge(route: string, limit: number): NextResponse {
  return NextResponse.json(
    { error: "payload too large", code: "too-large", route, limit },
    { status: 413 }
  );
}

/** The declared Content-Length, or null when there is none (or it is junk). */
function declaredLength(req: Request): number | null {
  const raw = req.headers.get("content-length");
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Read the body as text, giving up the moment it passes `maxBytes`.
 * null = over the cap (the rest of the stream is cancelled, not read).
 */
export async function readBodyCapped(req: Request, maxBytes: number): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function refusalText(reason: UploadRefusal, retryAfter: number): string {
  if (reason === "session-daily") {
    return "This check has had too many uploads today. Ask the store to finish it, or try again tomorrow.";
  }
  const minutes = Math.max(1, Math.ceil(retryAfter / 60));
  return `Too many uploads from this network in the last hour. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

type Refused = { ok: false; response: NextResponse };

/**
 * Write a refusal to the session trail — once per session, route and kind each
 * UTC hour. A refusal costs the caller nothing, so logging every one would let
 * a flood of refused requests grow the append-only trail without bound; the
 * limiter still counts every 429 (call_budget).
 */
const logged = new Set<string>();
let loggedHour = "";
function logRefusal(sessionId: string | null, event: "rate-limited" | "too-large", detail: Record<string, unknown>): void {
  if (!sessionId) return;
  const hour = new Date().toISOString().slice(0, 13);
  if (hour !== loggedHour) {
    loggedHour = hour;
    logged.clear();
  }
  const key = `${sessionId}|${event}|${String(detail.route)}`;
  if (logged.has(key)) return;
  logged.add(key);
  logEvent(sessionId, "uploads", event, detail);
}

/** The rate limit alone: reserve one call or answer 429 (and log it). */
async function reserve(req: Request, route: CallRoute, sessionId: string | null): Promise<{ ok: true; grant: LookupGrant } | Refused> {
  const grant = await lookupGrant(req, {});
  const r = reserveUploadCall(grant, sessionId);
  if (r.ok) return { ok: true, grant };
  logRefusal(sessionId, "rate-limited", { route, reason: r.reason, limit: r.limit, caller: grant.caller, ip: grant.ip });
  const res = NextResponse.json(
    { error: refusalText(r.reason, r.retryAfter), code: "rate-limited", reason: r.reason, limit: r.limit, retryAfter: r.retryAfter },
    { status: 429 }
  );
  res.headers.set("Retry-After", String(r.retryAfter));
  return { ok: false, response: res };
}

/**
 * The gate for a route that takes an upload: size, then allowance, then the
 * body. Answers the parsed JSON body — `{}` when it is not JSON, exactly as the
 * routes' old `req.json().catch(() => ({}))` did.
 *
 * `sessionId` is null where no session exists yet (/api/imei/ocr).
 */
export async function admitUpload(
  req: Request,
  route: UploadRoute,
  sessionId: string | null
): Promise<{ ok: true; body: any; grant: LookupGrant } | Refused> {
  const limit = UPLOAD_BODY_CAPS[route];
  const declared = declaredLength(req);
  if (declared !== null && declared > limit) {
    logRefusal(sessionId, "too-large", { route, limit, declared });
    return { ok: false, response: tooLarge(route, limit) };
  }

  const admitted = await reserve(req, route, sessionId);
  if (!admitted.ok) return admitted;

  const raw = await readBodyCapped(req, limit).catch(() => "");
  if (raw === null) {
    logRefusal(sessionId, "too-large", { route, limit, declared });
    return { ok: false, response: tooLarge(route, limit) };
  }
  let body: any = {};
  try {
    const parsed = JSON.parse(raw || "{}");
    if (parsed && typeof parsed === "object") body = parsed;
  } catch {
    /* not JSON — the route sees {} and answers as it always did */
  }
  return { ok: true, body, grant: admitted.grant };
}

/**
 * The gate for a route that spends a model call without an upload
 * (/camera-assess). Call it right before the model call, after any answer
 * that costs nothing (a cached result), so only real calls are counted.
 */
export async function admitCall(req: Request, route: CallRoute, sessionId: string): Promise<{ ok: true } | Refused> {
  const r = await reserve(req, route, sessionId);
  return r.ok ? { ok: true } : r;
}
