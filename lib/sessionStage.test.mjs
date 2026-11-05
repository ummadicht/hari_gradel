// Tests the ACTUAL stage/tag derivation, imported from the production module.
//
//   node --experimental-strip-types --no-warnings lib/sessionStage.test.mjs
//
// Every assertion here is a rule an operator will read off the monitor and act
// on. Getting "photographed" wrong means the funnel says a phone was shot when
// it was not, and someone chases the wrong dropoff.

import { deriveStage, deriveTags, describeSession, funnel, reachedFunnel, severityFor, exceptions, ACTIONABLE, STAGES, STALL_MS } from "./sessionStage.ts";

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`  ok   ${name}`);
  else {
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
    failures++;
  }
}

console.log("sessionStage (production module)");

// ── stage ladder ────────────────────────────────────────────────────────────
check("an empty session is 'started'", deriveStage({}) === "started");
check("an IMEI alone is 'identified'", deriveStage({ imei: "355668270400752" }) === "identified");
check("a model alone is 'identified'", deriveStage({ model: "iPhone 15 Pro" }) === "identified");
check(
  "photos below target are 'capturing'",
  deriveStage({ model: "x", photoCount: 3, photoTarget: 6 }) === "capturing"
);
check(
  "a passed capture gate is 'photographed' even below target",
  deriveStage({ model: "x", photoCount: 3, photoTarget: 6, captureVerdict: "ok" }) === "photographed",
  "the SERVER gate is the authority on complete"
);
check(
  "photos at target are 'photographed'",
  deriveStage({ model: "x", photoCount: 6, photoTarget: 6 }) === "photographed"
);
check(
  "a failed capture gate is NOT photographed",
  deriveStage({ model: "x", photoCount: 3, photoTarget: 6, captureVerdict: "blurry" }) === "capturing"
);

// The one that silently inflates a funnel if it's wrong.
check(
  "all-skip functional results are NOT 'tested'",
  deriveStage({ photoCount: 6, functional: { touch: "skip", camera: "skip" } }) === "photographed",
  "walking past every test is not testing"
);
check(
  "one real verdict makes it 'tested'",
  deriveStage({ photoCount: 6, functional: { touch: "pass", camera: "skip" } }) === "tested"
);
check(
  "a FAIL counts as tested too",
  deriveStage({ photoCount: 6, functional: { touch: "fail" } }) === "tested"
);

check("a cosmetic grade is 'graded'", deriveStage({ cosmeticGrade: "B" }) === "graded");
check("an offer is 'offered'", deriveStage({ cosmeticGrade: "B", offer: { offer: 120 } }) === "offered");
check(
  "a BLOCKED offer is still 'offered'",
  deriveStage({ cosmeticGrade: "B", offer: { blocked: true } }) === "offered",
  "the pipeline ran to the end; why it was withheld is a tag"
);
check("accepted wins over everything", deriveStage({ accepted: 1, offer: { offer: 1 } }) === "accepted");

// ── tags are orthogonal to stage ────────────────────────────────────────────
check("review flag becomes a tag", deriveTags({ review: 1, ocrImei: "1", ocrShots: 1, ocrShots: 1 }).includes("review"));
check(
  "a blocked offer tags AND stays at the offered stage",
  (() => {
    const d = describeSession({ cosmeticGrade: "B", offer: { blocked: true }, ocrImei: "1", ocrShots: 1, ocrShots: 1 });
    return d.stage === "offered" && d.tags.includes("blocked");
  })()
);
check(
  "server-rejected captures tag as retaken",
  deriveTags({ captureOutcomes: ["captured", "rejected_server"], ocrImei: "1", ocrShots: 1, ocrShots: 1 }).includes("retakes")
);
check(
  "a replaced angle also counts as rework",
  deriveTags({ captureOutcomes: ["replaced"], ocrImei: "1", ocrShots: 1, ocrShots: 1 }).includes("retakes")
);
check(
  "a merely quality-rejected shutter is NOT rework",
  !deriveTags({ captureOutcomes: ["rejected_quality"], ocrImei: "1", ocrShots: 1, ocrShots: 1 }).includes("retakes"),
  "refusing a blurry frame before it lands is the system working"
);
check(
  "an abandoned step is tagged",
  deriveTags({ captureOutcomes: ["abandoned"], ocrImei: "1", ocrShots: 1, ocrShots: 1 }).includes("abandoned-step")
);

