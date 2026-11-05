// Tests the production compliance store and the freshness rule.
//
// Run with a throwaway cwd so lib/db.ts creates its own database — `npm test`
// (scripts/run-tests.mjs) gives every test file a fresh one.
//
// The rule being defended is the one that makes this table worth having:
// a contradiction must be recorded BEFORE it is reconciled away, because the
// reconciliation is what destroys the evidence.

const ROOT = new URL("../", import.meta.url).href.replace(/\/$/, "");
const {
  recordCompliance,
  listCompliance,
  hasBlockingCompliance,
  checkScreenshotFreshness,
  isComplianceKind,
  DEFAULT_SEVERITY,
  SCREENSHOT_TTL_MS,
} = await import(`${ROOT}/lib/compliance.ts`);

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`  ok   ${name}`);
  else {
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
    failures++;
  }
}
const sid = () => "c" + Math.random().toString(36).slice(2, 10);

console.log("compliance (production module)");

// ── vocabulary ──────────────────────────────────────────────────────────────
check("known kinds are accepted", isComplianceKind("identity.imei_mismatch"));
check("invented kinds are rejected", !isComplianceKind("identity.looks_dodgy"));
check(
  "identity mismatches block, process violations only record",
  DEFAULT_SEVERITY["identity.imei_mismatch"] === "block" &&
    DEFAULT_SEVERITY["process.step_skipped"] === "record",
  "blocking on process would stop honest operators working"
);

// ── the evidence-preserving property ────────────────────────────────────────
{
  const s = sid();
  recordCompliance({
    sessionId: s,
    kind: "identity.imei_mismatch",
    expected: "355668270400752",
    observed: "358096977162516",
    source: "ocr",
  });
  const [row] = listCompliance(s);
  check("both sides of the contradiction survive", row.expected === "355668270400752" && row.observed === "358096977162516",
    "storing only 'mismatch' makes a dispute unarguable months later");
  check("severity defaults from the kind", row.severity === "block");
  check("an identity mismatch blocks payout", hasBlockingCompliance(s) === true);
}
{
  const s = sid();
  recordCompliance({ sessionId: s, kind: "process.step_skipped", observed: "camera" });
  check("a recorded-only event does not block", hasBlockingCompliance(s) === false);
}

// ── append-only ─────────────────────────────────────────────────────────────
{
  const s = sid();
  recordCompliance({ sessionId: s, kind: "identity.unproven", observed: "no imei" });
  recordCompliance({ sessionId: s, kind: "identity.unproven", observed: "still none" });
  const rows = listCompliance(s);
  check("a repeat is a NEW row, never an update", rows.length === 2);
  check("rows come back in the order observed", rows[0].id < rows[1].id);
}

// ── freshness ───────────────────────────────────────────────────────────────
{
  const t0 = 1_800_000_000_000;
  check("a screenshot taken during the window is fresh", checkScreenshotFreshness(t0, t0 + 30_000).fresh);
  check(
    "the reported 5-minute-old upload is REJECTED",
    checkScreenshotFreshness(t0, t0 + 300_000).fresh === false,
    "this is the exact case that was uploadable before"
  );
  check(
    "a picture predating the challenge is rejected",
    checkScreenshotFreshness(t0, t0 - 60_000).fresh === false,
    "it was taken of something else — possibly another phone"
  );
  check(
    "small negative skew is tolerated",
    checkScreenshotFreshness(t0, t0 - 2_000).fresh === true,
    "clocks tick between issuing the challenge and writing the file"
  );
  check("a missing timestamp is not fresh", checkScreenshotFreshness(t0, 0).fresh === false);
  check("NaN does not pass", checkScreenshotFreshness(t0, NaN).fresh === false);
  check(
    "the window is wider than 60s on purpose",
    SCREENSHOT_TTL_MS > 60_000,
    "60s rejects honest sellers doing the dialer round trip on iOS"
  );
  check(
    "the rejection says WHY, with the age",
    /\d+s ago/.test(checkScreenshotFreshness(t0, t0 + 300_000).reason),
    checkScreenshotFreshness(t0, t0 + 300_000).reason
  );
}

// ── failures never break the flow ───────────────────────────────────────────
{
  let threw = false;
  try {
    recordCompliance({ sessionId: undefined, kind: "identity.unproven" });
  } catch {
    threw = true;
  }
  check("a bad write does not throw into the capture path", !threw);
  check("listing an unknown session is empty, not an error", listCompliance("nope").length === 0);
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
