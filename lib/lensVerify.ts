// Verify the lenses the BROWSER CANNOT REACH.
//
// THE PROBLEM. `enumerateDevices()` exposes camera DEVICES, not lenses. On an
// iPhone 13 Pro Max — four lenses — Safari returns one back camera, so the
// automatic test can only ever prove that *a* rear camera works. The ultrawide
// and telephoto come back "manual": never tested, and on a real session that
// meant a person tapped Working or Faulty from memory. A vendor tool finds
// these faults because it runs native code; we cannot, and pretending otherwise
// is how a broken telephoto ships as a clean report.
//
// WHAT CAN REACH THEM. The phone's own camera UI can. `<input type="file"
// capture="environment">` opens it, and the seller switches 0.5× / 1× / 3×
// themselves — so the OPTICS are genuinely exercised even though our code never
// touches them. What comes back is three photos of one scene, and the question
// becomes: do these pictures prove the phone switched lenses?
//
// HOW IT IS JUDGED. Field of view. Shot at the same spot, a true ultrawide
// frame is visibly wider than the 1× and the 3× visibly tighter. The model is
// asked only to MEASURE each frame's field of view; whether that ordering is
// consistent is decided here, in code that can be tested, rather than by asking
// a model to reach a conclusion.
//
// THE FAILURE MODE THAT MATTERS. When a telephoto is dead, iOS silently falls
// back to a digital crop of the wide sensor — you still get a "3×" picture. So
// a frame at the right field of view is NOT proof the lens works, and a frame
// at the WRONG field of view is not proof it is broken either (the seller may
// simply not have switched). Both land on "unverified". Only a defect the model
// can actually see — a crack, heavy haze, a dead frame — is allowed to fail a
// lens. Unverified is an honest answer; a wrong "faulty" costs someone money.

/** Impact vocabulary shared with cameraAssess: only `fault` means broken. */
export type LensImpact = "cleanable" | "retake" | "fault";

export type LensFinding = {
  type: "haze" | "smudge" | "dust" | "crack" | "blur" | "colour_cast" | "dark" | "obstruction";
  impact: LensImpact;
  note: string;
  confidence: number;
};

/** One photo the seller took, with the zoom they were asked to use. */
export type ZoomShot = {
  lensId: string;
  /** Human label for the step, e.g. "Ultra-wide (0.5×)". */
  label: string;
  /** Declared optical zoom. Smaller = wider field of view. */
  zoom: number;
};

/** What the model reports per photo. Measurements only — no verdicts. */
export type ShotRead = {
  index: number;
  /** Relative field of view, 0..100. LARGER = WIDER. */
  fieldOfView: number;
  sharp: boolean;
  /** Whether this frame shows the same scene as the others. */
  sameScene: boolean;
  findings: LensFinding[];
};

export type LensVerdict = {
  lensId: string;
  /** `unverified` is a first-class outcome, not a soft failure. */
  state: "pass" | "fail" | "unverified";
  reason: string;
  findings: LensFinding[];
};

/**
 * How much wider a shot must be than the next one in to count as a real optical
 * step, on the 0..100 field-of-view scale.
 *
 * Generous on purpose. Two frames a few points apart are within the model's
 * own measurement noise, and treating that as "the lens switched" would hand
 * out passes for digital crops.
 */
export const FOV_MARGIN = 8;

export const LENS_VERIFY_SCHEMA = {
  type: "OBJECT",
  properties: {
    shots: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          index: { type: "INTEGER" },
          fieldOfView: { type: "NUMBER" },
          sharp: { type: "BOOLEAN" },
          sameScene: { type: "BOOLEAN" },
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
        required: ["index"],
      },
    },
  },
  required: ["shots"],
} as const;

export function buildLensPrompt(shots: ZoomShot[]): string {
  const list = shots.map((s, i) => `Photo ${i}: taken at ${s.zoom}× (${s.label})`).join("\n");
  return `You are checking a used phone's CAMERA LENSES. The seller photographed the SAME scene several times, changing the zoom between shots so a different lens is used each time:

${list}

For EACH photo report measurements only — do not decide whether a lens is faulty:
- "fieldOfView": how much of the scene the frame covers, 0..100, where LARGER means WIDER. Judge it RELATIVE to the other photos: whichever shows the most of the scene gets the highest number. This is the whole point of the exercise, so be careful and consistent.
- "sameScene": true if this is recognisably the same subject/place as the other photos. False if the seller pointed somewhere else — those photos cannot be compared.
- "sharp": true if the frame is in focus.
- "findings": anything visible ON THE LENS or sensor, each with a "confidence" from 0 to 1. Classify EVERY finding:
    "cleanable" — a fingerprint, smudge or dust that wiping fixes. NOT a fault.
    "retake"    — the photo is bad: motion blur, a finger over the lens, too dark. NOT a fault.
    "fault"     — real hardware damage: a cracked or shattered lens cover, deep internal haze, a dead or heavily discoloured sensor.
  Reserve "fault" for damage you can actually SEE. A soft or dark photo is a retake, never a fault — a person loses money when a good camera is called broken.

Return STRICT JSON: {"shots":[{"index":0,"fieldOfView":0,"sharp":true,"sameScene":true,"findings":[{"type":"","impact":"","note":"","confidence":0}]}]}`;
}

