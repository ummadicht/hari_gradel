import sharp from "sharp";
import { isUsableCropBox, padBox, mapBoxToOriginal, coverageOf, type Box } from "./cropMap";

// Grade a CROP of each photo, report against the ORIGINAL.
//
// The refinement pass is the one whose grade is persisted, and it is a second
// call that already happens — so re-framing its input costs nothing extra and
// is where the detail actually matters. The stored photo is never modified: the
// crop lives only in the request, and every box that comes back is translated
// to the original's coordinates before anything stores or draws it.
//
// Everything here degrades to "no crop" rather than to a wrong crop.

/** A photo's device box, as the grader reported it. */
export type Placement = { photoIndex: number; box: Box };

/**
 * How far outside the reported device box to cut.
 *
 * The model is asked for the handset's extent, not for a safe margin, and a box
 * drawn tight to the phone's outline would clip the rim — precisely where chips
 * and dents are found. 12% of the box's own size buys that back cheaply.
 */
export const CROP_PAD = 0.12;

export type CropResult = {
  /** Photos to send to the grader — cropped where possible, original otherwise. */
  photos: string[];
  /** Crop applied per photo index, or null where the photo was left alone. */
  applied: (Box | null)[];
  croppedCount: number;
  /** Mean area kept across cropped photos — 0.3 means ~3x the pixel density. */
  meanCoverage: number;
};

async function cropOne(dataUrl: string, box: Box): Promise<string | null> {
  const m = /^data:image\/[a-z+]+;base64,(.*)$/i.exec(dataUrl || "");
  if (!m) return null;
  try {
    const buf = Buffer.from(m[1], "base64");
    if (buf.length < 1024) return null;
    const img = sharp(buf, { failOn: "none" });
    const meta = await img.metadata();
    const W = meta.width ?? 0;
    const H = meta.height ?? 0;
    if (!W || !H) return null;

    const left = Math.max(0, Math.min(W - 1, Math.round(box[1] * W)));
    const top = Math.max(0, Math.min(H - 1, Math.round(box[0] * H)));
    const width = Math.max(1, Math.min(W - left, Math.round((box[3] - box[1]) * W)));
    const height = Math.max(1, Math.min(H - top, Math.round((box[2] - box[0]) * H)));
    // A crop this small is a mis-detection, not a phone.
    if (width < 64 || height < 64) return null;

    const out = await sharp(buf, { failOn: "none" })
      .extract({ left, top, width, height })
      // This is the evidence a grade and a payout rest on — the wrong place to
      // save bytes, and re-encoding at the capture quality would compound loss.
      .jpeg({ quality: 92 })
      .toBuffer();
    return `data:image/jpeg;base64,${out.toString("base64")}`;
  } catch {
    return null;
  }
}

/**
 * Crop each photo to its reported device box.
 *
 * `placements` may cover only some photos (the grader is told to omit photos
 * with no phone in them, such as screen-pattern frames). Anything without a
 * usable box is passed through untouched.
 */
export async function cropPhotosToDevice(
  photos: string[],
  placements: Placement[]
): Promise<CropResult> {
  const byIndex = new Map<number, Box>();
  for (const p of placements ?? []) {
    if (!p || !isUsableCropBox(p.box)) continue;
    byIndex.set(p.photoIndex, padBox(p.box, CROP_PAD));
  }

  const applied: (Box | null)[] = new Array(photos.length).fill(null);
  const out = [...photos];
  let coverage = 0;

  await Promise.all(
    photos.map(async (photo, i) => {
      const box = byIndex.get(i);
      if (!box) return;
      const cropped = await cropOne(photo, box);
      if (!cropped) return; // decode/extract failed → grade the original
      out[i] = cropped;
      applied[i] = box;
      coverage += coverageOf(box);
    })
  );

  const croppedCount = applied.filter(Boolean).length;
  return {
    photos: out,
    applied,
    croppedCount,
    meanCoverage: croppedCount ? coverage / croppedCount : 1,
  };
}

/** Anything carrying located findings — the cascade result, structurally. */
type Findable = {
  findings?: { photoIndex: number; box?: Box }[];
  specialists?: { findings?: { photoIndex: number; box?: Box }[] }[];
};

/**
 * Translate every box from crop coordinates back to the original photo.
 *
 * MUST run before the result is persisted or drawn. A box left in crop
 * coordinates does not error or look empty — it renders a confident damage
 * marker in the wrong place, which is worse than showing nothing.
 *
 * The flat `findings` list holds shallow copies of the specialists' findings,
 * so the two share their `box` ARRAY. New arrays are assigned rather than
 * mutated in place, otherwise remapping both lists would apply the transform
 * twice to the same box.
 */
export function remapFindingsToOriginal<T extends Findable>(result: T, applied: (Box | null)[]): T {
  const fix = (list?: { photoIndex: number; box?: Box }[]) => {
    if (!Array.isArray(list)) return;
    for (const f of list) {
      const crop = applied[f.photoIndex];
      if (!crop || !f.box || f.box.length !== 4) continue;
      f.box = mapBoxToOriginal(f.box, crop);
    }
  };
  fix(result.findings);
  for (const s of result.specialists ?? []) fix(s.findings);
  return result;
}
