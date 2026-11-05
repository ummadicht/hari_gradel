import { NextRequest, NextResponse } from "next/server";
import { db, getSession } from "@/lib/db";
import { logEvent } from "@/lib/events";
import { assessCameraFrames, type CameraFrame } from "@/lib/cameraAssess";
import { admitCall } from "@/lib/uploadLimits";

// POST /api/sessions/[id]/camera-assess
//
// Runs the optical assessment over the stills the camera test already stored.
// Called un-awaited by the device test, and re-callable from the report when an
// assessment is missing (the un-awaited call is best-effort by construction —
// a browser that closes mid-request simply never delivers it).
//
// Deliberately idempotent-ish: if an assessment already exists it is returned
// as-is unless `?force=1`. A camera assessment is evidence attached to a
// finished test; silently re-running it on every report view would spend money
// and could quietly change what a past report said.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const s = getSession(id);
  if (!s) return NextResponse.json({ error: "not found" }, { status: 404 });

  const camera = (s.camera as Record<string, unknown>) ?? {};
  const frames = (Array.isArray((camera as any).frames) ? (camera as any).frames : []) as CameraFrame[];
  if (!frames.length) return NextResponse.json({ ok: false, reason: "no frames" });

  const force = new URL(req.url).searchParams.get("force") === "1";
  if ((camera as any).assessment && !force) {
    return NextResponse.json({ ok: true, cached: true, assessment: (camera as any).assessment });
  }

  // SUP-80: a real model call from here on, so it meets the anonymous rate
  // limit (429, no call). The cached answer above costs nothing and is not counted.
  const admitted = await admitCall(req, "camera-assess", id);
  if (!admitted.ok) return admitted.response;

  const assessment = await assessCameraFrames(frames);
  if (!assessment) {
    // No fabricated "clear". The absence of an assessment is recorded as an
    // absence, so the report can say "not assessed" truthfully.
    logEvent(id, "camera-test", "assess-failed", { frames: frames.length });
    return NextResponse.json({ ok: false, reason: "assessment unavailable" });
  }

  const fresh = getSession(id);
  const merged = { ...((fresh?.camera as Record<string, unknown>) ?? {}), assessment };
  db.prepare("UPDATE sessions SET camera = ?, updated_at = datetime('now') WHERE id = ?").run(
    JSON.stringify(merged),
    id
  );

  const faults = assessment.lenses.filter(
    (l) => l.verdict === "faulty" || l.findings.some((f) => f.impact === "fault")
  );
  logEvent(id, "camera-test", "assessed", {
    lenses: assessment.lenses.length,
    faulty: faults.length,
    model: assessment.model,
  });

  return NextResponse.json({ ok: true, assessment });
}
