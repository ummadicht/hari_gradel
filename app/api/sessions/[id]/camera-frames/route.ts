import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { db, getSession } from "@/lib/db";
import { logEvent } from "@/lib/events";
import { admitUpload } from "@/lib/uploadLimits";

// POST /api/sessions/[id]/camera-frames
//   { frames: [{ lensId, name, facing, photo: "data:image/jpeg;base64,…" }] }
//
// One still per LENS, captured while the functional camera test already has that
// lens's stream open. Until now that test only proved the sensor produced a
// VARYING image — a liveness check. It could not see a cracked lens cover, dust
// on the sensor, a stuck focus, or a colour cast, because it never kept a frame
// to look at. These frames are what turn "the camera responds" into "the camera
// takes an acceptable picture", and they become evidence in the report.
//
// PRIVACY — read before changing this.
// The rear frames show whatever the counter is pointed at. The FRONT frame
// shows the person holding the phone: in a retail trade-in that is a customer's
// face, captured as a side effect of a hardware test. Three consequences are
// deliberate here:
//   1. Frames are stored, but the seller-facing report never renders them —
//      only the operator view does (see the report page's `experience` split).
//   2. The capture is DISCLOSED in the test UI even though the image is not
//      displayed. "Don't show it" is a UI decision; "don't mention it" would be
//      a consent problem, and they are not the same choice.
//   3. Resolution is capped hard below. A frame large enough to assess optics
//      is far smaller than one useful for identifying a person.
// If a tenant operates somewhere that treats this as biometric data, the front
// lens should be excluded rather than merely hidden.

/** Max stored bytes per frame after decode. Optics assessment needs detail, not megapixels. */
const MAX_FRAME_BYTES = 400 * 1024;
const MAX_FRAMES = 8;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const s = getSession(id);
  if (!s) return NextResponse.json({ error: "not found" }, { status: 404 });

  // SUP-80: the size cap and the anonymous rate limit, before the body is read
  // (413 / 429 — nothing written, no model call). lib/uploadLimits.ts
  const admitted = await admitUpload(req, "camera-frames", id);
  if (!admitted.ok) return admitted.response;
  const body = admitted.body;
  const incoming = Array.isArray(body.frames) ? body.frames.slice(0, MAX_FRAMES) : [];
  if (!incoming.length) return NextResponse.json({ ok: true, saved: 0 });

  const dir = path.join(process.cwd(), "data", "uploads");
  fs.mkdirSync(dir, { recursive: true });

  const saved: {
    lensId: string;
    name: string;
    facing: string;
    url: string;
  }[] = [];
  let oversize = 0;

  for (const f of incoming) {
    const m = /^data:image\/([a-z+]+);base64,(.*)$/i.exec(String(f?.photo || ""));
    if (!m) continue;
    const buf = Buffer.from(m[2], "base64");
    // The shared VM sits at ~77% disk. A frame that arrives larger than the cap
    // is dropped rather than truncated — half an image is not evidence.
    if (buf.length > MAX_FRAME_BYTES) {
      oversize++;
      continue;
    }
    // Extension follows the ACTUAL bytes. Hardcoding .jpg worked only because
    // the capture path happens to encode JPEG; anything else would be stored
    // under a lying extension, and the vision loader picks its mime type from
    // that name.
    const ext = /png/i.test(m[1]) ? "png" : /webp/i.test(m[1]) ? "webp" : "jpg";
    const file = `cam-${randomUUID()}.${ext}`;
    try {
      fs.writeFileSync(path.join(dir, file), buf);
    } catch {
      continue;
    }
    saved.push({
      lensId: String(f?.lensId ?? "").slice(0, 40),
      name: String(f?.name ?? "").slice(0, 60),
      facing: f?.facing === "front" ? "front" : "rear",
      url: `/api/uploads/${file}`,
    });
  }

  // Merge into the existing camera detail rather than replacing it — the
  // functional test writes its per-lens pass/fail through a different route,
  // and whichever lands second must not erase the other.
  const camera = { ...((s.camera as Record<string, unknown>) ?? {}) };
  const existing = Array.isArray((camera as any).frames) ? (camera as any).frames : [];
  (camera as any).frames = [...existing, ...saved].slice(-MAX_FRAMES);

  db.prepare("UPDATE sessions SET camera = ?, updated_at = datetime('now') WHERE id = ?").run(
    JSON.stringify(camera),
    id
  );

  logEvent(id, "camera-test", "frames-stored", {
    saved: saved.length,
    oversize,
    lenses: saved.map((x) => x.lensId).slice(0, 8),
  });

  return NextResponse.json({ ok: true, saved: saved.length });
}
