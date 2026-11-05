import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/db";
import { computeTrust } from "@/lib/trust";

// GET /api/sessions/[id]/trust → the v2 Trust Score fusion for this session.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const s = getSession(id);
  if (!s) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ trust: computeTrust(s) });
}
