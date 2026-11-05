// Coordinate maths for grading a crop and reporting against the original.
//
// This is the part that fails SILENTLY. A wrong transform does not throw or
// blank the report — it draws confident damage markers in the wrong place, so
// a scratch on a phone's rail appears out in the background and the report
// still looks authoritative. Hence a round-trip identity test and explicit
// checks that a box near a crop edge stays near that edge.

import assert from "node:assert/strict";
import { isUsableCropBox, padBox, mapBoxToOriginal, coverageOf } from "./cropMap.ts";

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

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const boxClose = (a, b, eps = 1e-9) =>
  a.every((v, i) => close(v, b[i], eps)) || JSON.stringify({ got: a, want: b });

console.log("cropMap — accepting a crop box");

t("a plausible device box is usable", () => {
  assert.equal(isUsableCropBox([0.1, 0.3, 0.9, 0.62]), true);
});

t("rejects inverted and empty boxes", () => {
  assert.equal(isUsableCropBox([0.9, 0.3, 0.1, 0.62]), false);
  assert.equal(isUsableCropBox([0.5, 0.5, 0.5, 0.5]), false);
});

t("rejects a sliver — cropping to it would cut the device away", () => {
  assert.equal(isUsableCropBox([0.4, 0.4, 0.44, 0.9]), false);
});

t("rejects a full-frame box — nothing to gain, an edge to lose", () => {
  assert.equal(isUsableCropBox([0, 0, 1, 1]), false);
});

t("rejects malformed input rather than trusting it", () => {
  assert.equal(isUsableCropBox(null), false);
  assert.equal(isUsableCropBox([0.1, 0.2, 0.9]), false);
  assert.equal(isUsableCropBox([0.1, "x", 0.9, 0.8]), false);
  assert.equal(isUsableCropBox([NaN, 0.2, 0.9, 0.8]), false);
  assert.equal(isUsableCropBox([-0.5, 0.2, 0.9, 0.8]), false);
});

console.log("cropMap — padding");

t("padding grows the box on every side", () => {
  const p = padBox([0.2, 0.4, 0.6, 0.6], 0.1);
  assert.ok(p[0] < 0.2 && p[1] < 0.4 && p[2] > 0.6 && p[3] > 0.6, JSON.stringify(p));
});

t("padding is proportional, so a narrow box gets a narrow margin", () => {
  const narrow = padBox([0.0, 0.45, 1.0, 0.55], 0.2); // 10% wide
  const wide = padBox([0.0, 0.2, 1.0, 0.8], 0.2); // 60% wide
  const narrowPad = 0.45 - narrow[1];
  const widePad = 0.2 - wide[1];
  assert.ok(widePad > narrowPad * 3, `narrow ${narrowPad} vs wide ${widePad}`);
});

t("padding never escapes the frame", () => {
  const p = padBox([0.01, 0.01, 0.99, 0.99], 0.5);
  assert.deepEqual(p, [0, 0, 1, 1]);
});

console.log("cropMap — mapping findings back to the original");

t("a finding filling the crop maps to exactly the crop", () => {
  const crop = [0.1, 0.3, 0.9, 0.6];
  assert.ok(boxClose(mapBoxToOriginal([0, 0, 1, 1], crop), crop) === true);
});

t("a centred finding lands at the centre of the crop, not the photo", () => {
  const crop = [0.0, 0.6, 0.5, 1.0]; // top-right quadrant-ish
  const got = mapBoxToOriginal([0.4, 0.4, 0.6, 0.6], crop);
  // Centre of the crop is y=0.25, x=0.8 — NOT the photo centre (0.5, 0.5).
  assert.ok(close((got[0] + got[2]) / 2, 0.25, 1e-9), `y centre ${got}`);
  assert.ok(close((got[1] + got[3]) / 2, 0.8, 1e-9), `x centre ${got}`);
});

t("a mark on the crop's left edge stays on the crop's left edge", () => {
  // The regression that matters: an edge-of-device scratch must not drift into
  // the background when it is redrawn on the original photo.
  const crop = [0.05, 0.42, 0.95, 0.58];
  const got = mapBoxToOriginal([0.5, 0.0, 0.55, 0.04], crop);
  assert.ok(close(got[1], 0.42, 1e-9), `left edge drifted to ${got[1]}`);
});

t("round trip: original -> crop-relative -> original is the identity", () => {
  const crop = [0.2, 0.25, 0.8, 0.75];
  const original = [0.35, 0.4, 0.5, 0.55];
  // Express `original` relative to the crop, the way the grader would see it...
  const ch = crop[2] - crop[0];
  const cw = crop[3] - crop[1];
  const inner = [
    (original[0] - crop[0]) / ch,
    (original[1] - crop[1]) / cw,
    (original[2] - crop[0]) / ch,
    (original[3] - crop[1]) / cw,
  ];
  // ...then map it back and require the original coordinates.
  assert.ok(boxClose(mapBoxToOriginal(inner, crop), original, 1e-9) === true);
});

t("results are clamped inside the photo", () => {
  const got = mapBoxToOriginal([-0.5, -0.5, 1.5, 1.5], [0.1, 0.1, 0.9, 0.9]);
  assert.ok(got.every((v) => v >= 0 && v <= 1), JSON.stringify(got));
});

t("coverage reports the area actually kept", () => {
  assert.ok(close(coverageOf([0.0, 0.0, 0.5, 0.5]), 0.25));
});

console.log(pass + " assertions passed\n");