// The distinction the camera work turns on.
check(
  "a cleanable smudge is NOT a camera fault",
  !deriveTags({
    ocrImei: "1", ocrShots: 1,
    cameraAssessment: { lenses: [{ verdict: "degraded", findings: [{ impact: "cleanable" }] }] },
  }).includes("camera-fault")
);
check(
  "a real fault IS tagged",
  deriveTags({
    ocrImei: "1", ocrShots: 1,
    cameraAssessment: { lenses: [{ verdict: "faulty", findings: [{ impact: "fault" }] }] },
  }).includes("camera-fault")
);

check("no screenshot at all is 'no-settings'", deriveTags({}).includes("no-settings"));
check(
  "a screenshot WITHOUT a read IMEI is 'no-imei-proof', not 'no-settings'",
  (() => {
    const t = deriveTags({ ocrShots: 2 });
    return t.includes("no-imei-proof") && !t.includes("no-settings");
  })(),
  "27/59 prod sessions are exactly this case — evidence captured, never read"
);
check(
  "a screenshot WITH a read IMEI is clean",
  (() => {
    const t = deriveTags({ ocrShots: 2, ocrImei: "355668270400752" });
    return !t.includes("no-imei-proof") && !t.includes("no-settings");
  })()
);

// ── stall detection ─────────────────────────────────────────────────────────
{
  const now = 1_800_000_000_000;
  const old = new Date(now - STALL_MS - 60_000).toISOString().replace("T", " ").slice(0, 19);
  const fresh = new Date(now - 60_000).toISOString().replace("T", " ").slice(0, 19);
  check(
    "an old incomplete session is stalled",
    deriveTags({ photoCount: 2, updatedAt: old, now, ocrImei: "1", ocrShots: 1, ocrShots: 1 }).includes("stalled")
  );
  check(
    "a fresh incomplete session is not stalled",
    !deriveTags({ photoCount: 2, updatedAt: fresh, now, ocrImei: "1", ocrShots: 1, ocrShots: 1 }).includes("stalled")
  );
  check(
    "an OFFERED session is never stalled, however old",
    !deriveTags({ cosmeticGrade: "A", offer: { offer: 9 }, updatedAt: old, now, ocrImei: "1", ocrShots: 1, ocrShots: 1 }).includes("stalled"),
    "it finished; nobody needs chasing"
  );
}

// ── funnel ──────────────────────────────────────────────────────────────────
{
  const f = funnel([{}, { imei: "1" }, { imei: "1" }, { cosmeticGrade: "A" }]);
  check("funnel returns every stage, including empty ones", f.length === STAGES.length);
  check("funnel counts are correct", f.find((x) => x.stage === "identified").count === 2, JSON.stringify(f));
  check("funnel is in journey order", f[0].stage === "started" && f[f.length - 1].stage === "accepted");
  check(
    "funnel totals match the input",
    f.reduce((a, b) => a + b.count, 0) === 4
  );
}

// ── degenerate input must not throw ─────────────────────────────────────────
check("a totally empty object is safe", describeSession({}).stage === "started");
check(
  "a malformed updatedAt does not crash or stall",
  !deriveTags({ photoCount: 1, updatedAt: "not-a-date", ocrImei: "1", ocrShots: 1, ocrShots: 1 }).includes("stalled")
);
check("null-ish fields are safe", describeSession({ functional: null, offer: null, photoCount: null }).stage === "started");

