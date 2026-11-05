import { NextResponse } from "next/server";
import { checkIdentity } from "@/lib/identity";
import { getSession } from "@/lib/db";
import { computeTrust } from "@/lib/trust";
import { GRADE_RESULT_HEADER, GRADE_RESULT_TAG } from "@/contracts/grade-result";
import { refineField } from "@/lib/refineStatus";
import { refineStatusNow } from "@/lib/visionProvider";

// GET /api/sessions/[id] — the grade result SwapUp and CounterIQ read.
// What it promises them is contracts/grade-result.ts (named in the response
// header); fields are only ever added here, never renamed.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const s = getSession(id);
  if (!s) return NextResponse.json({ error: "not found" }, { status: 404 });
  // Trust travels with the grade too. CounterIQ prices its buy offer off it
  // (6% lower below 70) and read `trust` here, where it never was — so every
  // offer was priced as if fully trusted. The same score /trust and the
  // passport show; null only if it could not be computed.
  let trust: number | null = null;
  try {
    trust = computeTrust(s).score;
  } catch {
    /* never let the score take the grade down with it */
  }
  // SUP-63: is a `refining` grade still being worked out, or did the work die?
  // Decided on every read and never written back: a read changes no rows. The
  // stored `cosmetic.refining` goes out unchanged (SwapUp reads it as "not
  // final", which an unfinished grade is not).
  const refine = refineField(refineStatusNow(s.cosmetic, s.updated_at));
  // Identity travels WITH the grade. A consumer of this API (CounterIQ pays real
  // money against it) must never have to ask separately whether the graded
  // device is the device on the record — that is how the check gets skipped.
  return NextResponse.json(
    { ...s, identity: checkIdentity(s), trust, refine },
    { headers: { [GRADE_RESULT_HEADER]: GRADE_RESULT_TAG } }
  );
}
