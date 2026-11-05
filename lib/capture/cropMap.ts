// Coordinate maths for grading a CROP of a photo while reporting against the
// ORIGINAL photo.
//
// WHY THIS EXISTS. On a side angle the phone can occupy under a third of the
// frame; the rest is hand, table and room. The grader downsamples what it is
// given, so a hairline that was already faint is sub-pixel before anything
// looks at it, and the surrounding texture is free to be read as damage on the
// device. Grading a crop fixes both.
//
// The catch is that every finding comes back with a box measured against the
// CROP, while the stored photo — the one the report draws on — is the original.
// Publish those numbers unchanged and every damage marker silently lands in the
// wrong place: a mark on the phone's edge would be drawn somewhere out in the
// background. That is worse than not drawing it, because it looks authoritative.
//
// So the crop is applied in memory only, the stored photo is never touched, and
// every box the grader returns is mapped back through here first.
//
// BOX FORMAT, matching the rest of the pipeline: [ymin, xmin, ymax, xmax],
// normalised 0..1.

export type Box = [number, number, number, number];

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Is this a box we are willing to crop to?
 *
 * A model can return a degenerate, inverted or absurd box, and cropping to one
 * would hand the grader a sliver of a phone and call it the whole device. The
 * caller treats `false` as "grade this photo uncropped", which is exactly the
 * behaviour we had before — so rejecting is always safe.
 */
export function isUsableCropBox(b: unknown): b is Box {
  if (!Array.isArray(b) || b.length !== 4) return false;
  const [y0, x0, y1, x1] = b as number[];
  if (![y0, x0, y1, x1].every((v) => typeof v === "number" && Number.isFinite(v))) return false;
  if (![y0, x0, y1, x1].every((v) => v >= -0.02 && v <= 1.02)) return false;
  const h = y1 - y0;
  const w = x1 - x0;
  // Inverted or empty.
  if (h <= 0 || w <= 0) return false;
  // Too small to be a phone that fills a guide box — almost certainly a
  // misfire, and cropping to it would cut most of the device away.
  if (h < 0.08 || w < 0.08) return false;
  // Already essentially the whole frame: cropping buys nothing and only risks
  // shaving an edge, so leave the photo alone.
  if (h > 0.96 && w > 0.96) return false;
  return true;
}

/**
 * Grow a box outward by `pad` (a fraction of its own size) and clamp to frame.
 *
 * The model is asked for the device's extent, not a safety margin, and a box
 * drawn tight to the edges of a phone will clip the very rim where chips and
 * dents live. Padding is proportional so a narrow edge-on shot gets a narrow
 * margin rather than a fixed slab of background.
 */
export function padBox(b: Box, pad: number): Box {
  const [y0, x0, y1, x1] = b;
  const dy = (y1 - y0) * pad;
  const dx = (x1 - x0) * pad;
  return [clamp01(y0 - dy), clamp01(x0 - dx), clamp01(y1 + dy), clamp01(x1 + dx)];
}

/**
 * Translate a box measured inside a crop back to the original photo's frame.
 *
 * `inner` is relative to the cropped image (0..1 of the CROP); `crop` is where
 * that crop sits in the original (0..1 of the ORIGINAL). The result is relative
 * to the original, ready to draw on the stored photo.
 */
export function mapBoxToOriginal(inner: Box, crop: Box): Box {
  const [cy0, cx0, cy1, cx1] = crop;
  const ch = cy1 - cy0;
  const cw = cx1 - cx0;
  const [iy0, ix0, iy1, ix1] = inner;
  return [
    clamp01(cy0 + iy0 * ch),
    clamp01(cx0 + ix0 * cw),
    clamp01(cy0 + iy1 * ch),
    clamp01(cx0 + ix1 * cw),
  ];
}

/** Fraction of the original frame a crop keeps — used to report the gain. */
export function coverageOf(b: Box): number {
  return (b[2] - b[0]) * (b[3] - b[1]);
}
