import fs from "node:fs";
import path from "node:path";
import { visionJSON } from "./visionProvider";

/**
 * Optical assessment of the still frames captured during the camera test.
 *
 * The functional test proves a lens produces a varying image. That is a
 * LIVENESS check and it passes a camera whose cover is cracked, whose sensor is
 * dusty, or whose focus motor is dead — all of which produce a perfectly
 * varying picture. Looking at the frame is the only way to tell.
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE:
 * most defects visible in a camera frame are NOT hardware faults.
 *
 *   a fingerprint on the lens   → wipe it
 *   a blurry frame              → the hand moved, or it never focused
 *   a dark frame                → a finger over the lens, or a dark room
 *   a cracked cover / dead sensor / stuck focus → a real fault
 *
 * Conflating those fails good phones and costs the seller money. So the schema
 * forces the model to classify EVERY finding as `cleanable`, `retake` or
 * `fault`, and only `fault` is allowed to mean the camera is broken. A blurry
 * frame is never, on its own, evidence of a hardware problem.
 *
 * Deferred by design: this runs AFTER the functional test has finished and its
 * results are already recorded, so a slow or failed vision call never delays or
 * blocks the test. A camera with no assessment reads as "not assessed", which
 * is not the same as "clean".
 */

export type CameraFrame = { lensId: string; name: string; facing: string; url: string };

export type LensFinding = {
  /** What is visible. */
  type: "haze" | "smudge" | "dust" | "crack" | "blur" | "colour_cast" | "dark" | "obstruction";
  /** Whether it means the CAMERA is faulty — the whole point of the module. */
  impact: "cleanable" | "retake" | "fault";
  note: string;
  confidence: number;
};

export type LensAssessment = {
  lensId: string;
  /** "not_assessed" is a real, distinct answer — never fold it into "clear". */
  verdict: "clear" | "degraded" | "faulty" | "not_assessed";
  findings: LensFinding[];
};

export type CameraAssessment = {
  lenses: LensAssessment[];
  model: string | null;
  at: string;
};

const SCHEMA = {
  type: "OBJECT",
  properties: {
    lenses: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          lensId: { type: "STRING" },
          verdict: { type: "STRING", enum: ["clear", "degraded", "faulty", "not_assessed"] },
          findings: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                type: {
                  type: "STRING",
                  enum: ["haze", "smudge", "dust", "crack", "blur", "colour_cast", "dark", "obstruction"],
                },
                impact: { type: "STRING", enum: ["cleanable", "retake", "fault"] },
                note: { type: "STRING" },
                confidence: { type: "NUMBER" },
              },
              required: ["type", "impact"],
            },
          },
        },
        required: ["lensId", "verdict"],
      },
    },
  },
  required: ["lenses"],
} as const;

function buildPrompt(frames: CameraFrame[]): string {
  const manifest = frames
    .map((f, i) => `Photo index ${i}: lensId="${f.lensId}" — ${f.name} (${f.facing}-facing)`)
    .join("\n");

  return `You are inspecting TEST PHOTOGRAPHS TAKEN BY a phone's own cameras, to judge whether each camera still takes an acceptable picture.

You are NOT grading the phone's condition, and you are NOT judging what the photo is OF. The subject is irrelevant — a counter, a hand, a ceiling, a face. Judge only the OPTICAL QUALITY of the image.

${manifest}

For each lensId, decide a verdict and list what you can see:
- "clear"        — the image is usable; nothing suggests an optical problem.
- "degraded"     — something is visibly wrong with the image quality.
- "faulty"       — the image shows evidence the CAMERA HARDWARE is damaged.
- "not_assessed" — you cannot judge it (no usable image supplied for that lens).

CLASSIFY EVERY FINDING BY IMPACT. This matters more than the finding itself:
- "cleanable" — a fingerprint, smudge or haze on the outside of the lens. The
  camera is fine; the glass needs a wipe. NEVER call this a fault.
- "retake"    — motion blur, a finger over the lens, or a dark room. This is how
  the photo was taken, not what the camera is. NEVER call this a fault.
- "fault"     — a CRACKED lens cover, debris sealed INSIDE the lens, a stuck or
  non-existent focus (uniformly soft across the whole frame with no motion
  streaking), a strong colour cast affecting the entire image, or a dead/black
  sensor output. Only these mean the camera is broken.

Blur alone is never a fault. Distinguish motion blur (directional streaking,
sharp elsewhere) from a focus failure (uniformly soft everywhere). If you cannot
tell them apart, use "retake" — the cheaper, reversible conclusion.

A dark frame is "retake" unless the image is entirely black with no structure at
all, which is "fault".

If no usable photo was supplied for a lens, return verdict "not_assessed" for it
with no findings. Never infer that an unassessed camera is clear.

Return STRICT JSON only.`;
}

