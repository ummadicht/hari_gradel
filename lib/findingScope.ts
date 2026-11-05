// Is this mark ON THE PHONE, or on the room behind it?
//
// A finding arrives as a box on a photo, and the report draws it as damage to
// the device. Nothing has ever checked that the box actually lands on the
// device. On a side capture the phone can occupy under a third of the frame,
// and the rest is hand, table and floor — all edge-rich, all perfectly capable
// of being read as a crack. A "body: crack" tag sitting on a tile grout line
// looks exactly as authoritative as one on a bent rail.
//
// Now that the grader reports where the handset is (`deviceBoxes`), the two can
// be compared. This is a LABELLING question, not a filtering one: a mark that
// falls outside the device outline is not automatically wrong — the box may be
// loose, or the phone may extend past what the model outlined — so it is shown
// and flagged rather than deleted. Silently dropping findings would trade one
// invisible error for another.

export type Box = [number, number, number, number]; // [ymin, xmin, ymax, xmax]

/** Scope verdict. "unknown" when there is no device outline to compare against. */
export type FindingScope = "on-device" | "off-device" | "unknown";

/**
 * How much of the device outline must contain the mark before it counts as
 * being on the phone.
 *
 * Half, deliberately loosely. A scratch on the very edge of a rail legitimately
 * straddles the outline, and the outline itself is padded and approximate — so
 * the bar is "mostly on the device", not "entirely within it".
 */
export const ON_DEVICE_MIN = 0.5;

const area = (b: Box) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);

/** Fraction of `inner`'s area that lies inside `outer` (0..1). */
export function fractionInside(inner: Box, outer: Box): number {
  const a = area(inner);
  if (a <= 0) return 0;
  const y0 = Math.max(inner[0], outer[0]);
  const x0 = Math.max(inner[1], outer[1]);
  const y1 = Math.min(inner[2], outer[2]);
  const x1 = Math.min(inner[3], outer[3]);
  if (y1 <= y0 || x1 <= x0) return 0;
  return ((y1 - y0) * (x1 - x0)) / a;
}

const usable = (b: unknown): b is Box =>
  Array.isArray(b) &&
  b.length === 4 &&
  b.every((n) => typeof n === "number" && Number.isFinite(n)) &&
  (b as number[])[2] > (b as number[])[0] &&
  (b as number[])[3] > (b as number[])[1];

/**
 * Where a finding's box sits relative to the handset.
 *
 * Returns "unknown" — never a guess — when either box is missing or malformed.
 * The report says nothing in that case, which is honest: most existing sessions
 * were graded before device outlines were recorded.
 */
export function scopeOf(findingBox: unknown, deviceBox: unknown): FindingScope {
  if (!usable(findingBox) || !usable(deviceBox)) return "unknown";
  return fractionInside(findingBox, deviceBox) >= ON_DEVICE_MIN ? "on-device" : "off-device";
}

/** Index device outlines by the photo they belong to. */
export function deviceBoxByPhoto(
  boxes: { photoIndex: number; box: Box }[] | undefined
): Map<number, Box> {
  const m = new Map<number, Box>();
  for (const b of boxes ?? []) {
    if (Number.isInteger(b?.photoIndex) && usable(b?.box)) m.set(b.photoIndex, b.box);
  }
  return m;
}
