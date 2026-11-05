// Is a mark on the phone, or on the room behind it?
//
// The bias under test: this LABELS, it never deletes. "unknown" must be
// returned whenever there is nothing solid to compare against, because most
// stored sessions predate device outlines and quietly calling those marks
// off-device would be as wrong as the problem it fixes.

import assert from "node:assert/strict";
import { scopeOf, fractionInside, deviceBoxByPhoto, ON_DEVICE_MIN } from "./findingScope.ts";

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

// A narrow, tall handset down the middle of the frame — the side-capture case.
const PHONE = [0.1, 0.42, 0.9, 0.6];

console.log("findingScope — overlap maths");

t("a box wholly inside is fully contained", () => {
  assert.equal(fractionInside([0.4, 0.45, 0.5, 0.55], PHONE), 1);
});

t("a box wholly outside contains nothing", () => {
  assert.equal(fractionInside([0.4, 0.05, 0.5, 0.15], PHONE), 0);
});

t("a straddling box reports the overlapping share", () => {
  // Half in, half out horizontally.
  const f = fractionInside([0.4, 0.36, 0.5, 0.48], PHONE);
  assert.ok(f > 0.45 && f < 0.55, `expected ~0.5, got ${f}`);
});

t("a zero-area box is not silently 100% contained", () => {
  assert.equal(fractionInside([0.4, 0.5, 0.4, 0.5], PHONE), 0);
});

console.log("findingScope — verdicts");

t("a scratch on the phone is on-device", () => {
  assert.equal(scopeOf([0.45, 0.46, 0.52, 0.56], PHONE), "on-device");
});

t("a mark out on the background is off-device", () => {
  // This is the reported failure: a "crack" tagged on tile grout beside the phone.
  assert.equal(scopeOf([0.45, 0.05, 0.52, 0.18], PHONE), "off-device");
});

t("an edge mark straddling the rail still counts as on-device", () => {
  // A chip on the very edge legitimately overlaps the outline; the bar is
  // "mostly on the device", not "entirely within it".
  const s = scopeOf([0.45, 0.40, 0.5, 0.46], PHONE);
  assert.equal(s, "on-device");
});

t("the threshold is the documented one", () => {
  assert.equal(ON_DEVICE_MIN, 0.5);
});

console.log("findingScope — refuses to guess");

t("no device outline means unknown, NOT off-device", () => {
  // Every session graded before deviceBoxes existed lands here. Marking those
  // "off-device" would discredit thousands of legitimate findings.
  assert.equal(scopeOf([0.4, 0.45, 0.5, 0.55], undefined), "unknown");
  assert.equal(scopeOf([0.4, 0.45, 0.5, 0.55], null), "unknown");
});

t("no finding box means unknown", () => {
  assert.equal(scopeOf(undefined, PHONE), "unknown");
});

t("malformed boxes are unknown, never a verdict", () => {
  assert.equal(scopeOf([0.4, 0.45, 0.5], PHONE), "unknown");
  assert.equal(scopeOf([NaN, 0.45, 0.5, 0.55], PHONE), "unknown");
  assert.equal(scopeOf(["a", "b", "c", "d"], PHONE), "unknown");
  // Inverted box — ymax below ymin.
  assert.equal(scopeOf([0.6, 0.45, 0.5, 0.55], PHONE), "unknown");
});

console.log("findingScope — indexing outlines");

t("outlines are keyed by photo", () => {
  const m = deviceBoxByPhoto([
    { photoIndex: 0, box: PHONE },
    { photoIndex: 2, box: [0, 0, 1, 1] },
  ]);
  assert.equal(m.size, 2);
  assert.deepEqual(m.get(0), PHONE);
});

t("malformed entries are dropped rather than trusted", () => {
  const m = deviceBoxByPhoto([
    { photoIndex: 0, box: PHONE },
    { photoIndex: 1, box: [1, 2] },
    { photoIndex: "x", box: PHONE },
    null,
  ]);
  assert.equal(m.size, 1);
  assert.ok(m.has(0));
});

t("an empty or missing list is an empty map, not a throw", () => {
  assert.equal(deviceBoxByPhoto(undefined).size, 0);
  assert.equal(deviceBoxByPhoto([]).size, 0);
});

console.log(pass + " assertions passed\n");
