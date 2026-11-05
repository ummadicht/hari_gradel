// Per-lens verdicts from a zoom set.
//
// This decides whether a camera is called broken, so the tests are weighted
// toward the ways it could wrongly fail a good lens. The asymmetry is the
// contract: only a defect the model can SEE may fail a lens; everything
// ambiguous — a seller who forgot to switch zoom, a digital-crop fallback, a
// soft frame, photos of different rooms — must land on "unverified".

import assert from "node:assert/strict";
import { judgeLensShots, buildLensPrompt, normaliseShotReads, applyLensVerdicts, FOV_MARGIN } from "./lensVerify.ts";

let pass = 0;
const t = (name, fn) => {
  try {
    fn();
    console.log("  ok  ", name);
    pass++;
  } catch (e) {
    console.log("  FAIL", name, "\n       ", e.message);
    process.exitCode = 1;
  }
};

const SHOTS = [
  { lensId: "ultrawide", label: "Ultra-wide (0.5×)", zoom: 0.5 },
  { lensId: "wide", label: "Main (1×)", zoom: 1 },
  { lensId: "telephoto", label: "Telephoto (3×)", zoom: 3 },
];

const read = (index, fov, extra = {}) => ({
  index,
  fieldOfView: fov,
  sharp: true,
  sameScene: true,
  findings: [],
  ...extra,
});

/** A clean set where the optics genuinely stepped: 90 → 55 → 20. */
const GOOD = [read(0, 90), read(1, 55), read(2, 20)];
const by = (v, id) => v.find((x) => x.lensId === id);

console.log("lensVerify — a genuine optical set");

t("all three lenses pass when the field of view steps down", () => {
  const v = judgeLensShots(SHOTS, GOOD);
  assert.equal(v.length, 3);
  assert.ok(v.every((x) => x.state === "pass"), JSON.stringify(v.map((x) => [x.lensId, x.state])));
});

t("verdicts come back keyed to the right lens", () => {
  const v = judgeLensShots(SHOTS, GOOD);
  assert.ok(by(v, "ultrawide") && by(v, "wide") && by(v, "telephoto"));
});

t("capture order does not matter — zoom order decides", () => {
  // Same readings, shots declared narrowest-first.
  const reversed = [
    { lensId: "telephoto", label: "t", zoom: 3 },
    { lensId: "wide", label: "w", zoom: 1 },
    { lensId: "ultrawide", label: "u", zoom: 0.5 },
  ];
  const v = judgeLensShots(reversed, [read(0, 20), read(1, 55), read(2, 90)]);
  assert.ok(v.every((x) => x.state === "pass"), JSON.stringify(v.map((x) => [x.lensId, x.state])));
});

console.log("lensVerify — only visible damage may fail a lens");

t("a cracked lens cover fails THAT lens", () => {
  const reads = [read(0, 90), read(1, 55), read(2, 20, {
    findings: [{ type: "crack", impact: "fault", note: "Shattered telephoto cover.", confidence: 0.9 }],
  })];
  const v = judgeLensShots(SHOTS, reads);
  assert.equal(by(v, "telephoto").state, "fail");
  assert.match(by(v, "telephoto").reason, /Shattered/);
  // and must not contaminate the others
  assert.equal(by(v, "wide").state, "pass");
  assert.equal(by(v, "ultrawide").state, "pass");
});

t("a fingerprint is cleanable — it still PASSES", () => {
  const reads = [read(0, 90, {
    findings: [{ type: "smudge", impact: "cleanable", note: "Fingerprint.", confidence: 0.8 }],
  }), read(1, 55), read(2, 20)];
  const v = judgeLensShots(SHOTS, reads);
  assert.equal(by(v, "ultrawide").state, "pass");
  assert.match(by(v, "ultrawide").reason, /wipe/i);
});

t("a blurry frame is a retake, NEVER a fault", () => {
  const reads = [read(0, 90), read(1, 55), read(2, 20, {
    sharp: false,
    findings: [{ type: "blur", impact: "retake", note: "Motion blur.", confidence: 0.7 }],
  })];
  assert.equal(by(judgeLensShots(SHOTS, reads), "telephoto").state, "unverified");
});

t("a dark frame does not condemn a camera", () => {
  const reads = [read(0, 90), read(1, 55), read(2, 20, {
    findings: [{ type: "dark", impact: "retake", note: "Finger over the lens.", confidence: 0.8 }],
  })];
  assert.notEqual(by(judgeLensShots(SHOTS, reads), "telephoto").state, "fail");
});

t("...and does not verify it either: a retake shot is unverified, not a pass", () => {
  const reads = [read(0, 90), read(1, 55), read(2, 20, {
    findings: [{ type: "dark", impact: "retake", note: "Finger over the lens.", confidence: 0.8 }],
  })];
  const v = by(judgeLensShots(SHOTS, reads), "telephoto");
  assert.equal(v.state, "unverified");
  assert.match(v.reason, /Finger over the lens/);
});

