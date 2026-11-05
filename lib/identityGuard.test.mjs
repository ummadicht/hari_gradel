// "A model I have never heard of" must never become "a fake phone".
//
// Anchored on the real failure: a Galaxy Z Fold8 Ultra (announced 22 Jul 2026,
// on sale 7 Aug 2026) was reported as a MISMATCH because the grader's training
// data ended before it shipped. The prompt already forbade this; the model did
// it anyway, so the rule is enforced in code and pinned here.
//
// The other half matters just as much: a mismatch backed by something VISIBLE
// must survive untouched, or this guard would hide real swaps.

import assert from "node:assert/strict";
import { guardDeviceIdentity, citesNonExistence } from "./identityGuard.ts";

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

console.log("identityGuard — the reported failure");

t("the Fold8 Ultra verdict is withdrawn", () => {
  const r = guardDeviceIdentity({
    make: "Samsung",
    model: "Galaxy Z Fold 6",
    match: "mismatch",
    reason:
      "Claimed model Galaxy Z Fold8 Ultra does not exist; device appears to be a Galaxy Z Fold 6 based on squared corners and camera layout.",
  });
  assert.equal(r.downgraded, true);
  assert.equal(r.device.match, "uncertain");
});

t("the grader's original words are kept, not hidden", () => {
  const r = guardDeviceIdentity({
    match: "mismatch",
    reason: "Claimed model Galaxy Z Fold8 Ultra does not exist.",
  });
  assert.match(r.device.reason, /Original note/);
  assert.match(r.device.reason, /Fold8 Ultra/);
  assert.match(r.device.reason, /training cutoff/);
});

console.log("identityGuard — every flavour of 'not in my data'");

for (const [name, reason] of [
  ["does not exist", "That model does not exist."],
  ["doesn't exist", "The claimed phone doesn't exist in Samsung's lineup."],
  ["no such model", "There is no such model as the S26 Ultra Max."],
  ["not a real model", "This is not a real model name."],
  ["never released", "Apple never released an iPhone 18 Pro."],
  ["unreleased", "The claimed device is unreleased."],
  ["non-existent", "Claimed model is non-existent."],
  ["not in my training", "That model is not in my training data."],
  ["not aware of", "I am not aware of a Pixel 12 Pro Fold."],
]) {
  t(`"${name}" is downgraded`, () => {
    const r = guardDeviceIdentity({ match: "mismatch", reason });
    assert.equal(r.device.match, "uncertain", reason);
    assert.equal(r.downgraded, true);
  });
}

console.log("identityGuard — real mismatches must survive");

t("a visible camera-count contradiction still stands", () => {
  const r = guardDeviceIdentity({
    match: "mismatch",
    reason: "The claimed iPhone 15 Pro has three rear cameras; this device shows two.",
  });
  assert.equal(r.device.match, "mismatch");
  assert.equal(r.downgraded, false);
});

t("a visible body-type contradiction still stands", () => {
  const r = guardDeviceIdentity({
    match: "mismatch",
    reason: "Claimed a foldable, but the body is a single rigid slab with no hinge.",
  });
  assert.equal(r.device.match, "mismatch");
});

t("a headphone jack on a modern flagship still stands", () => {
  const r = guardDeviceIdentity({
    match: "mismatch",
    reason: "A 3.5mm headphone jack is present, which the claimed model does not have.",
  });
  assert.equal(r.device.match, "mismatch");
});

console.log("identityGuard — leaves everything else alone");

t("a match is untouched even if the wording is odd", () => {
  const d = { match: "match", reason: "Layout matches; this model does not exist in my list though." };
  const r = guardDeviceIdentity(d);
  // Only MISMATCH verdicts are withdrawn — nothing else is rewritten.
  assert.equal(r.device.match, "match");
  assert.equal(r.downgraded, false);
});

t("an existing 'uncertain' is untouched", () => {
  const r = guardDeviceIdentity({ match: "uncertain", reason: "does not exist" });
  assert.equal(r.device.match, "uncertain");
  assert.equal(r.downgraded, false);
});

t("a mismatch with no reason at all is left as-is", () => {
  // No stated evidence is a separate problem; this guard only removes verdicts
  // whose evidence is explicitly the model's own ignorance.
  const r = guardDeviceIdentity({ match: "mismatch" });
  assert.equal(r.device.match, "mismatch");
});

t("missing input does not throw", () => {
  assert.doesNotThrow(() => guardDeviceIdentity(undefined));
  assert.doesNotThrow(() => guardDeviceIdentity(null));
  assert.equal(citesNonExistence(undefined), false);
});

console.log(pass + " assertions passed\n");
