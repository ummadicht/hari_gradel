import { NextRequest, NextResponse } from "next/server";
import { db, getSession } from "@/lib/db";
import { checkParts } from "@/lib/partsCheck";

// POST /api/sessions/[id]/parts  { photo: dataUrl }
// OCRs the phone's parts-authentication screen → genuine / non-OEM per component.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const s = getSession(id);
  if (!s) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const photo: string = typeof body.photo === "string" ? body.photo : "";
  const result = await checkParts(photo);
  const stored = { ...result, checkedAt: new Date().toISOString() };

  db.prepare(
    "UPDATE sessions SET parts = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(JSON.stringify(stored), id);

  return NextResponse.json({ ok: true, parts: stored });
}
