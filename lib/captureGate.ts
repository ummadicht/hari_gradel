/**
 * Capture gate — the shared, deterministic "are these photos actually gradeable"
 * math, used by BOTH the camera (live, per-frame) and the server (authoritative,
 * on submit).
 *
 * Why one module: the browser feeds it `canvas.getImageData`, the server feeds it
 * `sharp(buf).greyscale().raw()`. Same functions, same thresholds — so what the
 * seller was told on-screen and what the server decides can never drift apart.
 *
 * Deliberately dependency-free and pure (no DOM, no sharp, no fetch) so it runs
 * unchanged in both places and is testable against a photo corpus offline.
 *
 * SCOPE — read this before extending it. This module answers two questions only:
 *   1. is there a discrete object in frame at all?  (presence)
 *   2. are these N photos genuinely different views? (distinctness)
 * It CANNOT tell a phone from a similarly-sized book, and it cannot tell which
 * SIDE of a phone it is looking at. "Six shots of the front" is measurably
 * distinct-enough to pass here — naming sides needs the vision model. Keeping the
 * boundary explicit stops callers from believing this is an anti-fraud oracle.
 */

export const SIG_W = 32;
export const SIG_H = 24;

/** Mean abs gradient difference below this = "same view". */
export const DUPLICATE_MAX = 9;
/** Minimum distinct view-clusters across the set. */
export const DISTINCT_MIN = 3;
/** Below this presence score a frame is treated as "nothing in front of the lens". */
export const PRESENCE_MIN = 0.3;
/**
 * Laplacian-variance sharpness below this = too blurry to grade that photo.
 * Calibrated against the production photo corpus (see the calibration run in
 * the capture-gate work): genuine seller shots sit well above it, motion-blurred
 * and out-of-focus frames fall below.
 */
export const SHARP_MIN = 60;

export type Gray = { data: Uint8Array | Uint8ClampedArray; w: number; h: number };

/**
 * Perceptual signature in the GRADIENT domain, not raw luma.
 *
 * Raw luma was the original approach and it false-rejects a real, common case: a
 * seller shooting a cracked screen under a single lamp. The specular highlight is
 * stationary relative to the CAMERA while the phone rotates, so on a raw-luma
 * signature that fixed bright blob dominates the comparison and two genuinely
 * different sides read as "the same view". Differentiating first removes the flat
 * bright region and keeps the structure (edges, corners, camera bumps) that
 * actually distinguishes one side from another.
 */
export function signatureFrom(g: Gray): Uint8Array {
  const small = resizeGray(g, SIG_W, SIG_H);
  const out = new Uint8Array(SIG_W * SIG_H);
  for (let y = 0; y < SIG_H; y++) {
    for (let x = 0; x < SIG_W; x++) {
      const i = y * SIG_W + x;
      const right = x + 1 < SIG_W ? small[i + 1] : small[i];
      const down = y + 1 < SIG_H ? small[i + SIG_W] : small[i];
      const gx = right - small[i];
      const gy = down - small[i];
      // |gx|+|gy| approximates the gradient magnitude without a sqrt, and stays
      // in 0..255 after the clamp — cheap enough for a 200ms camera loop.
      out[i] = Math.min(255, Math.abs(gx) + Math.abs(gy));
    }
  }
  return out;
}

/** Mean-normalised absolute difference. 0 = identical, higher = more different. */
export function sigDiff(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length || a.length === 0) return 999;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < a.length; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= a.length;
  mb /= b.length;
  // Subtracting each signature's own mean makes the comparison invariant to an
  // overall brightness/contrast shift (walking into shade mid-capture), so only
  // STRUCTURAL change counts as a new view.
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - ma - (b[i] - mb));
  return s / a.length;
}

/**
 * How strongly a discrete object occupies the frame, 0..1.
 *
 * An empty wall, a ceiling, a desk surface or a lens cap all produce a nearly
 * uniform field: almost no gradient energy, and what there is spreads evenly. A
 * phone held up to fill the guide box produces concentrated edge energy with
 * clear boundaries. This measures the CENTRE crop only, matching the on-screen
 * guide rectangle — a busy background outside the box must not rescue an empty
 * centre.
 */
export function presenceFrom(g: Gray): number {
  const crop = centreCrop(g, 0.6, 0.56);
  const sig = signatureFrom(crop);
  let sum = 0;
  let strong = 0;
  for (let i = 0; i < sig.length; i++) {
    sum += sig[i];
    if (sig[i] > 24) strong++;
  }
  const meanEnergy = sum / sig.length; // texture amount
  const coverage = strong / sig.length; // how much of the box has structure
  // Both must be present: a noisy-but-flat surface (carpet, wood grain) has
  // energy without structure; a single hard line has structure without spread.
  const e = clamp01(meanEnergy / 18);
  const c = clamp01(coverage / 0.22);
  return Math.sqrt(e * c);
}

export type SetVerdict = {
  ok: boolean;
  code: "ok" | "no_device" | "duplicate_views" | "incomplete" | "undecodable" | "blurry";
  reasons: string[];
  /** Per-photo presence scores, for diagnostics. */
  presence: number[];
  /** Per-photo sharpness (Laplacian variance). Below SHARP_MIN = blurry. */
  sharpness: number[];
  /** Indices of photos too blurry to grade — surfaced so the UI can point at them. */
  blurryIndexes: number[];
  /** How many genuinely distinct views the set contains. */
  distinctViews: number;
};

