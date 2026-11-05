import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/db";
import { logEvent, STEPS } from "@/lib/events";

// POST /api/sessions/[id]/event { step, event?, detail? }
// The flow pings this on every phase change so dwell time reflects what the
// SELLER actually experienced, not just when the server happened to be called.
// Public by design (the seller's device is unauthenticated) but tightly bounded:
// the step must be a known one and the payload is capped, so this can't be used
// to write arbitrary rows into the audit trail.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!getSession(id)) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const step = String(body.step || "");
  if (!(STEPS as readonly string[]).includes(step)) {
    return NextResponse.json({ error: "unknown step" }, { status: 400 });
  }
  const event = String(body.event || "enter").slice(0, 40);
  const detail =
    body.detail && typeof body.detail === "object"
      ? JSON.parse(JSON.stringify(body.detail).slice(0, 500))
      : {};

  logEvent(id, step, event, detail);
  return NextResponse.json({ ok: true });
}
