import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { db, getSession } from "@/lib/db";
import { logEvent } from "@/lib/events";
import { gradeFunctional } from "@/lib/grading";
import { recomputeOverall } from "@/lib/recompute";
import { visionJSON } from "@/lib/visionProvider";
import {
  buildLensPrompt,
  judgeLensShots,
  normaliseShotReads,
  applyLensVerdicts,
  LENS_VERIFY_SCHEMA,
  type ShotRead,
  type ZoomShot,
} from "@/lib/lensVerify";
import { admitUpload } from "@/lib/uploadLimits";

// POST /api/sessions/[id]/lens-verify
//   { shots: [{ lensId, label, zoom, photo: "data:image/jpeg;base64,…" }] }
//
// Verify the lenses the browser cannot select.
//
// `enumerateDevices()` exposes camera DEVICES, not lenses — an iPhone Pro
// returns one back camera for three or four. So the automatic test can only
// prove that SOME rear camera works, and the rest were recorded "manual",
// which in practice meant a person ticked a box from memory. These shots are
// taken through the phone's own camera UI (`capture="environment"`), where the
// seller switches 0.5×/1×/3× themselves, so the optics are genuinely exercised
// even though our code never touches them.
//
// The judgement is field of view: shot from one spot, a real ultrawide frame is
// visibly wider than the 1×. Measuring is the model's job; deciding is
// `judgeLensShots`, in code that is tested.
//
// Nothing here may fail a lens on ambiguity — see lib/lensVerify.ts. A dead
// telephoto and a seller who forgot to switch zoom look identical in a photo.

const MAX_SHOT_BYTES = 500 * 1024;
const MAX_SHOTS = 4;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = getSession(id);
  if (!s) return NextResponse.json({ error: "not found" }, { status: 404 });

  // SUP-80: the size cap and the anonymous rate limit, before the body is read
  // (413 / 429 — nothing written, no model call). lib/uploadLimits.ts
  const admitted = await admitUpload(req, "lens-verify", id);
  if (!admitted.ok) return admitted.response;
  const body = admitted.body;
  const incoming = Array.isArray(body.shots) ? body.shots.slice(0, MAX_SHOTS) : [];
  if (incoming.length < 2) {
    // One photo proves nothing: the whole method is a COMPARISON between frames.
    return NextResponse.json(
      { error: "at least two shots at different zooms are required" },
      { status: 400 }
    );
  }

  const dir = path.join(process.cwd(), "data", "uploads");
  fs.mkdirSync(dir, { recursive: true });

  const shots: ZoomShot[] = [];
  const dataUrls: string[] = [];
  const urls: string[] = [];
  let oversize = 0;

  for (const sh of incoming) {
    const m = /^data:image\/([a-z+]+);base64,(.*)$/i.exec(String(sh?.photo || ""));
    if (!m) continue;
    const buf = Buffer.from(m[2], "base64");
    if (buf.length > MAX_SHOT_BYTES) {
      oversize++;
      continue;
    }
    const zoom = Number(sh?.zoom);
    if (!Number.isFinite(zoom) || zoom <= 0) continue;
    const ext = /png/i.test(m[1]) ? "png" : /webp/i.test(m[1]) ? "webp" : "jpg";
    const file = `lens-${randomUUID()}.${ext}`;
    try {
      fs.writeFileSync(path.join(dir, file), buf);
    } catch {
      continue;
    }
    shots.push({
      lensId: String(sh?.lensId ?? "").slice(0, 40),
      label: String(sh?.label ?? "").slice(0, 60),
      zoom,
    });
    dataUrls.push(String(sh.photo));
    urls.push(`/api/uploads/${file}`);
  }

  if (shots.length < 2) {
    return NextResponse.json({ error: "no usable shots", oversize }, { status: 400 });
  }

  let reads: ShotRead[] = [];
  let answered = false;
  let visionError: string | null = null;
  try {
    const out = await visionJSON(buildLensPrompt(shots), dataUrls, "pro", undefined, LENS_VERIFY_SCHEMA);
    // The model's answer is `out.json` — `out` itself is the envelope
    // ({json, provider, model, error}). This used to read `out.shots`, which
    // never exists, so every lens check since the route shipped discarded the
    // model's reading and recorded "unverified": production logged
    // `lens-verified answered=false` on 9 of 9 runs.
    const json = out.json as { shots?: unknown } | null;
    if (json && Array.isArray(json.shots)) {
      answered = true;
      reads = normaliseShotReads(json.shots);
    } else visionError = out.error;
  } catch {
    /* fall through — no reading is an honest outcome, see below */
  }

  /* A vision failure must NOT silently become a verdict.
   *
   * With no readings `judgeLensShots` returns "unverified" for every lens,
   * which is exactly right: we asked the seller to do the work, could not
   * assess it, and must say so rather than passing the lenses because the
   * photos arrived. */
  const verdicts = judgeLensShots(shots, reads);

  // Merge into the per-lens record the functional test wrote, keeping every
  // lens it does not cover. `by: "vision"` matters — a verdict reached from
  // photographs is not the same evidence as one the browser measured, and the
  // report distinguishes them.
  //
  // RE-READ FIRST. The vision call takes seconds; an operator marking tests in
  // ManualChecks meanwhile must not be overwritten by the copy read on entry.
  const fresh = getSession(id) ?? s;
  const camera = { ...((fresh.camera as Record<string, unknown>) ?? {}) };
  const lenses = Array.isArray((camera as any).lenses) ? [...(camera as any).lenses] : [];
  const at = new Date().toISOString();
  // A photo check may only make a MEASURED lens worse — see applyLensVerdicts.
  // `applied` is what the seller is shown: the verdicts as STORED.
  const { lenses: merged, applied } = applyLensVerdicts(lenses, verdicts, at);
  lenses.splice(0, lenses.length, ...merged);
  (camera as any).lenses = lenses;
  (camera as any).lensShots = urls;
  (camera as any).verified = lenses.filter((l: any) => l.state === "pass").length;
  (camera as any).failed = lenses.filter((l: any) => l.state === "fail").length;
  (camera as any).manual = lenses.filter((l: any) => l.state === "manual").length;
  (camera as any).expected = lenses.length;

  // The overall camera verdict follows the same rule as the lens verdicts: a
  // fault fails it, anything still unproven is "skip", never a pass.
  const camState =
    lenses.some((l: any) => l.state === "fail")
      ? "fail"
      : lenses.some((l: any) => l.state === "manual")
        ? "skip"
        : "pass";
  const functional = { ...((fresh.functional as Record<string, unknown>) ?? {}), camera: camState };

  // The camera is a CRITICAL test, so its state moves functional_grade — and
  // with it the overall grade. Writing `functional` alone left a camera fail
  // pricing the repair deduction while the report still said "Working".
  db.prepare(
    "UPDATE sessions SET camera = ?, functional = ?, functional_grade = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(JSON.stringify(camera), JSON.stringify(functional), gradeFunctional(functional as any).grade, id);
  recomputeOverall(id);

  logEvent(id, "camera-test", "lens-verified", {
    shots: shots.length,
    answered,
    reason: visionError,
    oversize,
    verdicts: applied.map((v) => `${v.lensId}:${v.state}${v.kept ? `(kept:${v.kept})` : ""}`),
    camera: camState,
  });

  return NextResponse.json({ ok: true, verdicts: applied, camera: camState, assessed: answered });
}
