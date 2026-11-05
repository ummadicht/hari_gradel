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

  const rows = db
    .prepare(
      `SELECT id, imei, model, status, client_id, cosmetic_grade, overall_grade,
              json_extract(cosmetic,'$.tierUsed') AS tier,
              json_extract(cosmetic,'$.needsHumanReview') AS review,
              json_extract(capture,'$.verdict') AS capture_verdict,
              json_array_length(photos) AS photo_count,
              -- Storage and colour come from the SELLER's own answer, not the
              -- IMEI: a TAC identifies make and model but never capacity or
              -- finish, so there is nowhere else to read them from.
              json_extract(device,'$.storageText') AS storage,
              json_extract(device,'$.color') AS color,
              -- Journey position is DERIVED, never a column: the app writes
              -- the status column at three points and that has never described
              -- where a phone actually stopped. These are the raw inputs; the
              -- ladder lives in lib/sessionStage.ts, testable and single-sourced.
              functional, offer, accepted,
              json_extract(ocr,'$.imei')      AS ocr_imei,
              json_array_length(json_extract(ocr,'$.shots')) AS ocr_shots,
              json_extract(camera,'$.assessment') AS camera_assessment,
              json_extract(profile,'$.photoTarget') AS photo_target,
              created_at, updated_at
       FROM sessions ${where} ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(...args, limit) as Record<string, any>[];

  // Capture-attempt outcomes per session, fetched in ONE query rather than per
  // row — the monitor lists up to `limit` sessions and an N+1 here would show
  // up immediately on a 63MB-RAM box.
  const ids = rows.map((r) => r.id);
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

  const parse = (v: unknown) => {
    if (!v || typeof v !== "string") return null;
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  };

  const sessions = rows.map((r) => {
    const { stage, tags } = describeSession({
      imei: r.imei,
      model: r.model,
      photoCount: r.photo_count,
      photoTarget: r.photo_target,
      captureVerdict: r.capture_verdict,
      functional: parse(r.functional),
      cosmeticGrade: r.cosmetic_grade,
      review: r.review,
      offer: parse(r.offer),
      accepted: r.accepted,
      ocrImei: r.ocr_imei,
      ocrShots: r.ocr_shots,
      cameraAssessment: parse(r.camera_assessment),
      captureOutcomes: outcomes.get(r.id) ?? [],
      updatedAt: r.updated_at,
    });
    // The raw JSON blobs were only ever inputs to the derivation — sending them
    // to the browser would put a seller's functional results and offer into a
    // list view that has no use for them.
    const { functional, offer, accepted, camera_assessment, ocr_imei, ocr_shots, photo_target, ...rest } = r;
    return { ...rest, stage, tags };
  });

  return NextResponse.json({ sessions });
}