// ── cumulative vs terminal funnel ───────────────────────────────────────────
{
  const ss = [{}, { imei: "1" }, { cosmeticGrade: "A" }, { accepted: 1 }];
  const term = funnel(ss);
  const cum = reachedFunnel(ss);
  check(
    "terminal funnel counts where sessions STOPPED",
    term.find((x) => x.stage === "started").count === 1 &&
      term.find((x) => x.stage === "accepted").count === 1
  );
  check(
    "cumulative funnel counts everyone who REACHED a stage",
    cum.find((x) => x.stage === "started").count === 4,
    "all four sessions passed through 'started'"
  );
  check(
    "cumulative is monotonically non-increasing",
    cum.every((x, i) => i === 0 || cum[i - 1].count >= x.count),
    JSON.stringify(cum.map((c) => c.count))
  );
  check(
    "the two views disagree BY DESIGN and that is the point",
    term.find((x) => x.stage === "identified").count !== cum.find((x) => x.stage === "identified").count
  );
}

// ── severity replaces riskFor ───────────────────────────────────────────────
{
  const clean = { ocrShots: 1, ocrImei: "1" };
  check("a blocked offer is a hold", severityFor({ ...clean, offer: { blocked: true } }).level === "hold");
  check(
    "a camera fault is a hold",
    severityFor({
      ...clean,
      cameraAssessment: { lenses: [{ verdict: "faulty", findings: [{ impact: "fault" }] }] },
    }).level === "hold"
  );
  check("review flag is a review", severityFor({ ...clean, review: 1 }).level === "review");
  check(
    "an unverified IMEI matters ONLY once priced",
    severityFor({ offer: { offer: 100 }, ocrShots: 0 }).level === "gap" &&
      severityFor({ photoCount: 2, ocrShots: 0 }).level !== "gap",
    "flagging it mid-capture would light up every in-progress session"
  );
  check("a clean priced session is normal", severityFor({ ...clean, offer: { offer: 50 } }).level === "normal");
  check(
    "exceptions are sorted worst-first and exclude normal",
    (() => {
      const ex = exceptions([
        { ...clean, offer: { offer: 1 } },
        { ...clean, review: 1 },
        { ...clean, offer: { blocked: true } },
      ]);
      return ex.length === 2 && ex[0].level === "hold" && ex[1].level === "review";
    })()
  );
}

// ── pre-derived input (the browser path) ────────────────────────────────────
{
  // The API strips raw columns, so a browser caller has ONLY stage + tags.
  // Re-deriving from that stripped row must not invent findings.
  const stripped = { stage: "offered", tags: ["blocked"] };
  check("severity reads pre-derived tags", severityFor(stripped).level === "hold");
  check(
    "a clean pre-derived row is normal, not falsely flagged",
    severityFor({ stage: "offered", tags: [] }).level === "normal",
    "recomputing from a stripped row would tag it no-settings and cry wolf"
  );
  check(
    "reachedFunnel accepts a pre-derived stage",
    reachedFunnel([{ stage: "graded" }]).find((f) => f.stage === "started").count === 1
  );
  check(
    "exceptions works end-to-end on stripped rows",
    (() => {
      const ex = exceptions([
        { stage: "offered", tags: [] },
        { stage: "offered", tags: ["review"] },
      ]);
      return ex.length === 1 && ex[0].level === "review";
    })()
  );
}

// ── actionable vs backlog ───────────────────────────────────────────────────
{
  check("stalled is NOT actionable", !ACTIONABLE.includes("stalled"),
    "it is funnel dropoff, not a pending decision — badging it made the count read 110 of 110");
  check("hold, review and gap ARE actionable",
    ["hold", "review", "gap"].every((l) => ACTIONABLE.includes(l)));
  const ex = exceptions([
    { stage: "offered", tags: ["blocked"] },
    { stage: "capturing", tags: ["stalled"] },
    { stage: "capturing", tags: ["stalled"] },
  ]);
  check("all three are exceptions", ex.length === 3);
  check("but only one needs a decision",
    ex.filter((x) => ACTIONABLE.includes(x.level)).length === 1);
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