const IMPACTS: readonly LensImpact[] = ["cleanable", "retake", "fault"];

/**
 * A "fault" fails a CRITICAL test — Faulty grade plus a camera repair
 * deduction — so it has to be one the model stands behind. Below this
 * confidence (or with no confidence at all) it is treated as "retake": the lens
 * lands on unverified and a person looks, which is what ambiguity calls for.
 */
export const FAULT_MIN_CONFIDENCE = 0.6;

/**
 * The model's answer, reduced to the shape judgeLensShots relies on.
 *
 * The schema requires only `index`, so a perfectly valid response can omit
 * `findings` — and `worst()` would then call `.some` on undefined and turn the
 * seller's lens check into a 500. Every field is defaulted toward the SAFE
 * side: a missing measurement can only lead to "unverified", never to a pass
 * or a fail, and a finding with an unknown impact is dropped rather than
 * guessed at (only "fault" may fail a lens, and it must be said outright and
 * with confidence — see FAULT_MIN_CONFIDENCE).
 */
export function normaliseShotReads(raw: unknown): ShotRead[] {
  if (!Array.isArray(raw)) return [];
  const out: ShotRead[] = [];
  for (const r of raw as any[]) {
    if (!r || !Number.isInteger(r.index)) continue;
    const findings: LensFinding[] = Array.isArray(r.findings)
      ? r.findings
          .filter((f: any) => f && IMPACTS.includes(f.impact))
          .map((f: any) => {
            // 0..1 — but a model that answers in percent (85) must not slip a 30%
            // "fault" past the floor as 30, so a value above 1 is read as percent.
            const raw = typeof f.confidence === "number" && Number.isFinite(f.confidence) ? f.confidence : 0;
            const confidence = Math.max(0, Math.min(1, raw > 1 ? raw / 100 : raw));
            const impact: LensImpact =
              f.impact === "fault" && confidence < FAULT_MIN_CONFIDENCE ? "retake" : f.impact;
            return {
              type: String(f.type ?? "obstruction") as LensFinding["type"],
              impact,
              note: typeof f.note === "string" ? f.note : "",
              confidence,
            };
          })
      : [];
    out.push({
      index: r.index,
      // NaN never clears FOV_MARGIN, so an unmeasured frame stays unverified.
      fieldOfView: typeof r.fieldOfView === "number" && Number.isFinite(r.fieldOfView) ? r.fieldOfView : NaN,
      // Unstated sharpness is not sharpness — "too soft to judge", not a pass.
      sharp: r.sharp === true,
      sameScene: r.sameScene !== false,
      findings,
    });
  }
  return out;
}

const worst = (f: LensFinding[]): LensImpact | null =>
  f.some((x) => x.impact === "fault")
    ? "fault"
    : f.some((x) => x.impact === "retake")
      ? "retake"
      : f.some((x) => x.impact === "cleanable")
        ? "cleanable"
        : null;

/**
 * Turn measurements into per-lens verdicts.
 *
 * Order of precedence matters, and it is deliberately biased toward NOT failing
 * a lens:
 *   1. A visible hardware defect fails the lens — the only thing that can.
 *      A photo flagged for retaking → unverified (it proves nothing).
 *   2. Frames of different scenes cannot be compared → unverified.
 *   3. The field-of-view ordering must match the declared zooms → otherwise
 *      unverified, because a dead telephoto and a seller who forgot to switch
 *      look identical from here.
 *   4. Otherwise the optics demonstrably changed → pass.
 */
