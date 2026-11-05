import { NextRequest, NextResponse } from "next/server";
import { db, getSession } from "@/lib/db";
import { logEvent } from "@/lib/events";
import { recomputeOverall } from "@/lib/recompute";
import { cosmeticOwner, decideManualGrade, isCosmeticTier, manualCosmetic } from "@/lib/sessionWriteRules";
import { sessionLock, staffFor } from "@/lib/sessionWriteAuth";

// POST /api/sessions/[id]/grade-manual  { grade }
// The cosmetic grade picked by hand (no camera / no AI).
//
// Anyone holding the session link reaches this, so the pick is judged by who
// made it (lib/sessionWriteRules.ts):
//   • no sign-in  → stored PROVISIONAL (not conclusive, no confidence), and
//                   refused (409) once the photos or the store have graded the
//                   phone, or once the offer was accepted;
//   • staff       → stored as the store's own grade, and may overrule either.
// Every call — saved or refused — lands in the session's event trail.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const s = getSession(id);
  if (!s) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const grade = String(body.grade ?? "");
  if (!isCosmeticTier(grade))
    return NextResponse.json({ error: "bad grade" }, { status: 400 });

  const actor = await staffFor(s);
  // Judge the record as it is now — a background AI grade may have landed
  // while this request was awaiting the sign-in check — and write in the same
  // synchronous stretch.
  const cur = getSession(id) ?? s;
  const lock = sessionLock(cur);
  const owner = cosmeticOwner(cur);
  const prev = { from: cur.cosmetic_grade || null, fromOwner: owner };

  const verdict = decideManualGrade({ owner, lock, staff: !!actor });
  if (!verdict.ok) {
    logEvent(id, "cosmetics", "manual-grade-refused", { grade, code: verdict.code, lock, ...prev });
    return NextResponse.json({ error: verdict.error, code: verdict.code }, { status: verdict.status });
  }

  const cosmetic = manualCosmetic(grade, !!actor, new Date().toISOString());
  db.prepare(
    "UPDATE sessions SET cosmetic = ?, cosmetic_grade = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(JSON.stringify(cosmetic), grade, id);
  recomputeOverall(id);

  // The staff member's name goes HERE, not on the cosmetic record: the event
  // trail is operator-only, the session JSON is served to the link holder.
  logEvent(id, "cosmetics", actor ? "manual-grade-staff" : "manual-grade-provisional", {
    grade,
    ...prev,
    ...(actor ? { actor, override: owner === "ai" || owner === "staff" || !!lock, lock } : {}),
  });
  return NextResponse.json({ ok: true, cosmetic, provisional: !actor });
}
