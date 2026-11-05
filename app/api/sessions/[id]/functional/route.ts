import { NextRequest, NextResponse } from "next/server";
import { db, getSession } from "@/lib/db";
import { logEvent } from "@/lib/events";
import { gradeFunctional } from "@/lib/grading";
import { recomputeOverall } from "@/lib/recompute";
import { checkFunctionalWrite, keptNotice, readCameraBody, readFunctionalBody } from "@/lib/sessionWriteRules";
import { isServerCaller, sessionLock, staffFor } from "@/lib/sessionWriteAuth";

// POST /api/sessions/[id]/functional  { functional: { [testId]: 'pass'|'fail'|'skip' }, merge?, camera?, audio? }
//
// Written by the phone's own self-test, the report's manual checks, and
// SwapUp's server — all holding nothing but the session id. So the write is
// judged (lib/sessionWriteRules.ts checkFunctionalWrite):
//   400  a result that is not pass / fail / skip, or a malformed lens list;
//   409  the session is final (offer accepted, payout gate passed, purchase
//        committed) — without a staff sign-in nothing changes any more;
//   200  otherwise. Without a staff sign-in (or SwapUp's server key) the write
//        is judged per result: a recorded fault is not cleared (fail→pass,
//        fail→skip, a failed lens, a test dropped by a non-merge write), no
//        lens takes an operator or photo-check stamp, a decided or untestable
//        lens is not passed, no lens is dropped — those keep their stored value,
//        are listed in `refused` (and `notice`, in plain words), and EVERYTHING
//        ELSE in the write saves. Refusing the whole write used to throw away a
//        re-run's other results and its camera detail, while the phone showed
//        the run as finished.
// The phone's first results, new tests and anything that makes a result worse
// save. Staff overrides and refusals are both written to the event trail.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const s = getSession(id);
  if (!s) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const fn = readFunctionalBody(body.functional);
  if (!fn.ok) return NextResponse.json({ error: fn.error }, { status: 400 });
  const cam = readCameraBody(body.camera);
  if (!cam.ok) return NextResponse.json({ error: cam.error }, { status: 400 });

  const actor = await staffFor(s);
  const server = !actor && isServerCaller(req);
  const by = actor ? "staff" : server ? "server" : "anonymous";

  // Judge against the record as it is NOW, and write in the same synchronous
  // stretch (better-sqlite3 never yields): the copy read before the awaits
  // above may already be stale — the phone, the tablet and SwapUp all write here.
  const cur = getSession(id) ?? s;
  // merge:true lets the device submit partial results (e.g. only camera) without
  // clobbering results captured elsewhere in the same linked session.
  const judged = checkFunctionalWrite({
    stored: (cur.functional as Record<string, string>) ?? {},
    storedCamera: (cur.camera as Record<string, unknown>) ?? {},
    incoming: fn.value,
    merge: !!body.merge,
    camera: cam.value,
    trusted: !!actor || server,
    lock: sessionLock(cur),
  });
  if (!judged.ok) {
    logEvent(id, "functional-tests", "write-refused", {
      status: judged.status,
      code: judged.code,
      changes: judged.changes.slice(0, 8),
    });
    return NextResponse.json(
      { error: judged.error, code: judged.code, refused: judged.changes.slice(0, 8) },
      { status: judged.status }
    );
  }

  const results = judged.results as Record<string, "pass" | "fail" | "skip">;
  const verdict = gradeFunctional(results);

  db.prepare(
    "UPDATE sessions SET functional = ?, functional_grade = ?, camera = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(JSON.stringify(results), verdict.grade, JSON.stringify(judged.camera), id);

  recomputeOverall(id);
  if (judged.refused.length) {
    logEvent(id, "functional-tests", "write-refused", {
      status: 200,
      code: "needs-staff",
      changes: judged.refused.slice(0, 8),
    });
  }
  if (judged.overrides.length) {
    // The name is recorded here, in the operator-only trail — never on the
    // session record the link holder can read.
    logEvent(id, "functional-tests", "staff-override", {
      by,
      ...(actor ? { actor } : {}),
      changes: judged.overrides.slice(0, 8),
    });
  }
  const fails = Object.entries(results).filter(([, v]) => v === "fail").map(([k]) => k);
  // The speaker frequency-response measurements ride along in the event trail
  // rather than in `functional`: that column is a flat map of pass/fail/skip
  // that gradeFunctional() iterates, so a nested object in it would be scored
  // as a test result. The event log is already the place for evidence behind a
  // verdict, and it needs no schema change to hold it.
  const audio =
    body.audio && typeof body.audio === "object"
      ? {
          speakerProfile: (Array.isArray(body.audio.profile) ? body.audio.profile : []).slice(0, 32).map((b: any) => ({
            hz: Number(b?.hz) || 0,
            delta: Math.round(Number(b?.delta) || 0),
            heard: !!b?.heard,
          })),
          weakBands: Array.isArray(body.audio.weakBands) ? body.audio.weakBands.slice(0, 32) : [],
        }
      : null;
  logEvent(id, "functional-tests", "results-recorded", {
    grade: verdict.grade,
    pass: Object.values(results).filter((v) => v === "pass").length,
    fail: fails.length,
    failed: fails.slice(0, 6),
    tested: Object.keys(results).length,
    by,
    ...(judged.ignored.length ? { ignored: judged.ignored } : {}),
    ...(audio ?? {}),
  });
  return NextResponse.json({
    ok: true,
    verdict,
    session: getSession(id),
    ...(judged.refused.length
      ? { refused: judged.refused.slice(0, 8), code: "needs-staff", notice: keptNotice(judged.kept) }
      : {}),
  });
}
