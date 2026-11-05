import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/db";
import { recordCapture } from "@/lib/captureTelemetry";
import { logEvent } from "@/lib/events";
import {
  isCaptureOutcome,
  isInstruction,
  MEASUREMENT_PROFILE,
  ACCEPTANCE_PROFILE,
} from "@/lib/capture/captureEvents";

// POST /api/sessions/[id]/capture-telemetry
//
// Observation mode: records how a capture attempt went and returns. It never
// accepts, rejects or re-grades anything.
//
// THREAT MODEL, stated plainly. This endpoint is unauthenticated, like the rest
// of the capture flow — the session id is the capability, exactly as it is for
// /photos and /cosmetic. That is acceptable for a write that cannot influence a
// grade or a price, but "cannot influence a grade" is not the same as "harmless":
// an unbounded insert against a known session id is a disk-fill against a VM
// that is already at 77% and shared with swapmore.com. So the write is bounded
// three ways — per-session cap, per-step cap, and an idempotency key — and every
// refusal is logged rather than silently dropped.
//
// Remaining risk, accepted for now: someone holding a valid session id can still
// write up to the cap with fabricated measurements. Closing that needs the
// store-device credential from the multi-tenant design; until then the caps
// bound the damage to noise in one session's telemetry.
//
// Deliberately NOT accepted: image data of any kind. Only measurements travel.
// Continuous camera frames uploaded "for analytics" would turn a trade-in
// counter into a surveillance feed.

/** Refuse oversized bodies before parsing — measurements are a few hundred bytes. */
const MAX_BODY_BYTES = 8 * 1024;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const declared = Number(req.headers.get("content-length") || 0);
  if (declared > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "payload too large" }, { status: 413 });
  }

  const raw = await req.text().catch(() => "");
  if (raw.length > MAX_BODY_BYTES) {
    // content-length is client-supplied, so the real length is checked too.
    return NextResponse.json({ error: "payload too large" }, { status: 413 });
  }
  let body: any = {};
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    return NextResponse.json({ error: "bad json" }, { status: 400 });
  }

  const s = getSession(id);
  if (!s) return NextResponse.json({ error: "not found" }, { status: 404 });

  const eventId = String(body.eventId ?? "").slice(0, 64);
  if (!eventId) return NextResponse.json({ error: "eventId required" }, { status: 400 });

  // Controlled vocabularies: an unknown outcome would create a category nobody
  // counts, which is worse than rejecting it.
  const outcome = isCaptureOutcome(body.outcome) ? body.outcome : null;
  if (!outcome) return NextResponse.json({ error: "unknown outcome" }, { status: 400 });

  const experimentalInstruction = isInstruction(body.experimentalInstruction)
    ? body.experimentalInstruction
    : "";

  // Numbers only, and bounded — measurements are attacker-controlled like any
  // other client-submitted field.
  const m = body.measurements && typeof body.measurements === "object" ? body.measurements : {};
  const num = (v: unknown, lo: number, hi: number): number | null =>
    typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : null;

  const measurements = {
    exposure: num(m.exposure, 0, 255),
    contrast: num(m.contrast, 0, 255),
    sharpness: num(m.sharpness, 0, 100000),
    glareCoverage: num(m.glareCoverage, 0, 1),
    glareCentroid:
      m.glareCentroid && typeof m.glareCentroid === "object"
        ? { x: num(m.glareCentroid.x, 0, 1), y: num(m.glareCentroid.y, 0, 1) }
        : null,
    stability: num(m.stability, 0, 1),
  };

  const av = body.actualVerdict && typeof body.actualVerdict === "object" ? body.actualVerdict : {};
  const actualVerdict = {
    accepted: av.accepted === true,
    reason: String(av.reason ?? "").slice(0, 120),
  };

  const g = body.guidance && typeof body.guidance === "object" ? body.guidance : {};
  const guidance = {
    durationMs: num(g.durationMs, 0, 10 * 60 * 1000),
    instructionsShown: Array.isArray(g.instructionsShown)
      ? g.instructionsShown.filter(isInstruction).slice(0, 12)
      : [],
  };

  const surface = body.surface === "cosmetic" ? "cosmetic" : "v2cam";

  const res = recordCapture({
    eventId,
    sessionId: id,
    clientId: s.client_id,
    surface,
    stepId: String(body.stepId ?? "").slice(0, 60),
    stepLabel: String(body.stepLabel ?? "").slice(0, 80),
    photoIndex: Number(body.photoIndex),
    attempt: Number(body.attempt),
    outcome,
    measurements,
    actualVerdict,
    experimentalInstruction,
    guidance,
    // Server-stamped, not client-supplied: a profile tag is what later
    // calibration groups by, and letting the client name it means one patched
    // page can poison a whole cohort.
    measurementProfile: MEASUREMENT_PROFILE,
    acceptanceProfile:
      surface === "cosmetic" ? ACCEPTANCE_PROFILE.cosmetic : ACCEPTANCE_PROFILE.v2cam,
  });

  if (!res.ok) {
    // A duplicate is the idempotency key working; a limit is a signal worth
    // seeing. Both are recorded in the session trail rather than dropped, so a
    // gap in telemetry is never mistaken for a step that did not happen.
    if (res.reason !== "duplicate") {
      logEvent(id, "capture-telemetry", "write-refused", { reason: res.reason, stepId: body.stepId });
    }
    // Still 200: the client must not retry, and a capture must never fail
    // because its telemetry did.
    return NextResponse.json({ ok: false, reason: res.reason });
  }

  return NextResponse.json({ ok: true });
}
