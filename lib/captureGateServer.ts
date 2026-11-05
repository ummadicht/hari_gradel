import sharp from "sharp";
import { judgeSet, presenceFrom, sharpnessOf, signatureFrom, type SetVerdict } from "./captureGate";

/**
 * Server-side half of the capture gate: decode the submitted data URLs and run
 * the SAME pure math the camera ran live (lib/captureGate.ts).
 *
 * This is the authoritative check. The camera's copy exists only to steer the
 * seller during capture — `/api/sessions/[id]/cosmetic` is unauthenticated and
 * the session id is displayed on screen for the seller to type, so anything the
 * browser decides is advisory at best. Six copies of one JPEG posted with curl
 * must fail here.
 *
 * Runs BEFORE the vision cascade, so a rejected set costs zero Gemini quota —
 * which matters, because quota exhaustion is what makes the AI layer fail open.
 */

// Decode big enough to MEASURE FOCUS. Presence and the view signature both
// downscale internally (to 32x24), so a larger source costs little — but blur
// only exists at high frequencies, and decoding straight to 96x72 aliased it
// away: a heavily blurred photo still scored "sharp" because the downsample
// re-created hard edges. Sharpness must be measured near full detail.
const DECODE_W = 320;
const DECODE_H = 240;

async function toGray(dataUrl: string) {
  const m = /^data:image\/[a-z+]+;base64,(.*)$/i.exec(dataUrl);
  if (!m) return null;
  const buf = Buffer.from(m[1], "base64");
  // Real uploads include 1–4 byte writes from interrupted posts; sharp throws on
  // those rather than returning a blank, so a decode failure is expected traffic,
  // not an exceptional case.
  if (buf.length < 1024) return null;
  try {
    const { data, info } = await sharp(buf)
      .greyscale()
      .resize(DECODE_W, DECODE_H, { fit: "fill" })
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { data: new Uint8Array(data), w: info.width, h: info.height };
  } catch {
    return null;
  }
}

export type CaptureVerdict = SetVerdict & {
  /** How many submitted photos could not be decoded at all. */
  undecodable: number;
};

export async function evaluateCapture(
  photos: string[],
  expected = 6,
): Promise<CaptureVerdict> {
  const grays = await Promise.all(photos.map(toGray));
  const usable = grays.filter((g): g is NonNullable<typeof g> => g !== null);
  const undecodable = grays.length - usable.length;

  if (usable.length === 0) {
    return {
      ok: false,
      code: "undecodable",
      reasons: ["None of the photos came through — please retake them."],
      presence: [],
      sharpness: [],
      blurryIndexes: [],
      distinctViews: 0,
      undecodable,
    };
  }

  const sigs = usable.map(signatureFrom);
  const presence = usable.map(presenceFrom);
  // Focus is measured on the full-resolution grayscale, not the tiny signature —
  // downscaling destroys exactly the high-frequency detail blur removes.
  const sharpness = usable.map(sharpnessOf);
  return { ...judgeSet(sigs, presence, expected, sharpness), undecodable };
}