export function judgeLensShots(shots: ZoomShot[], reads: ShotRead[]): LensVerdict[] {
  const byIndex = new Map<number, ShotRead>();
  for (const r of reads ?? []) if (Number.isInteger(r?.index)) byIndex.set(r.index, r);

  // Compare in zoom order, widest first, regardless of capture order.
  const order = shots
    .map((s, i) => ({ s, i, read: byIndex.get(i) }))
    .sort((a, b) => a.s.zoom - b.s.zoom);

  const anyMissing = order.some((o) => !o.read);
  const scenesDiffer = order.some((o) => o.read && o.read.sameScene === false);

  return order.map((o, pos) => {
    const base = { lensId: o.s.lensId, findings: o.read?.findings ?? [] };

    if (!o.read) {
      return { ...base, state: "unverified" as const, reason: "No reading returned for this shot." };
    }

    // 1. A defect we can see is the ONLY thing allowed to fail a lens.
    const w = worst(o.read.findings);
    if (w === "fault") {
      const f = o.read.findings.find((x) => x.impact === "fault");
      return { ...base, state: "fail" as const, reason: f?.note || "Visible lens damage." };
    }

    // 1b. A photo the model says needs retaking (motion blur, a finger over the
    // lens, too dark — or a fault it was not confident of) cannot prove the
    // optics either way. Never a fail; never a pass either.
    if (w === "retake") {
      const f = o.read.findings.find((x) => x.impact === "retake");
      return {
        ...base,
        state: "unverified" as const,
        reason: `This shot needs retaking${f?.note ? ` — ${f.note}` : ""}. Not proof of a fault.`,
      };
    }

    // 2. Different scenes → the comparison this rests on is not available.
    if (scenesDiffer) {
      return {
        ...base,
        state: "unverified" as const,
        reason: "The photos show different scenes, so the lenses cannot be compared. Retake them from one spot.",
      };
    }
    if (anyMissing) {
      return { ...base, state: "unverified" as const, reason: "The set is incomplete." };
    }

    // 3. Field of view must actually step down as the zoom goes up.
    const next = order[pos + 1];
    const prev = order[pos - 1];
    const widerThanNext = !next || !next.read || o.read.fieldOfView - next.read.fieldOfView >= FOV_MARGIN;
    const narrowerThanPrev =
      !prev || !prev.read || prev.read.fieldOfView - o.read.fieldOfView >= FOV_MARGIN;

    if (!widerThanNext || !narrowerThanPrev) {
      return {
        ...base,
        state: "unverified" as const,
        // Named precisely, because this is the interesting case: it is what a
        // digital-crop fallback looks like AND what forgetting to switch looks
        // like, and we cannot tell them apart from a picture.
        reason:
          "The field of view did not change between shots — either the zoom was not switched, or the phone fell back to cropping another lens. Not proof of a fault.",
      };
    }

    if (!o.read.sharp) {
      return { ...base, state: "unverified" as const, reason: "Too soft to judge — retake this shot." };
    }

    return {
      ...base,
      state: "pass" as const,
      reason:
        w === "cleanable"
          ? "Optics confirmed. Marks on the glass wipe off — not a fault."
          : "Optics confirmed: the field of view changed as expected and the frame is clean.",
    };
  });
}

/** A lens as stored on the session's camera record. */
export type StoredLens = {
  id: string;
  name?: string;
  facing?: string;
  state?: "pass" | "fail" | "manual" | string;
  by?: "browser" | "operator" | "vision" | string;
  [k: string]: unknown;
};

export type AppliedVerdict = LensVerdict & { kept?: "browser" | "operator" };

/**
 * Merge photo verdicts into the stored lens record.
 *
 * A photo check may only make a MEASURED lens worse — never better, never
 * vaguer:
 *   • an operator's pass/fail is a person's judgement — it stands;
 *   • a browser FAIL stands: an inconclusive photo set used to turn it into
 *     "manual", which quietly dropped the camera repair deduction;
 *   • a browser PASS is only a pixel-variance check (it passes a cracked or
 *     dusty cover), so a photo FAIL — which judgeLensShots reaches only from a
 *     confident, visible fault — overrides it; "pass" or "unverified" from the
 *     photos leaves it alone.
 * Everything else (manual, absent, an earlier vision verdict) takes the photo
 * verdict, with "unverified" stored as the existing "manual" state.
 *
 * Returns the new lens list and the verdicts AS STORED, so the seller's screen
 * shows what the record says rather than what was merely proposed.
 */
export function applyLensVerdicts(
  prior: StoredLens[],
  verdicts: LensVerdict[],
  at: string,
): { lenses: StoredLens[]; applied: AppliedVerdict[] } {
  const lenses = prior.map((l) => ({ ...l }));
  const applied: AppliedVerdict[] = [];
  for (const v of verdicts) {
    const i = lenses.findIndex((l) => l?.id === v.lensId);
    const was = i >= 0 ? lenses[i] : null;
    const measured = was && (was.state === "pass" || was.state === "fail") ? (was.state as "pass" | "fail") : null;
    const keep =
      (was?.by === "operator" && measured !== null) ||
      (was?.by === "browser" && measured === "fail") ||
      (was?.by === "browser" && measured === "pass" && v.state !== "fail");
    if (keep && was && measured) {
      applied.push({
        ...v,
        state: measured,
        reason: was.by === "operator" ? "Marked by the operator." : "Measured on the device.",
        kept: was.by as "browser" | "operator",
      });
      continue;
    }
    const state = v.state === "pass" ? "pass" : v.state === "fail" ? "fail" : "manual";
    const patch = { state, by: "vision", at, reason: v.reason, findings: v.findings };
    if (i >= 0) lenses[i] = { ...lenses[i], ...patch };
    else lenses.push({ id: v.lensId, name: v.lensId, facing: "rear", ...patch });
    applied.push(v);
  }
  return { lenses, applied };
}
