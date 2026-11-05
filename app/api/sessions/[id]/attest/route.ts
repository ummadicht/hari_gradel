import { NextRequest, NextResponse } from "next/server";
import { db, getSession } from "@/lib/db";
import { checkIdentity } from "@/lib/identity";

// POST /api/sessions/[id]/attest  { device: { ua, os, model, screen, dpr, gpu } }
// The device-under-test posts its own browser fingerprint when it scans the QR.
// We store it and return the identity cross-check (IMEI vs connected device vs
// photos) so the flow can flag a possible device swap.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const s = getSession(id);
  if (!s) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const d = (body.device ?? {}) as Record<string, any>;
  const deviceFp = {
    ua: String(d.ua || "").slice(0, 400),
    os: String(d.os || "").slice(0, 40),
    model: String(d.model || "").slice(0, 80),
    screen: String(d.screen || "").slice(0, 20),
    dpr: typeof d.dpr === "number" ? d.dpr : null,
    gpu: String(d.gpu || "").slice(0, 120),
    at: new Date().toISOString(),
  };

  const verification = { ...(s.verification as any), deviceFp };
  db.prepare(
    "UPDATE sessions SET verification = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(JSON.stringify(verification), id);

  const identity = checkIdentity(getSession(id)!);
  return NextResponse.json({ ok: true, identity });
}