/**
 * Focus measure: variance of the Laplacian over the frame.
 *
 * A sharp photo has strong high-frequency edge energy; blur flattens it. This is
 * the same measure the live camera loop uses to gate a shot, re-run server-side
 * so an uploaded or manually-shuttered blurry frame can't slip past the client.
 */
export function sharpnessOf(g: Gray): number {
  const { data: d, w, h } = g;
  if (w < 3 || h < 3) return 0;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = 4 * d[i] - d[i - 1] - d[i + 1] - d[i - w] - d[i + w];
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  if (!n) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

/**
 * Judge a whole capture set.
 *
 * Thresholds are deliberately one-sided: a legitimate seller who frames one angle
 * poorly should still get through, because the cost of a false reject (an honest
 * seller abandons) is much higher than one weak photo in an otherwise good set.
 * So "no device" needs near-unanimity, not a single bad frame.
 */
export function judgeSet(
  sigs: Uint8Array[],
  presence: number[],
  expected: number,
  sharpness: number[] = [],
): SetVerdict {
  const reasons: string[] = [];
  const n = sigs.length;

  if (n === 0) {
    return { ok: false, code: "undecodable", reasons: ["No usable photos were received."], presence, sharpness, blurryIndexes: [], distinctViews: 0 };
  }
  if (n < Math.min(expected, 4)) {
    return {
      ok: false,
      code: "incomplete",
      reasons: [`Only ${n} of ${expected} angles came through — retake the full set.`],
      presence,
      sharpness,
      blurryIndexes: [],
      distinctViews: 0,
    };
  }

  // Which frames are too soft to grade? Reported per-photo either way so the UI
  // can point at the blurry ones instead of just saying "retake".
  const blurryIndexes = sharpness
    .map((v, i) => (v < SHARP_MIN ? i : -1))
    .filter((i) => i >= 0);

  // ── Is there a phone in front of the lens at all? ──
  // Near-unanimity: one dark or badly-framed angle is normal, a whole set of them
  // means the camera was never pointed at a device.
  const empty = presence.filter((p) => p < PRESENCE_MIN).length;
  const emptyLimit = Math.max(1, n - 1);
  if (empty >= emptyLimit) {
    reasons.push("We couldn't find a phone in these photos — hold the phone inside the frame and try again.");
    return { ok: false, code: "no_device", reasons, presence, sharpness, blurryIndexes, distinctViews: 0 };
  }

  // ── Too blurry to grade? ──
  // A soft photo hides exactly what we're looking for (hairlines, micro-scuffs),
  // so a mostly-blurry set must go back for a retake rather than be graded
  // optimistically. One soft frame in an otherwise sharp set is tolerated.
  if (sharpness.length && blurryIndexes.length > Math.max(1, Math.floor(n / 3))) {
    reasons.push(
      `${blurryIndexes.length} of ${n} photos are too blurry to grade — hold the phone steady, let the camera focus, and retake.`,
    );
    return { ok: false, code: "blurry", reasons, presence, sharpness, blurryIndexes, distinctViews: 0 };
  }

  // ── Are these actually different views? ──
  // Single-link clustering: photos closer than DUPLICATE_MAX collapse together.
  const distinctViews = countClusters(sigs);
  if (distinctViews < Math.min(DISTINCT_MIN, n)) {
    reasons.push(
      distinctViews <= 1
        ? "Every photo shows the same side — turn the phone between shots."
        : `Only ${distinctViews} different sides came through — turn the phone so each angle is a new view.`,
    );
    return { ok: false, code: "duplicate_views", reasons, presence, sharpness, blurryIndexes, distinctViews };
  }

  return { ok: true, code: "ok", reasons: [], presence, sharpness, blurryIndexes, distinctViews };
}

/** Single-link clustering over the pairwise signature distance. */
export function countClusters(sigs: Uint8Array[]): number {
  const n = sigs.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (sigDiff(sigs[i], sigs[j]) < DUPLICATE_MAX) {
        const a = find(i);
        const b = find(j);
        if (a !== b) parent[a] = b;
      }
    }
  }
  return new Set(Array.from({ length: n }, (_, i) => find(i))).size;
}

// ---- helpers ----

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Nearest-neighbour box resize — fast, and adequate at these tiny sizes. */
function resizeGray(g: Gray, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(g.h - 1, Math.floor((y * g.h) / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(g.w - 1, Math.floor((x * g.w) / w));
      out[y * w + x] = g.data[sy * g.w + sx];
    }
  }
  return out;
}

function centreCrop(g: Gray, fw: number, fh: number): Gray {
  const cw = Math.max(1, Math.round(g.w * fw));
  const ch = Math.max(1, Math.round(g.h * fh));
  const x0 = Math.floor((g.w - cw) / 2);
  const y0 = Math.floor((g.h - ch) / 2);
  const out = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) out[y * cw + x] = g.data[(y0 + y) * g.w + (x0 + x)];
  }
  return { data: out, w: cw, h: ch };
}
