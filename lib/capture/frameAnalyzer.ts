"use client";
// ONE frame analyzer for every capture surface.
//
// There were three, and they had already drifted apart:
//   CosmeticCapture.assess()  blurry below Laplacian variance 65
//   V2Cam.assess()            blurry below 90
//   lib/captureGate.ts        its own sharpness pass, server-side
// The same phone in the same light is therefore "sharp — capture it" on one
// screen and "not sharp yet" on the other. Whichever number is right, they
// cannot both be, and a capture standard that depends on which component the
// seller happened to land in is not a standard.
//
// This module measures. It does not decide. Callers apply their own thresholds
// through `legacyVerdict` so that consolidating the MEASUREMENT does not
// silently change what either surface accepts — behaviour moves later, on
// evidence, once telemetry says which threshold was actually right.
//
// Everything here is deterministic image processing: no model, no network.

/** Raw, uninterpreted measurements of a single video frame. */
export type FrameMeasurements = {
  /** Mean luminance, 0..255. */
  exposure: number;
  /** Std-dev of luminance — low means washed-out or an empty frame. */
  contrast: number;
  /** Laplacian variance. Higher = better focused. */
  sharpness: number;
  /**
   * Fraction of the sampled area that is near-saturated, 0..1.
   *
   * This is the measurement the old code was missing. Both `assess()` copies
   * rejected glare by MEAN brightness, which only catches a frame that is
   * uniformly blown out. The glare that actually ruins a cosmetic grade is a
   * small, intense specular blob sitting on the glass — it hides scratches
   * underneath it while barely moving the mean at all.
   */
  glareCoverage: number;
  /** Where the glare sits, normalised 0..1, or null when there is none worth reporting. */
  glareCentroid: { x: number; y: number } | null;
  /**
   * Frame-to-frame similarity, 0..1 (1 = perfectly still). Null on the first
   * frame, when there is nothing to compare against yet.
   */
  stability: number | null;
};

export type AnalyzeResult = {
  measurements: FrameMeasurements;
  /** Retained so the next call can compute stability without re-sampling. */
  luma: Float32Array;
  width: number;
  height: number;
};

/** Sampling width. Small on purpose — this runs every animation frame. */
const S = 180;
/** A pixel at or above this luminance counts as specular glare, not detail. */
const GLARE_LEVEL = 246;
/** Mean-abs luminance delta at which the frame is considered fully moving. */
const MOTION_FULL = 12;

/**
 * Measure one frame. `prev` is the previous call's `luma` (pass null the first
 * time); it is what makes `stability` available without keeping video history.
 *
 * `region` selects the sampled area as fractions of the frame, so a caller can
 * measure the phone box rather than the whole viewport.
 */
export function analyzeFrame(
  video: HTMLVideoElement,
  prev?: { luma: Float32Array; width: number; height: number } | null,
  region: { x: number; y: number; w: number; h: number } = { x: 0.2, y: 0.2, w: 0.6, h: 0.6 }
): AnalyzeResult | null {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;

  const sx = Math.round(vw * region.x);
  const sy = Math.round(vh * region.y);
  const sw = Math.round(vw * region.w);
  const sh = Math.round(vh * region.h);
  const outH = Math.max(1, Math.round((S * sh) / sw));

  const c = document.createElement("canvas");
  c.width = S;
  c.height = outH;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, S, outH);
  const { data } = ctx.getImageData(0, 0, S, outH);
  return measurePixels(data, S, outH, prev?.luma ?? null);
}

/**
 * The pure half: RGBA bytes in, measurements out. No DOM, no video, no canvas.
 *
 * Split out so the arithmetic is testable without a browser — a focus metric
 * that silently returns the wrong number is exactly the kind of bug that hides
 * for months behind "the camera felt fine".
 */
