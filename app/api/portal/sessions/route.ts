import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { describeSession } from "@/lib/sessionStage";
import { portalUser, scopedClient } from "@/lib/portalAuth";
import { isClientId } from "@/lib/clients";

// GET ?client=…&limit=… → that client's sessions for the monitor (scoped).
// Super may pass client=all for the cross-tenant view.
export async function GET(req: NextRequest) {
  const user = await portalUser();
  if (!user) return NextResponse.json({ error: "auth required" }, { status: 401 });

  const requested = req.nextUrl.searchParams.get("client");
  const limit = Math.min(200, Math.max(1, Number(req.nextUrl.searchParams.get("limit")) || 50));

  let where = "";
  let args: string[] = [];
  if (user.role === "super" && requested === "all") {
    // cross-tenant overview — super only
  } else {
    const scope = scopedClient(user, requested, isClientId);
    if (!scope.ok) return NextResponse.json({ error: scope.error }, { status: scope.status });
    where = "WHERE client_id = ?";
    args = [scope.clientId];
  }

  const rawRows = db
    .prepare(
      `SELECT id, imei, model, status, client_id, cosmetic_grade, overall_grade,
              cosmetic, capture, photos, device, functional, offer, accepted,
              ocr, camera, profile, created_at, updated_at
       FROM sessions ${where} ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(...args, limit) as Record<string, any>[];

  const parse = (v: unknown) => {
    if (!v || typeof v !== "string") return null;
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  };

  // Capture-attempt outcomes per session, fetched in ONE query rather than per
  // row — the monitor lists up to `limit` sessions and an N+1 here would show
  // up immediately on a 63MB-RAM box.
  const ids = rawRows.map((r) => r.id);
  const outcomes = new Map<string, string[]>();
  if (ids.length) {
    try {
      const marks = ids.map(() => "?").join(",");
      const oc = db
        .prepare(
          `SELECT session_id, outcome FROM capture_telemetry WHERE session_id IN (${marks})`,
        )
        .all(...ids) as { session_id: string; outcome: string }[];
      for (const o of oc) {
        const list = outcomes.get(o.session_id) ?? [];
        list.push(o.outcome);
        outcomes.set(o.session_id, list);
      }
    } catch {
      /* telemetry is decoration here — never fail the monitor over it */
    }
  }

  const sessions = rawRows.map((r) => {
    const cosmeticObj = parse(r.cosmetic);
    const captureObj = parse(r.capture);
    const photosArr = parse(r.photos);
    const deviceObj = parse(r.device);
    const ocrObj = parse(r.ocr);
    const cameraObj = parse(r.camera);
    const profileObj = parse(r.profile);

    const tier = cosmeticObj?.tierUsed ?? null;
    const review =
      cosmeticObj?.needsHumanReview === undefined || cosmeticObj?.needsHumanReview === null
        ? null
        : cosmeticObj.needsHumanReview
          ? 1
          : 0;
    const capture_verdict = captureObj?.verdict ?? null;
    const photo_count = Array.isArray(photosArr) ? photosArr.length : null;
    const storage = deviceObj?.storageText ?? null;
    const color = deviceObj?.color ?? null;
    const ocr_imei = ocrObj?.imei ?? null;
    const ocr_shots = Array.isArray(ocrObj?.shots) ? ocrObj.shots.length : null;
    const camera_assessment = cameraObj?.assessment ?? null;
    const photo_target = profileObj?.photoTarget ?? null;

    const { stage, tags } = describeSession({
      imei: r.imei,
      model: r.model,
      photoCount: photo_count,
      photoTarget: photo_target,
      captureVerdict: capture_verdict,
      functional: parse(r.functional),
      cosmeticGrade: r.cosmetic_grade,
      review,
      offer: parse(r.offer),
      accepted: r.accepted,
      ocrImei: ocr_imei,
      ocrShots: ocr_shots,
      cameraAssessment: camera_assessment,
      captureOutcomes: outcomes.get(r.id) ?? [],
      updatedAt: r.updated_at,
    });

    return {
      id: r.id,
      imei: r.imei,
      model: r.model,
      status: r.status,
      client_id: r.client_id,
      cosmetic_grade: r.cosmetic_grade,
      overall_grade: r.overall_grade,
      tier,
      review,
      capture_verdict,
      photo_count,
      storage,
      color,
      created_at: r.created_at,
      updated_at: r.updated_at,
      stage,
      tags,
    };
  });

  return NextResponse.json({ sessions });
}
