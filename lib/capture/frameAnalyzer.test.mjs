// Tests the ACTUAL production measurement function.
//
// The previous version of this file transliterated `measurePixels` by hand and
// tested the copy. That is worse than no test: it passes while production
// drifts, and the "keep this honest" guard it carried only compared two
// constants — it would not have noticed a changed Laplacian kernel, a flipped
// comparison, or a wrong divisor.
//
// Node 22 strips TypeScript types natively, so the real module is imported
// directly. No test framework, no build step, no transliteration:
//
//   npm run test:capture
//
// The measurements checked here are what a cosmetic grade ultimately rests on.
// A focus or glare metric that quietly returns a wrong number stays invisible
// until someone disputes a price.

import { measurePixels, analyzeFrame, deriveInstruction, legacyVerdict } from "./frameAnalyzer.ts";

const S = 60;
const H = 40;
const N = S * H;

// ── frame builders ──────────────────────────────────────────────────────────
const buf = () => new Uint8ClampedArray(N * 4);
const put = (d, j, v) => {
  d[j * 4] = d[j * 4 + 1] = d[j * 4 + 2] = v;
  d[j * 4 + 3] = 255;
};
function flat(v) {
  const d = buf();
  for (let j = 0; j < N; j++) put(d, j, v);
  return d;
}
function checker(a, b) {
  const d = buf();
  for (let y = 0; y < H; y++) for (let x = 0; x < S; x++) put(d, y * S + x, (x + y) % 2 ? a : b);
  return d;
}
/** Flat mid-grey with one saturated blob covering `frac` of the area, bottom-right. */
function withGlare(frac) {
  const d = flat(120);
  const want = Math.round(N * frac);
  let done = 0;
  for (let y = H - 1; y >= 0 && done < want; y--)
    for (let x = S - 1; x >= 0 && done < want; x--) {
      put(d, y * S + x, 255);
      done++;
    }
  return d;
}

// ── assertions ──────────────────────────────────────────────────────────────
let failures = 0;
const near = (a, b, tol) => Math.abs(a - b) <= tol;
function check(name, cond, detail = "") {
  if (cond) console.log(`  ok   ${name}`);
  else {
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
    failures++;
  }
}

console.log("frameAnalyzer (production module)");

const grey = measurePixels(flat(128), S, H, null).measurements;
check("exposure tracks a flat frame", near(grey.exposure, 128, 1), `got ${grey.exposure.toFixed(1)}`);
check("flat frame has ~zero contrast", grey.contrast < 0.5, `got ${grey.contrast.toFixed(2)}`);
check("flat frame has ~zero sharpness", grey.sharpness < 0.5, `got ${grey.sharpness.toFixed(2)}`);
check("first frame reports no stability", grey.stability === null);

const sharp = measurePixels(checker(40, 210), S, H, null).measurements;
check(
  "texture scores far sharper than flat",
  sharp.sharpness > grey.sharpness + 1000,
  `flat ${grey.sharpness.toFixed(1)} vs checker ${sharp.sharpness.toFixed(1)}`
);

const dark = measurePixels(flat(20), S, H, null).measurements;
check("dark frame reads below the DARK threshold (45)", dark.exposure < 45, `got ${dark.exposure.toFixed(1)}`);

// The case both legacy assess() copies missed: a bright blob that barely moves the mean.
const g = measurePixels(withGlare(0.08), S, H, null).measurements;
check("glare coverage matches the blob area", near(g.glareCoverage, 0.08, 0.01), `got ${(g.glareCoverage * 100).toFixed(1)}%`);
check(
  "8% glare does NOT trip the old mean-brightness test (<228)",
  g.exposure < 228,
  `mean ${g.exposure.toFixed(1)} — exactly the glare the old check let through`
);
check(
  "glare centroid lands bottom-right",
  g.glareCentroid && g.glareCentroid.x > 0.5 && g.glareCentroid.y > 0.5,
  JSON.stringify(g.glareCentroid)
);

const clean = measurePixels(flat(120), S, H, null).measurements;
check("clean frame reports no glare", clean.glareCoverage === 0 && clean.glareCentroid === null);

const tiny = measurePixels(withGlare(0.001), S, H, null).measurements;
check("a handful of hot pixels yields no centroid", tiny.glareCentroid === null);

const a = measurePixels(flat(128), S, H, null);
const still = measurePixels(flat(128), S, H, a.luma).measurements;
check("identical frames are perfectly stable", near(still.stability, 1, 0.001), `got ${still.stability}`);
const moved = measurePixels(flat(140), S, H, a.luma).measurements;
check("a full-motion delta drops stability to 0", near(moved.stability, 0, 0.001), `got ${moved.stability}`);
const nudged = measurePixels(flat(134), S, H, a.luma).measurements;
check("half a motion delta is mid-scale", near(nudged.stability, 0.5, 0.02), `got ${nudged.stability}`);

// ── degenerate inputs ───────────────────────────────────────────────────────
// A 1x1 or 2x2 frame has no interior pixel, so the Laplacian loop never runs.
// It must return 0, not NaN — NaN would survive JSON.stringify as null and
// silently become a missing measurement rather than a visible failure.
const oneByOne = measurePixels(new Uint8ClampedArray([200, 200, 200, 255]), 1, 1, null).measurements;
check("1x1 frame yields sharpness 0, not NaN", oneByOne.sharpness === 0, `got ${oneByOne.sharpness}`);
check("1x1 frame still reports exposure", near(oneByOne.exposure, 200, 1), `got ${oneByOne.exposure}`);
const twoByTwo = measurePixels(new Uint8ClampedArray(2 * 2 * 4).fill(255), 2, 2, null).measurements;
check("2x2 frame yields finite numbers", Number.isFinite(twoByTwo.sharpness) && Number.isFinite(twoByTwo.contrast));

// A mismatched previous buffer must not be compared against.
const mismatched = measurePixels(flat(128), S, H, new Float32Array(9)).measurements;
check("stability is null when the previous frame size differs", mismatched.stability === null);

// ── the DOM wrapper degrades instead of throwing ────────────────────────────
check(
  "analyzeFrame returns null for a video with no dimensions",
  analyzeFrame({ videoWidth: 0, videoHeight: 0 }) === null
);

// ── guidance + legacy verdicts are computed from the same measurements ──────
check("dark frame is instructed TOO_DARK", deriveInstruction(dark, "v2cam") === "TOO_DARK");
check("glare frame is instructed REDUCE_GLARE", deriveInstruction(g, "v2cam") === "REDUCE_GLARE");
check(
  "the two surfaces still carry DIFFERENT sharpness thresholds",
  (() => {
    // Laplacian variance between 65 and 90: cosmetic accepts, v2cam does not.
    const between = { exposure: 128, contrast: 40, sharpness: 75, glareCoverage: 0, glareCentroid: null, stability: 1 };
    return legacyVerdict(between, "cosmetic").ok === true && legacyVerdict(between, "v2cam").ok === false;
  })(),
  "if this fails the profiles were merged — that is a behaviour change, not a refactor"
);

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
