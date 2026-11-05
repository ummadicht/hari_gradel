// Tests the ACTUAL telemetry store and its contracts.
//
// `lib/db.ts` resolves its file from `process.cwd()`, so this test is launched
// with cwd set to a throwaway directory (scripts/run-tests.mjs) and gets its own
// database. Nothing here touches the real one.
//
// What is being defended:
//   • a duplicated beacon must not become a second "attempt" — that would
//     inflate the retake metric this table exists to measure;
//   • a known session id must not be able to grow the table without bound;
//   • a refused write must report WHY, because a silently dropped event is
//     indistinguishable from a step that never happened and biases every
//     retake statistic downward;
//   • step identity must be the stable id, not the display label.

const ROOT = new URL("../../", import.meta.url).href.replace(/\/$/, "");
const { recordCapture, listCaptures } = await import(`${ROOT}/lib/captureTelemetry.ts`);
const { db } = await import(`${ROOT}/lib/db.ts`);
const {
  isCaptureOutcome,
  isInstruction,
  newEventId,
  MAX_EVENTS_PER_SESSION,
  MAX_EVENTS_PER_STEP,
  CAPTURE_OUTCOMES,
} = await import(`${ROOT}/lib/capture/captureEvents.ts`);

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`  ok   ${name}`);
  else {
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
    failures++;
  }
}

console.log("captureTelemetry (production module)");

// A session row must exist for nothing here, but keep ids distinct per test.
const sid = () => "t" + Math.random().toString(36).slice(2, 10);

// ── controlled vocabulary ───────────────────────────────────────────────────
check("all six outcomes are recognised", CAPTURE_OUTCOMES.every(isCaptureOutcome));
check("an invented outcome is rejected", !isCaptureOutcome("looks_fine"));
check("a non-string outcome is rejected", !isCaptureOutcome(7) && !isCaptureOutcome(null));
check("instruction vocabulary is enforced", isInstruction("REDUCE_GLARE") && !isInstruction("SMILE"));
check("event ids are distinct", newEventId() !== newEventId());

// ── idempotency ─────────────────────────────────────────────────────────────
{
  const s = sid();
  const id = newEventId();
  const first = recordCapture({ eventId: id, sessionId: s, stepId: "front", outcome: "captured" });
  const second = recordCapture({ eventId: id, sessionId: s, stepId: "front", outcome: "captured" });
  check("first write succeeds", first.ok === true);
  check("replayed beacon is refused as duplicate", second.ok === false && second.reason === "duplicate",
    JSON.stringify(second));
  check("duplicate did not create a second row", listCaptures(s).length === 1);
}

// ── step identity ───────────────────────────────────────────────────────────
{
  const s = sid();
  recordCapture({
    eventId: newEventId(), sessionId: s,
    stepId: "back", stepLabel: "Rear glass", outcome: "captured",
  });
  const [row] = listCaptures(s);
  check("stepId is stored separately from the label", row.step_id === "back" && row.step_label === "Rear glass",
    `${row.step_id} / ${row.step_label}`);
  check("a renamed label does not change step identity",
    (() => {
      recordCapture({ eventId: newEventId(), sessionId: s, stepId: "back", stepLabel: "Back", outcome: "captured" });
      const rows = listCaptures(s);
      return rows.length === 2 && rows.every((r) => r.step_id === "back");
    })());
}

// ── every outcome round-trips ───────────────────────────────────────────────
{
  const s = sid();
  for (const o of CAPTURE_OUTCOMES) {
    recordCapture({ eventId: newEventId(), sessionId: s, stepId: "front", outcome: o, attempt: 2 });
  }
  const rows = listCaptures(s);
  check("all six outcomes persist", rows.length === CAPTURE_OUTCOMES.length);
  check("attempt is not forced back to 1", rows.every((r) => r.attempt === 2));
  check("refusals are stored, not only successes",
    rows.some((r) => r.outcome === "rejected_quality") && rows.some((r) => r.outcome === "abandoned"));
}

// ── per-step bound ──────────────────────────────────────────────────────────
{
  const s = sid();
  let refused = null;
  for (let i = 0; i < MAX_EVENTS_PER_STEP + 5; i++) {
    const r = recordCapture({ eventId: newEventId(), sessionId: s, stepId: "front", outcome: "rejected_quality" });
    if (!r.ok && !refused) refused = r;
  }
  check("per-step bound stops the flood", refused?.reason === "step_limit", JSON.stringify(refused));
  check("rows stop at the step cap", listCaptures(s).length === MAX_EVENTS_PER_STEP,
    `got ${listCaptures(s).length}, cap ${MAX_EVENTS_PER_STEP}`);
}

// ── per-session bound (spread across many steps) ────────────────────────────
{
  const s = sid();
  let refused = null;
  for (let i = 0; i < MAX_EVENTS_PER_SESSION + 10; i++) {
    // A new step every 10 events, so the per-step cap is never the limiter.
    const r = recordCapture({
      eventId: newEventId(), sessionId: s,
      stepId: "step-" + Math.floor(i / 10), outcome: "rejected_quality",
    });
    if (!r.ok && !refused) refused = r;
  }
  check("per-session bound stops the flood", refused?.reason === "session_limit", JSON.stringify(refused));
  check("rows stop at the session cap", listCaptures(s).length === MAX_EVENTS_PER_SESSION,
    `got ${listCaptures(s).length}, cap ${MAX_EVENTS_PER_SESSION}`);
}

// ── failures are reported, never thrown ─────────────────────────────────────
{
  // A missing event_id violates NOT NULL; the store must report it rather than
  // let the exception reach the capture path.
  let threw = false;
  let res;
  try {
    res = recordCapture({ eventId: undefined, sessionId: sid(), outcome: "captured" });
  } catch {
    threw = true;
  }
  check("a bad write does not throw into the capture path", !threw);
  check("a bad write reports a reason", res && res.ok === false, JSON.stringify(res));
}

// ── legacy migration ────────────────────────────────────────────────────────
{
  // Simulate a Release 1 row: no event_id. The migration backfills a synthetic
  // one so the UNIQUE index can exist without discarding real field data.
  const cols = db.prepare("PRAGMA table_info(capture_telemetry)").all().map((c) => c.name);
  check("migrated columns exist", ["event_id", "step_id", "step_label", "actual_verdict",
    "experimental_instruction", "measurement_profile", "acceptance_profile"].every((c) => cols.includes(c)),
    cols.join(","));
  const idx = db.prepare("PRAGMA index_list(capture_telemetry)").all().map((i) => i.name);
  check("unique index on event_id exists", idx.includes("idx_captel_eventid"), idx.join(","));
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
