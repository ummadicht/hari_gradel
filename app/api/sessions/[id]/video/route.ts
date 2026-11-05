import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { db, getSession } from "@/lib/db";
import { admitUpload } from "@/lib/uploadLimits";

// POST /api/sessions/[id]/video  { video: dataUrl(webm|mp4) }
// The background rotation recording — evidence the exterior sweep was one
// continuous take (not stitched stills). Saved to disk; path stored on the session.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = getSession(id);
  if (!s) return NextResponse.json({ error: "not found" }, { status: 404 });

  // SUP-80: the size cap and the anonymous rate limit, before the body is read
  // (413 / 429 — nothing written, no model call). lib/uploadLimits.ts
  const admitted = await admitUpload(req, "video", id);
  if (!admitted.ok) return admitted.response;
  const body = admitted.body;
  const video = String(body.video ?? "");
  const m = /^data:video\/([a-z0-9.+-]+);base64,(.*)$/i.exec(video);
  if (!m) return NextResponse.json({ error: "no video" }, { status: 400 });
  const ext = /mp4/i.test(m[1]) ? "mp4" : "webm";

  const dir = path.join(process.cwd(), "data", "uploads");
  fs.mkdirSync(dir, { recursive: true });
  const file = `${id}-rotation.${ext}`;
  try {
    fs.writeFileSync(path.join(dir, file), Buffer.from(m[2], "base64"));
  } catch {
    return NextResponse.json({ error: "write failed" }, { status: 500 });
  }
  const url = `/api/uploads/${file}`;
  db.prepare("UPDATE sessions SET video = ?, updated_at = datetime('now') WHERE id = ?").run(url, id);
  return NextResponse.json({ ok: true, video: url });
}