console.log("lensVerify — ambiguity is unverified, not failure");

t("no change in field of view is UNVERIFIED, not a fault", () => {
  // A dead telephoto (digital crop of the wide) and a seller who never switched
  // zoom produce the same picture. Calling that "faulty" costs someone money.
  const flat = [read(0, 60), read(1, 57), read(2, 55)];
  const v = judgeLensShots(SHOTS, flat);
  assert.ok(v.every((x) => x.state === "unverified"), JSON.stringify(v.map((x) => [x.lensId, x.state])));
  assert.match(by(v, "telephoto").reason, /did not change|not proof/i);
});

t("the margin is respected — just under it does not pass", () => {
  const marginal = [read(0, 60), read(1, 60 - (FOV_MARGIN - 1)), read(2, 20)];
  const v = judgeLensShots(SHOTS, marginal);
  assert.equal(by(v, "ultrawide").state, "unverified");
});

t("photos of different scenes cannot be compared", () => {
  const reads = [read(0, 90), read(1, 55, { sameScene: false }), read(2, 20)];
  const v = judgeLensShots(SHOTS, reads);
  assert.ok(v.every((x) => x.state === "unverified"));
  assert.match(by(v, "wide").reason, /different scenes/i);
});

t("a scene mismatch still cannot mask real damage", () => {
  // Precedence check: a visible crack outranks "we couldn't compare".
  const reads = [read(0, 90), read(1, 55, { sameScene: false }), read(2, 20, {
    findings: [{ type: "crack", impact: "fault", note: "Cracked cover.", confidence: 0.95 }],
  })];
  assert.equal(by(judgeLensShots(SHOTS, reads), "telephoto").state, "fail");
});

t("a missing reading is unverified, not a pass", () => {
  const v = judgeLensShots(SHOTS, [read(0, 90), read(2, 20)]);
  assert.equal(by(v, "wide").state, "unverified");
});

t("no readings at all yields no passes", () => {
  const v = judgeLensShots(SHOTS, []);
  assert.ok(v.every((x) => x.state === "unverified"));
});

t("malformed reads do not throw", () => {
  assert.doesNotThrow(() => judgeLensShots(SHOTS, [null, { index: "x" }, undefined]));
});

console.log("lensVerify — normalising the model's answer");

// The schema requires only `index`, so these are all VALID responses. Each one
// used to reach judgeLensShots raw; a missing `findings` threw.
t("a read with no findings field does not throw and cannot fail a lens", () => {
  const reads = normaliseShotReads([{ index: 0, fieldOfView: 90, sharp: true }, { index: 1, fieldOfView: 55, sharp: true }, { index: 2, fieldOfView: 20, sharp: true }]);
  assert.doesNotThrow(() => judgeLensShots(SHOTS, reads));
  assert.ok(judgeLensShots(SHOTS, reads).every((v) => v.state !== "fail"));
});

t("a bare {index} read stays unverified — no pass from missing measurements", () => {
  const v = judgeLensShots(SHOTS, normaliseShotReads([{ index: 0 }, { index: 1 }, { index: 2 }]));
  assert.ok(v.every((x) => x.state === "unverified"), JSON.stringify(v.map((x) => x.state)));
});

t("unstated sharpness is not a pass", () => {
  const v = judgeLensShots(SHOTS, normaliseShotReads([{ index: 0, fieldOfView: 90 }, { index: 1, fieldOfView: 55 }, { index: 2, fieldOfView: 20 }]));
  assert.ok(v.every((x) => x.state === "unverified"));
});

t("a finding with an unknown impact is dropped, never promoted to a fault", () => {
  const [r] = normaliseShotReads([{ index: 0, findings: [{ type: "crack", impact: "broken" }, { type: "smudge", impact: "cleanable" }] }]);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].impact, "cleanable");
});

t("a stated fault survives normalising and still fails that lens", () => {
  const reads = normaliseShotReads([
    { index: 0, fieldOfView: 90, sharp: true, findings: [{ type: "crack", impact: "fault", note: "Cracked cover", confidence: 0.9 }] },
    { index: 1, fieldOfView: 55, sharp: true },
    { index: 2, fieldOfView: 20, sharp: true },
  ]);
  const v = judgeLensShots(SHOTS, reads);
  assert.equal(v.find((x) => x.lensId === "ultrawide").state, "fail");
});

t("a fault the model is unsure of (or does not rate) cannot fail a lens — it lands on unverified", () => {
  for (const confidence of [0.2, undefined]) {
    const reads = normaliseShotReads([
      { index: 0, fieldOfView: 90, sharp: true, findings: [{ type: "crack", impact: "fault", confidence }] },
      { index: 1, fieldOfView: 55, sharp: true },
      { index: 2, fieldOfView: 20, sharp: true },
    ]);
    assert.equal(reads[0].findings[0].impact, "retake", `confidence ${confidence}`);
    const v = judgeLensShots(SHOTS, reads).find((x) => x.lensId === "ultrawide");
    assert.equal(v.state, "unverified", `confidence ${confidence}: neither a fail nor a pass`);
  }
});