/**
 * Assess a set of captured lens frames. Returns null when there is nothing to
 * assess or the vision call fails — the caller stores nothing rather than
 * storing a fabricated "clear".
 */
export async function assessCameraFrames(
  frames: CameraFrame[]
): Promise<CameraAssessment | null> {
  const usable = frames.filter((f) => f?.url);
  if (!usable.length) return null;

  /**
   * visionJSON takes DATA URLS, not paths — `splitDataUrl` returns null for a
   * `/api/uploads/…` string and the image is silently dropped. Passing stored
   * paths therefore sends the model a prompt with zero pictures attached, and
   * it answers about nothing. Read the bytes here, exactly as the cosmetic
   * route does before grading.
   */
  const loaded: { frame: CameraFrame; dataUrl: string }[] = [];
  for (const f of usable) {
    const name = f.url.split("/").pop() || "";
    try {
      const buf = fs.readFileSync(path.join(process.cwd(), "data", "uploads", name));
      const mime = name.endsWith(".png")
        ? "image/png"
        : name.endsWith(".webp")
          ? "image/webp"
          : "image/jpeg";
      loaded.push({ frame: f, dataUrl: `data:${mime};base64,${buf.toString("base64")}` });
    } catch {
      /* a frame whose file is gone is simply not assessed */
    }
  }
  if (!loaded.length) return null;

  // Its OWN schema — visionJSON defaults to the cosmetic one, which has no
  // `lenses` field and would silently constrain this response into a shape
  // that can never contain the answer.
  const res = await visionJSON(
    buildPrompt(loaded.map((l) => l.frame)),
    loaded.map((l) => l.dataUrl),
    "pro",
    undefined,
    SCHEMA
  );
  const out = res.json as { lenses?: unknown[] } | null;
  if (!out || !Array.isArray(out.lenses)) return null;

  const known = new Set(loaded.map((l) => l.frame.lensId));
  const lenses: LensAssessment[] = [];
  for (const raw of out.lenses.slice(0, 8)) {
    const l = raw as Record<string, unknown>;
    const lensId = String(l.lensId ?? "");
    // A lens the model invented cannot be matched to a frame, and a verdict
    // about a lens nobody photographed is worse than no verdict.
    if (!known.has(lensId)) continue;
    const verdict = ["clear", "degraded", "faulty", "not_assessed"].includes(String(l.verdict))
      ? (l.verdict as LensAssessment["verdict"])
      : "not_assessed";
    const findings = Array.isArray(l.findings)
      ? (l.findings as Record<string, unknown>[]).slice(0, 5).map((f) => ({
          type: String(f.type ?? "haze") as LensFinding["type"],
          impact: (["cleanable", "retake", "fault"].includes(String(f.impact))
            ? f.impact
            : "retake") as LensFinding["impact"],
          note: String(f.note ?? "").slice(0, 160),
          confidence: typeof f.confidence === "number" ? f.confidence : 0.6,
        }))
      : [];
    lenses.push({ lensId, verdict, findings });
  }

  // Any lens we sent but the model ignored is explicitly unassessed, not clear.
  for (const { frame: f } of loaded) {
    if (!lenses.some((l) => l.lensId === f.lensId)) {
      lenses.push({ lensId: f.lensId, verdict: "not_assessed", findings: [] });
    }
  }

  return { lenses, model: res.model, at: new Date().toISOString() };
}

/** Schema export so the provider layer can constrain the response. */
export const CAMERA_ASSESS_SCHEMA = SCHEMA;

/**
 * Does this assessment justify calling the camera FAULTY?
 *
 * Deliberately strict: only a finding explicitly classified `fault` counts. A
 * lens covered in fingerprints and a lens with a cracked cover both look bad in
 * a photograph, and only one of them is worth money.
 */
export function hasCameraFault(a: CameraAssessment | null | undefined): boolean {
  if (!a) return false;
  return a.lenses.some(
    (l) => l.verdict === "faulty" || l.findings.some((f) => f.impact === "fault")
  );
}