export function measurePixels(
  data: Uint8ClampedArray,
  S: number,
  outH: number,
  prevLuma: Float32Array | null
): AnalyzeResult {
  const n = S * outH;
  const luma = new Float32Array(n);
  let sum = 0;
  let glarePixels = 0;
  let gx = 0;
  let gy = 0;
  for (let i = 0, j = 0; j < n; i += 4, j++) {
    const v = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    luma[j] = v;
    sum += v;
    if (v >= GLARE_LEVEL) {
      glarePixels++;
      gx += j % S;
      gy += (j / S) | 0;
    }
  }
  const exposure = sum / n;

  let varSum = 0;
  for (let j = 0; j < n; j++) {
    const d = luma[j] - exposure;
    varSum += d * d;
  }
  const contrast = Math.sqrt(varSum / n);

  // Laplacian variance — the standard cheap focus measure.
  let lSum = 0;
  let lSum2 = 0;
  let m = 0;
  for (let y = 1; y < outH - 1; y++) {
    for (let x = 1; x < S - 1; x++) {
      const i = y * S + x;
      const lap = 4 * luma[i] - luma[i - 1] - luma[i + 1] - luma[i - S] - luma[i + S];
      lSum += lap;
      lSum2 += lap * lap;
      m++;
    }
  }
  const sharpness = m > 0 ? lSum2 / m - (lSum / m) ** 2 : 0;

  const glareCoverage = glarePixels / n;
  // Below ~0.2% of the area, a "centroid" is describing a handful of stray hot
  // pixels — reporting a direction from that would be confident noise.
  const glareCentroid =
    glarePixels > n * 0.002
      ? { x: gx / glarePixels / S, y: gy / glarePixels / outH }
      : null;

  let stability: number | null = null;
  if (prevLuma && prevLuma.length === n) {
    let diff = 0;
    for (let j = 0; j < n; j++) diff += Math.abs(luma[j] - prevLuma[j]);
    const meanDiff = diff / n;
    stability = Math.max(0, Math.min(1, 1 - meanDiff / MOTION_FULL));
  }

  return {
    measurements: { exposure, contrast, sharpness, glareCoverage, glareCentroid, stability },
    luma,
    width: S,
    height: outH,
  };
}

/** The two capture surfaces' historical thresholds, kept apart on purpose. */
export type CaptureProfile = "cosmetic" | "v2cam";

const THRESHOLDS: Record<CaptureProfile, { dark: number; bright: number; contrast: number; sharp: number }> = {
  // CosmeticCapture.tsx
  cosmetic: { dark: 45, bright: 228, contrast: 13, sharp: 65 },
  // V2Cam.tsx — stricter on focus, and this difference is the whole reason
  // this file exists. Telemetry decides which one survives; until then both
  // surfaces keep behaving exactly as they do today.
  v2cam: { dark: 45, bright: 228, contrast: 13, sharp: 90 },
};

export type Verdict = { ok: boolean; reason: string; level: "good" | "warn" | "bad" };

/** Reproduces each surface's existing verdict from shared measurements. */
export function legacyVerdict(m: FrameMeasurements, profile: CaptureProfile): Verdict {
  const t = THRESHOLDS[profile];
  if (m.exposure < t.dark) return { ok: false, reason: "Too dark — find better light", level: "bad" };
  if (m.exposure > t.bright) return { ok: false, reason: "Glare — tilt away from the light", level: "bad" };
  if (m.contrast < t.contrast) return { ok: false, reason: "Fill the box with the phone", level: "warn" };
  if (m.sharpness < t.sharp) return { ok: false, reason: "Hold steady — let it focus", level: "warn" };
  return { ok: true, reason: "Sharp — capture it", level: "good" };
}

/** Guidance vocabulary. Recorded in observation mode; not yet shown or enforced. */
export type Instruction =
  | "TOO_DARK"
  | "REDUCE_GLARE"
  | "FILL_THE_BOX"
  | "HOLD_STEADY"
  | "CAPTURE_READY";

/**
 * The single highest-priority correction, ordered by what actually blocks a
 * grade: light first (nothing is recoverable without it), then glare (which
 * hides damage), then framing, then focus.
 *
 * OBSERVATION MODE: this is computed and recorded, never displayed and never
 * used to accept or reject a frame. Its thresholds are guesses until telemetry
 * from real stores says otherwise — which is exactly what Release 1 collects.
 */
export function deriveInstruction(m: FrameMeasurements, profile: CaptureProfile): Instruction {
  const t = THRESHOLDS[profile];
  if (m.exposure < t.dark) return "TOO_DARK";
  // Deliberately below any threshold we would enforce. The point right now is
  // to find out how often real captures carry glare the old mean-brightness
  // test never saw, not to start failing them for it.
  if (m.glareCoverage > 0.06) return "REDUCE_GLARE";
  if (m.contrast < t.contrast) return "FILL_THE_BOX";
  if (m.sharpness < t.sharp || (m.stability !== null && m.stability < 0.85)) return "HOLD_STEADY";
  return "CAPTURE_READY";
}