t("a percent-scale confidence is read as percent: 30 is unsure, 85 is sure", () => {
  const [low] = normaliseShotReads([{ index: 0, findings: [{ type: "crack", impact: "fault", confidence: 30 }] }]);
  const [high] = normaliseShotReads([{ index: 0, findings: [{ type: "crack", impact: "fault", confidence: 85 }] }]);
  assert.equal(low.findings[0].impact, "retake");
  assert.equal(low.findings[0].confidence, 0.3);
  assert.equal(high.findings[0].impact, "fault");
  assert.equal(high.findings[0].confidence, 0.85);
});

t("a clean, complete answer still passes after normalising", () => {
  const v = judgeLensShots(SHOTS, normaliseShotReads(GOOD));
  assert.ok(v.every((x) => x.state === "pass"), JSON.stringify(v.map((x) => x.state)));
});

t("garbage input yields no reads", () => {
  assert.deepEqual(normaliseShotReads(null), []);
  assert.deepEqual(normaliseShotReads({ shots: [] }), []);
  assert.deepEqual(normaliseShotReads([null, { index: "1" }, 7]), []);
});

console.log("lensVerify — merging into the stored record (only ever worse for a measured lens)");

const AT = "2026-10-18T00:00:00.000Z";
const V = (lensId, state, reason = "photo") => ({ lensId, state, reason, findings: [] });
const stateOf = (r, id) => r.lenses.find((l) => l.id === id)?.state;

t("an operator's mark stands against any photo verdict", () => {
  for (const mark of ["pass", "fail"]) {
    for (const photo of ["pass", "fail", "unverified"]) {
      const r = applyLensVerdicts([{ id: "tele", state: mark, by: "operator" }], [V("tele", photo)], AT);
      assert.equal(stateOf(r, "tele"), mark, `operator ${mark} vs photo ${photo}`);
      assert.equal(r.applied[0].state, mark, "and the seller is shown the stored state");
      assert.equal(r.applied[0].kept, "operator");
    }
  }
});

t("a browser FAIL is never weakened by the photos (the repair deduction survives)", () => {
  for (const photo of ["pass", "unverified"]) {
    const r = applyLensVerdicts([{ id: "wide", state: "fail", by: "browser" }], [V("wide", photo)], AT);
    assert.equal(stateOf(r, "wide"), "fail", `photo ${photo}`);
    assert.equal(r.applied[0].state, "fail");
  }
});

t("a browser PASS is kept against an inconclusive or passing photo", () => {
  for (const photo of ["pass", "unverified"]) {
    const r = applyLensVerdicts([{ id: "wide", state: "pass", by: "browser" }], [V("wide", photo)], AT);
    assert.equal(stateOf(r, "wide"), "pass", `photo ${photo}`);
    assert.equal(r.applied[0].kept, "browser");
  }
});

t("...but a visible fault in the photos overrides a browser PASS (pixel checks pass cracked covers)", () => {
  const r = applyLensVerdicts([{ id: "wide", state: "pass", by: "browser" }], [V("wide", "fail", "Cracked cover")], AT);
  assert.equal(stateOf(r, "wide"), "fail");
  assert.equal(r.lenses[0].by, "vision");
  assert.equal(r.applied[0].state, "fail");
  assert.equal(r.applied[0].kept, undefined);
});

t("an unmeasured (manual) lens takes the photo verdict; unverified is stored as manual", () => {
  const r = applyLensVerdicts(
    [{ id: "uw", state: "manual" }, { id: "tele", state: "manual" }],
    [V("uw", "pass"), V("tele", "unverified")],
    AT,
  );
  assert.equal(stateOf(r, "uw"), "pass");
  assert.equal(stateOf(r, "tele"), "manual");
  assert.ok(r.lenses.every((l) => l.by === "vision" && l.at === AT));
});

t("a lens the record did not have is added; the input array is not mutated", () => {
  const prior = [{ id: "wide", state: "pass", by: "browser" }];
  const r = applyLensVerdicts(prior, [V("tele", "fail")], AT);
  assert.equal(stateOf(r, "tele"), "fail");
  assert.equal(prior.length, 1);
  assert.equal(prior[0].state, "pass");
});

console.log("lensVerify — prompt");

t("the prompt names each zoom and forbids failing on a soft photo", () => {
  const p = buildLensPrompt(SHOTS);
  assert.match(p, /0\.5×/);
  assert.match(p, /3×/);
  assert.match(p, /LARGER means WIDER/);
  assert.match(p, /never a fault/i);
});

console.log(pass + " assertions passed\n");
