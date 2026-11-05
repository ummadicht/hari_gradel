// GradeIQ Vision AI — the "agentic grading, visualised" engine.
//
// Built on Pandas' real fundamentals (docs.pandas.io): cosmetic condition is
// graded PER COMPONENT (Front Side, Back Side, Body Frame, Back Cameras,
// Display) on an A–D ladder, and every result — cosmetic + functional — lands
// in one unified `assessments[]` array ({component, condition, component_group,
// weight, assessment_types}). Here each cosmetic component gets its own
// specialist: a focused Gemini vision call that inspects ONLY that component and
// returns located findings (type + severity + confidence + bounding box). An
// Intake Gate screens photo quality first; a Final Grade Agent aggregates the
// weighted component grades into one composite. Runs on a deterministic stub
// until GEMINI_API_KEY is set — like the rest of GradeIQ.

import { COSMETIC_TIERS, type CosmeticGrade } from "./grading";
import { getSetting } from "./settings";
import {
  visionJSON,
  visionConfigured,
  hasDistinctTiers,
  selectedProvider,
  proOnly,
  type VisionTier,
  type VisionProvider,
  type VisionOutcome,
} from "./visionProvider";
import type { CosmeticResult } from "./gemini";
import { cameraSpec } from "./deviceSpecs";
import { buildInspectionPrompt } from "./inspectionCatalog";
import { guardDeviceIdentity } from "./identityGuard";

/** Surfaced in the server log: the grader called a real model non-existent. */
function logIdentityDowngrade(model: string, reason: string) {
  console.warn(`[identity] withdrew a mismatch for "${model}" — evidence was non-existence, not the photo: ${reason.slice(0, 120)}`);
}


export type Severity = "minor" | "moderate" | "severe";
// Normalized bounding box on a photo: [ymin, xmin, ymax, xmax] in 0..1.
export type Box = [number, number, number, number];

export type Finding = {
  type: string; // scratch | crack | chip | dent | scuff | wear | discoloration | deadpixel
  label: string; // human label, e.g. "Glass chip", "Hairline · 0.4mm"
  severity: Severity;
  confidence: number; // 0..1
  photoIndex: number; // which photo it was seen on
  box?: Box; // where on that photo
  location?: string; // human-readable spot, e.g. "top-right frame corner" — for audit
  sizeMmEst?: number; // estimated longest dimension in mm, when the model can judge it
  /**
   * Set when two independent passes were compared and only ONE of them saw
   * structural damage on this component. The finding is still REPORTED (a
   * possible crack is worth a human's eyes) but it may not single-handedly
   * force grade D — see isStructuralFinding / reconcilePasses.
   */
  uncorroborated?: boolean;
};

export type SpecialistId = "front" | "back" | "frame" | "cameras" | "display";

export type SpecialistResult = {
  id: SpecialistId;
  name: string;
  scope: string; // "what it can see" — shown in the cascade UI
  weight: number;
  // "" = NOT ASSESSED (the surface wasn't visible). Deliberately representable:
  // coercing an unseen component to a real grade made obscured surfaces render
  // as pristine "A" on the report — the single most misleading thing it showed.
  grade: CosmeticGrade | "";
  confidence: number; // 0..1
  findings: Finding[];
  notes: string;
  stub?: boolean; // true when this specialist fell back to the offline stub
};

export type IntakeResult = {
  passed: boolean;
  confidence: number;
  issues: string[]; // quality problems (blur/glare/dark/cutoff) → retake
  missingAngles: string[]; // coverage gaps → capture these
  stub?: boolean;
};

// A case / cover / protector hides the real surface and can conceal damage —
// the cosmetic grade is untrustworthy until it's removed and the photos retaken.
export type Obstruction = {
  present: boolean;
  type: string; // case | bumper | folio | skin | screen protector | aftermarket back | none
  note: string;
};

// Whether the device looks like OEM/original or has aftermarket parts — judged by
// compounding tells (see OEM_RULE). Advisory: shown on the report, not auto-reject.
export type OemVerdict = {
  verdict: "likely_oem" | "suspect_aftermarket" | "inconclusive";
  confidence: number;
  evidence: string[];
};

// Whether the photographed device matches the model the seller claimed.
export type DeviceIdentity = {
  make: string;
  model: string;
  match: "match" | "mismatch" | "uncertain";
  reason: string;
  /** Body colour as PHOTOGRAPHED — "" when the body was not visible. */
  colour?: string;
};

// Pandas-style unified assessment row (the Digital Device Passport backbone).
export type Assessment = {
  component: string;
  condition: string; // "A".."D"/"Premium" or "Working"/"Faulty"
  component_group: "Cosmetic Classification" | "Functional Classification";
  weight: number;
  assessment_types: string[];
};

// The cascade result is a superset of CosmeticResult so existing offer/report
// code keeps working unchanged, plus the new agentic detail.
export type VisionCascadeResult = CosmeticResult & {
  intake: IntakeResult;
  specialists: SpecialistResult[];
  findings: Finding[]; // flattened across specialists
  assessments: Assessment[]; // cosmetic assessments, Pandas shape
  score: number; // 0..100 composite
  device?: DeviceIdentity; // model identified from the photos + match vs claimed
  obstruction?: Obstruction; // case/cover/protector detected → block the grade
  oem?: OemVerdict; // aftermarket-parts authenticity read (advisory)
  tierUsed: "stub" | "flash" | "pro"; // which model tier produced this grade
  escalated: boolean; // true when a borderline Flash pass was re-run on Pro
  needsHumanReview: boolean; // real grade still uncertain / mismatch / suspect part
  borderline: boolean; // this grade is ambiguous → worth a Pro refinement
  provider?: string | null; // which vision provider answered (for escalation routing)
  /** The EXACT model string that answered, e.g. "gemini-3.1-pro-preview".
   *  Recorded per run so a re-pointed preview alias is detectable. */
  visionModel?: string | null;
  refining?: boolean; // a Pro refinement is running in the background for this result
  coverage: number; // fraction of STRUCTURAL surfaces actually inspected (0..1)
  /** Where the handset sits in each photo — framing for the refinement pass. */
  deviceBoxes?: DevicePlacement[];
  /**
   * Why no model answered, when tierUsed is "stub": "unavailable" (the provider
   * is overloaded — a 5xx), "model_gone" (a 404 — retired model), "quota",
   * "auth", "no_key", "network" or "bad_response". Null when a model did answer. Without it every failure
   * read "no working vision key", including the 2026-10-18 Pro outage, when
   * the key was fine and Google was simply turning Pro requests away.
   */
  visionError?: VisionOutcome["error"];
};

// ---- Specialist registry: one focused inspector per cosmetic component ----
type SpecDef = {
  id: SpecialistId;
  name: string;
  scope: string;
  weight: number;
  // What this specialist inspects — injected into its prompt so it ignores
  // everything else (the key to a "proper specialized job").
  focus: string;
  defectTypes: string[];
};

/** The intake gate's flat response contract. */
const INTAKE_SCHEMA = {
  type: "OBJECT",
  properties: {
    passed: { type: "BOOLEAN" },
    confidence: { type: "NUMBER" },
    issues: { type: "ARRAY", items: { type: "STRING" } },
    missingAngles: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["passed"],
} as const;

export const SPECIALISTS: SpecDef[] = [
  {
    id: "front",
    name: "Front Glass Specialist",
    scope: "Screen glass — scratches, hairlines, cracks, chips",
    weight: 1,
    focus: "the FRONT screen glass only",
    defectTypes: ["scratch", "crack", "chip"],
  },
  {
    id: "back",
    name: "Rear Glass Specialist",
    scope: "Back glass / rear panel — scratches, cracks, chips",
    weight: 1,
    focus: "the BACK glass or rear housing panel only",
    defectTypes: ["scratch", "crack", "chip"],
  },
  {
    id: "frame",
    name: "Frame & Body Specialist",
    scope: "Chassis, edges, corners, charging port — dents, bends, deep scratches",
    weight: 1,
    focus: "the metal/plastic FRAME, edges, corners and charging port only",
    defectTypes: ["dent", "scuff", "scratch", "wear"],
  },
  {
    id: "cameras",
    name: "Camera Lens Specialist",
    scope: "Rear & front camera lens covers — cracks, scratches",
    weight: 1,
    focus: "the CAMERA lens covers (rear and front) only",
    defectTypes: ["crack", "scratch", "chip"],
  },
  {
    id: "display",
    name: "Display Specialist",
    scope: "Screen-on defects — dead pixels, discoloration, ghosting, LCD lines",
    weight: 1,
    focus:
      "the DISPLAY output only — dead/stuck pixels, discoloration, ghosting, lines (only judge if the screen is ON)",
    defectTypes: ["deadpixel", "discoloration"],
  },
];

// ---- grade math ----
const PENALTY: Record<CosmeticGrade, number> = {
  Premium: 0,
  A: 5,
  B: 18,
  C: 35,
  D: 60,
};

function tierFromScore(score: number): CosmeticGrade {
  if (score >= 96) return "Premium";
  if (score >= 85) return "A";
  if (score >= 68) return "B";
  if (score >= 45) return "C";
  return "D";
}

function safeGrade(g: any): CosmeticGrade {
  return (COSMETIC_TIERS as readonly string[]).includes(g)
    ? (g as CosmeticGrade)
    : "C";
}

function normBox(b: any): Box | undefined {
  if (!Array.isArray(b) || b.length !== 4) return undefined;
  let v = b.map((n) => Number(n));
  if (v.some((n) => Number.isNaN(n))) return undefined;
  // Gemini often returns 0..1000; normalize to 0..1.
  if (v.some((n) => n > 1)) v = v.map((n) => n / 1000);
  return [v[0], v[1], v[2], v[3]] as Box;
}

// Vision calls now route through lib/visionProvider.ts (visionJSON), which owns
// the Gemini-vs-Kimi switch, JSON mode, temperature-0 determinism and fallback.

// ---- Intake Gate ----
async function runIntake(
  key: string | "",
  photos: string[]
): Promise<IntakeResult> {
  if (!key) {
    // No AI answered. The deterministic capture gate has ALREADY verified that a
    // device is present, the views are distinct and the frames are sharp, so we
    // don't claim the photos are unusable — but confidence is 0, not the 0.9 this
    // used to report. That honesty matters: a fabricated 0.9 made `conclusive`
    // true, which is how an ungraded device slipped through as a firm result.
    const need =
      photos.length >= 4
        ? []
        : ["rear glass under angled light", "bottom edge", "each side rail"].slice(
            0,
            Math.max(0, 4 - photos.length)
          );
    return {
      passed: photos.length >= 1,
      confidence: 0,
      issues: photos.length === 0 ? ["no photos yet"] : [],
      missingAngles: need,
      stub: true,
    };
  }
  const prompt = `You are the INTAKE GATE on GradeIQ's cosmetic inspection line. Do NOT grade condition. Judge only whether these ${photos.length} photos are good enough to grade a used smartphone: check blur, glare, lighting, framing/cut-off, and whether the key surfaces (front, back, frame edges, cameras) are covered. Return STRICT JSON {"passed": true|false, "confidence": 0..1, "issues": ["short retake reasons"], "missingAngles": ["angles still needed"]}.`;
  // The intake gate's contract is FLAT — {passed, confidence, issues,
  // missingAngles} — not the nested inspection tree. Passing the default schema
  // here forced a response that could never contain `passed`, and the parse
  // below reads `out.passed !== false`, so a missing field silently became
  // "photos are fine". Its own schema, or the failure is invisible.
  const out = (
    await visionJSON(prompt, photos, "pro", undefined, INTAKE_SCHEMA)
  ).json;
  if (!out) {
    return {
      passed: photos.length > 0,
      confidence: 0.5,
      issues: [],
      missingAngles: [],
      stub: true,
    };
  }
  return {
    passed: out.passed !== false,
    confidence: typeof out.confidence === "number" ? out.confidence : 0.7,
    issues: Array.isArray(out.issues) ? out.issues.slice(0, 5) : [],
    missingAngles: Array.isArray(out.missingAngles)
      ? out.missingAngles.slice(0, 5)
      : [],
    stub: false,
  };
}

// ---- A single cosmetic specialist ----
/**
 * No vision provider answered → NOT ASSESSED. Never a grade, never a finding.
 *
 * This used to fabricate both: it picked a grade from
 * `(def.id + photos.join("").length + model).length % 5` — i.e. from the BYTE
 * LENGTH of the photos, not their content — and invented a matching defect
 * ("Rear scratch", "Lens micro-scratch", "Hairline · 0.3mm"). Those fakes were
 * persisted as real grades, so a phone the AI never actually looked at could
 * come back "D" with three located-sounding defects. It was the single largest
 * source of "the same phone gets different results": whenever a call failed or
 * was rate-limited, the stub quietly invented an answer.
 *
 * An honest empty result costs nothing downstream — finalGrade already returns
 * no composite when nothing was assessed, and the offer engine already refuses
 * to price an ungraded device.
 */
function stubSpecialist(def: SpecDef, _photos: string[], _model: string): SpecialistResult {
  return {
    id: def.id,
    name: def.name,
    scope: def.scope,
    weight: 0, // excluded from the composite — it was never inspected
    grade: "", // NOT ASSESSED
    confidence: 0,
    findings: [], // never invent a defect
    notes: "Not assessed — the inspection service didn't return a result.",
    stub: true,
  };
}

async function runSpecialist(
  key: string | "",
  def: SpecDef,
  photos: string[],
  model: string,
  display?: { startIndex: number; patterns: string[] }
): Promise<SpecialistResult> {
  if (!key || photos.length === 0) return stubSpecialist(def, photos, model);

  // The camera specialist is told the exact lens layout for this model so it
  // checks EVERY lens cover (a Pro has 3 rear lenses; a base model 2).
  let focus = def.focus;
  if (def.id === "cameras" && model) {
    const s = cameraSpec(model);
    focus = `each of the ${s.rear.length} rear camera lens covers (${s.rear
      .map((l) => l.name)
      .join(", ")}) and the front camera — inspect every lens individually`;
  }

  /* The Display Specialist's own brief says "only judge if the screen is ON" —
   * and for a long time the only photos it ever received were the six exterior
   * angles, shot with the screen dark. So it correctly, and permanently,
   * returned an empty grade: it was waiting for frames nobody sent it.
   *
   * The display sweep captures exactly those frames — the screen driven through
   * white / gray / black / colour and verified lit before capture — so they are
   * appended to the photo set and named here. This is what makes the LCD
   * actually AI-reviewed rather than merely photographed. */
  let displayHint = "";
  if (def.id === "display" && display && display.patterns.length) {
    const idx = display.patterns.map((p, i) => `photo ${display.startIndex + i} = full-screen ${p}`).join(", ");
    displayHint =
      ` The last ${display.patterns.length} photos are this device's screen displaying full-screen test patterns (${idx}). ` +
      `Judge the display from THOSE photos: dead or stuck pixels (a dot that stays dark on white or bright on black), ` +
      `backlight bleed and clouding on the black frame, discoloration, tint or mura on the white and gray frames, ` +
      `LCD driver lines, and — on a foldable — crease damage along the fold. Ignore the exterior angle photos for this judgement.`;
  }

  const prompt = `You are the ${def.name} on GradeIQ's cosmetic inspection line for a used ${
    model || "smartphone"
  }. Inspect ONLY ${focus}.${displayHint} Ignore every other part of the device. Grade that component on this ladder: Premium (like new) · A (faint micro-marks) · B (light visible scratches, no cracks) · C (heavy scratches/dents) · D (cracked/chipped/bent/missing). For each defect you actually see, add a finding with a normalized bounding box [ymin,xmin,ymax,xmax] (0..1) on the photo index it appears. If the component isn't visible in any photo, return grade "" and confidence 0. Return STRICT JSON {"grade": "Premium|A|B|C|D or empty", "confidence": 0..1, "notes": "one short sentence", "findings": [{"type":"scratch|crack|chip|dent|scuff|wear|discoloration|deadpixel","label":"short","severity":"minor|moderate|severe","confidence":0..1,"photoIndex":0,"box":[ymin,xmin,ymax,xmax]}]}.`;

  const out = (await visionJSON(prompt, photos)).json;
  if (!out) return stubSpecialist(def, photos, model);

  const findings: Finding[] = Array.isArray(out.findings)
    ? out.findings.slice(0, 8).map((f: any) => ({
        type: String(f.type ?? "scratch"),
        label: String(f.label ?? f.type ?? "defect"),
        severity: (["minor", "moderate", "severe"].includes(f.severity)
          ? f.severity
          : "minor") as Severity,
        confidence: typeof f.confidence === "number" ? f.confidence : 0.7,
        photoIndex: Number.isInteger(f.photoIndex) ? f.photoIndex : 0,
        box: normBox(f.box),
      }))
    : [];

  // A component with no visible surface → skip it (weight 0 handled by caller).
  const grade = out.grade === "" ? "" : safeGrade(out.grade);
  return {
    id: def.id,
    name: def.name,
    scope: def.scope,
    weight: grade === "" ? 0 : def.weight,
    grade: grade as CosmeticGrade | "",
    confidence: typeof out.confidence === "number" ? out.confidence : 0.75,
    findings,
    notes: typeof out.notes === "string" ? out.notes : "",
    stub: false,
  };
}

// ---- One consolidated inspection pass at a given cost tier ----
// One call = Intake Gate + all five component specialists + identity + OEM, from
// the per-side catalog prompt. Runs at `tier`: "flash" for the cheap bulk pass,
// "pro" when the cascade escalates a borderline result. `answered` is false when
// the provider returned nothing (quota/network) so the caller can fall back
// honestly instead of trusting a stub as a real grade.
type VisionPass = {
  answered: boolean;
  provider: string | null;
  model: string | null;
  /** The provider's failure reason when `answered` is false. */
  error: VisionOutcome["error"];
  intake: IntakeResult;
  specialists: SpecialistResult[];
  device?: DeviceIdentity;
  obstruction?: Obstruction;
  oem?: OemVerdict;
  /** How many photos this pass actually looked at (escalation reads it). */
  photoCount: number;
  /**
   * Where the handset sits in each photo — framing, not grading.
   *
   * Read by the Pro refinement so it can grade a crop of the device rather than
   * the whole scene. Absent entries simply mean "grade that photo as-is".
   */
  deviceBoxes?: DevicePlacement[];
};

/** The handset's extent in one photo: [ymin, xmin, ymax, xmax], 0..1. */
export type DevicePlacement = { photoIndex: number; box: Box };

async function runVisionPass(
  photos: string[],
  model: string,
  tier: VisionTier,
  litCount = 0,
  display?: { startIndex: number; patterns: string[] },
  /** Force one named vendor (a "re-grade with X" second opinion). */
  provider?: VisionProvider
): Promise<VisionPass> {
  // The prompt is composed from the per-side inspection catalog: each photo gets
  // an exact brief (what to inspect, box, model-verify cues, aftermarket tells)
  // by its capture-order side, plus identity + OEM fusion rules. One call.
  const prompt = buildInspectionPrompt(model, photos.length, litCount, display?.patterns || []);

  const res = await visionJSON(prompt, photos, tier, provider);
  const out = res.json;
  if (!out || !out.components) {
    // Whole call failed (e.g. quota) → honest stub for every agent.
    return {
      answered: false,
      provider: res.provider,
      model: res.model,
      // A 200 whose body has no `components` is an unusable answer, not an outage.
      error: res.error ?? "bad_response",
      intake: await runIntake("", photos),
      specialists: SPECIALISTS.map((d) => stubSpecialist(d, photos, model)),
      photoCount: photos.length,
    };
  }
  const intake: IntakeResult = {
    passed: out.intake?.passed !== false,
    confidence:
      typeof out.intake?.confidence === "number" ? out.intake.confidence : 0.7,
    issues: Array.isArray(out.intake?.issues) ? out.intake.issues.slice(0, 5) : [],
    missingAngles: Array.isArray(out.intake?.missingAngles)
      ? out.intake.missingAngles.slice(0, 5)
      : [],
    stub: false,
  };
  const specialists: SpecialistResult[] = SPECIALISTS.map((def) => {
    const c = out.components?.[def.id];
    let findings: Finding[] = Array.isArray(c?.findings)
      ? c.findings.slice(0, 8).map((f: any) => ({
          type: String(f.type ?? "scratch"),
          label: String(f.label ?? f.type ?? "defect"),
          severity: (["minor", "moderate", "severe"].includes(f.severity)
            ? f.severity
            : "minor") as Severity,
          confidence: typeof f.confidence === "number" ? f.confidence : 0.7,
          photoIndex: Number.isInteger(f.photoIndex) ? f.photoIndex : 0,
          box: normBox(f.box),
          location: typeof f.location === "string" ? f.location.slice(0, 60) : undefined,
          sizeMmEst:
            typeof f.length_mm_est === "number" && f.length_mm_est > 0
              ? Math.round(f.length_mm_est * 10) / 10
              : undefined,
        }))
      : [];
    // "UNASSESSED" is what the response schema requires instead of "" (an empty
    // string is not a legal enum member). Both mean the same thing here: the
    // surface was not assessable, so it gets no grade and is excluded from the
    // average rather than counted as clean.
    const unassessed = c == null || c?.grade === "" || c?.grade === "UNASSESSED";
    let grade = unassessed ? "" : safeGrade(c.grade);

    // THE DISPLAY CANNOT BE GRADED WITHOUT A SCREEN-ON PHOTO.
    //
    // The Display Specialist judges screen-ON defects — dead pixels, LCD lines,
    // ghosting — which only exist as evidence in the display sweep's test-pattern
    // frames. When the sweep captures nothing (the camera never locks onto a lit
    // screen, or the seller never unfolds a foldable), no such frame is passed,
    // and the prompt already says to return grade "" in that case.
    //
    // The model does not reliably obey it. Production session 9016c5b4 (Galaxy
    // Z Fold6) stored ZERO display frames, and the Display Specialist still
    // returned **D** — "Large dead pixel blob", severity severe, confidence 0.9
    // — located on photoIndex 3, which is the RIGHT EDGE shot of the phone's
    // rail. It graded a screen it had never seen, from a photo of the side of
    // the device, and because the composite can never beat its worst component
    // that single hallucination took the whole phone to D.
    //
    // So the absence of evidence is enforced here rather than requested: no
    // screen-on frames, no display grade.
    if (def.id === "display" && !display?.patterns?.length) {
      grade = "";
      // Drop the findings too: they describe a screen that was never
      // photographed lit, and left in place they would still be drawn as
      // damage boxes on whatever unrelated photo the model attached them to.
      findings = [];
    }

    return {
      id: def.id,
      name: def.name,
      scope: def.scope,
      weight: grade === "" ? 0 : def.weight,
      grade: grade as CosmeticGrade | "",
      confidence: typeof c?.confidence === "number" ? c.confidence : 0.75,
      findings,
      notes: typeof c?.notes === "string" ? c.notes : "",
      stub: false,
    };
  });
  const device =
    out.device && (out.device.make || out.device.model)
      ? {
          make: String(out.device.make || "").slice(0, 40),
          model: String(out.device.model || "").slice(0, 60),
          // Body colour AS PHOTOGRAPHED, for the seller-claim cross-check.
          colour: String(out.device.colour || "").slice(0, 24),
          match: (["match", "mismatch", "uncertain"].includes(out.device.match)
            ? out.device.match
            : "uncertain") as "match" | "mismatch" | "uncertain",
          reason: String(out.device.reason || "").slice(0, 160),
        }
      : undefined;
  /* A phone the grader has not heard of is not a fake phone.
   *
   * Applied at the PARSE point so every caller — the live grade, the Pro
   * refinement, the re-grade — is covered by one rule. It withdraws only those
   * mismatches whose stated evidence is the model's own ignorance of the
   * catalogue ("does not exist"), which is guaranteed to be its belief about
   * any handset released after its training cutoff. Mismatches grounded in
   * something visible are untouched. See lib/identityGuard.ts. */
  const guarded = guardDeviceIdentity(device);
  if (guarded.downgraded) {
    // Worth seeing in the logs: a run of these means the prompt's newer-models
    // rule is being ignored often enough to revisit.
    logIdentityDowngrade(device?.model || "", device?.reason || "");
  }
  const deviceChecked = device ? (guarded.device as typeof device) : undefined;
  const obstruction: Obstruction | undefined = out.obstruction
    ? {
        present: out.obstruction.present === true,
        type: String(out.obstruction.type || "none").slice(0, 40),
        note: String(out.obstruction.note || "").slice(0, 140),
      }
    : undefined;
  const oem: OemVerdict | undefined = out.oem
    ? {
        verdict: (["likely_oem", "suspect_aftermarket", "inconclusive"].includes(out.oem.verdict)
          ? out.oem.verdict
          : "inconclusive") as OemVerdict["verdict"],
        confidence: typeof out.oem.confidence === "number" ? out.oem.confidence : 0.5,
        evidence: Array.isArray(out.oem.evidence)
          ? out.oem.evidence.slice(0, 6).map((e: any) => String(e).slice(0, 120))
          : [],
      }
    : undefined;
  /* Where the phone is in each photo. Every entry is validated before it can
     be cropped to — a malformed or absurd box must degrade to "no crop", which
     is exactly the behaviour that existed before this field. */
  const deviceBoxes: DevicePlacement[] = Array.isArray(out?.deviceBoxes)
    ? out.deviceBoxes
        .map((d: any) => ({ photoIndex: Number(d?.photoIndex), box: normBox(d?.box) }))
        .filter(
          (d: any): d is DevicePlacement =>
            Number.isInteger(d.photoIndex) &&
            d.photoIndex >= 0 &&
            d.photoIndex < photos.length &&
            Array.isArray(d.box)
        )
        .slice(0, 24)
    : [];

  return {
    answered: true,
    provider: res.provider,
    model: res.model,
    error: null,
    intake,
    specialists,
    device: deviceChecked,
    obstruction,
    oem,
    photoCount: photos.length,
    deviceBoxes,
  };
}

// ---- Final Grade Agent: aggregate weighted component grades ----
function finalGrade(specialists: SpecialistResult[]) {
  // Only components that were actually SEEN count. An unseen surface has no
  // grade — it must not be averaged in, and it must not be silently skipped as
  // though the device were fully inspected either (see `coverage` below).
  const active = specialists.filter(
    (s): s is SpecialistResult & { grade: CosmeticGrade } =>
      s.weight > 0 && s.confidence > 0 && s.grade !== ""
  );
  // STRUCTURAL surfaces are what a cosmetic grade is actually about. `display`
  // is deliberately excluded: a screen-off photo leaves it unassessed all the
  // time, and that is not the same as never having seen the back glass.
  const STRUCTURAL: SpecialistId[] = ["front", "back", "frame", "cameras"];
  const structuralTotal = specialists.filter((s) => STRUCTURAL.includes(s.id)).length;
  const structuralSeen = active.filter((s) => STRUCTURAL.includes(s.id)).length;
  const coverage = structuralTotal > 0 ? structuralSeen / structuralTotal : 0;

  // Nothing assessable → NO grade. Previously this invented "C / 55", handing a
  // real score to a device the AI never actually saw.
  if (active.length === 0) return { grade: "" as const, score: 0, coverage: 0 };

  // Too little of the body actually seen → refuse to publish a composite. Half a
  // phone behind a case is not a Grade A phone; it's an uninspected phone.
  if (coverage < 0.5) return { grade: "" as const, score: 0, coverage };

  let wsum = 0;
  let psum = 0;
  for (const s of active) {
    wsum += s.weight;
    psum += s.weight * PENALTY[s.grade];
  }
  const score = Math.max(0, Math.round((100 - psum / wsum) * 10) / 10);

  const worst = active.reduce<CosmeticGrade>(
    (w, s) => (PENALTY[s.grade] > PENALTY[w] ? s.grade : w),
    "Premium"
  );

  // THE COMPOSITE MAY NEVER BE BETTER THAN THE WORST COMPONENT.
  //
  // The average alone hides defects: four pristine sides and one scuffed frame
  // averaged to 92 → "A", while the frame itself was "B". But the ladder defines
  // A as "very light wear only (micro-marks visible only at an angle)" — a phone
  // with a visible corner scuff is not that phone. Averaging is how a device gets
  // sold as better than its worst visible surface, which is exactly the dispute
  // we never want. The old rule allowed the composite to sit ONE tier above the
  // worst; it now cannot exceed it.
  let grade = tierFromScore(score);
  const gi = COSMETIC_TIERS.indexOf(grade);
  const wi = COSMETIC_TIERS.indexOf(worst);
  if (gi < wi) grade = worst;

  // Structural damage is a floor, not an average. Per the published ladder,
  // "D — Damaged / parts: cracked, chipped, bent".
  if (hasStructuralDamage(active)) grade = "D";
  return { grade, score, coverage };
}

/**
 * Does the evidence actually support "D — Damaged / parts"?
 *
 * WHY THIS IS NARROW. The original rule was a substring match —
 * `/crack|chip|bend|deformation|shatter/i` tested against the model's FREE-TEXT
 * label — with no regard for severity or confidence. Production consequences,
 * from the grading_runs history on one Galaxy Z Fold6 (IMEI …400752):
 *
 *   • score 95.5 (near-mint) published as **D**, on the strength of one finding
 *     labelled "corner finish chip" — severity MINOR, i.e. worn anodising.
 *   • the same six photos graded **D** and then **B** 68 seconds apart, the only
 *     difference being whether that run's free text happened to contain "chips".
 *
 * It was also self-inflicted: lib/inspectionCatalog.ts explicitly asks the model
 * to report "chipped anodizing" and a finish that "has chipped" as MINOR wear —
 * so the prompt solicited the exact words that then forced the worst grade on
 * the ladder. The prompt and the grading rule were in direct contradiction.
 *
 * So the gate now demands evidence that a person would agree with:
 *   1. TYPE, not prose. `type` is a constrained enum from the response schema;
 *      the free-text label is not evidence of anything and no longer votes.
 *   2. NOT MINOR. "Damaged / parts" and "a minor mark" cannot both be true.
 *   3. LOCALIZED + CONFIDENT. A structural claim the model can neither point at
 *      nor stand behind is the exact signature of a hallucinated defect.
 *   4. GLASS vs FINISH. A chip in the cover glass is structural. A chip in the
 *      frame's paint/anodising is wear — that is grade C ("worn-through finish"),
 *      which the weighted score already handles. Only a SEVERE frame finding
 *      (a genuinely bent or broken housing) is structural.
 *
 * What this deliberately does NOT fix: a confidently hallucinated *severe* crack
 * (one run of the phone above reported "Shattered glass", crack/severe, conf 0.9,
 * with a box, on a device every other run called Premium). No single-sample rule
 * can catch that — it needs corroboration across passes, which is why callers
 * reconcile structural findings rather than trusting one look.
 */
const STRUCTURAL_TYPES = new Set(["crack", "chip", "bend", "deformation", "shatter"]);
/** Words that carry structural meaning but have no matching `type` in the schema. */
const STRUCTURAL_PROSE = /\b(bent|bend|shatter|deform)/i;

export function isStructuralFinding(componentId: SpecialistId, f: Finding): boolean {
  // Seen by one pass but not the other — reported, but not trusted to set the
  // floor on its own. This is what stops a single hallucinated "Shattered
  // glass" from turning an otherwise-Premium device into D.
  if (f.uncorroborated) return false;
  const type = String(f.type || "").toLowerCase().trim();
  const byType = STRUCTURAL_TYPES.has(type);
  // A bent chassis usually arrives as type "dent" with the bend only in the
  // prose, so prose may still qualify a finding — but only at SEVERE, never on
  // its own wording alone.
  const byProse = f.severity === "severe" && STRUCTURAL_PROSE.test(f.label || "");
  if (!byType && !byProse) return false;

  // "Damaged / parts" is not a minor mark.
  if (f.severity === "minor") return false;
  // Unlocalized or low-confidence structural claims are the hallucination shape.
  if (typeof f.confidence === "number" && f.confidence < 0.7) return false;
  if (!f.box) return false;

  // Frame findings are finish wear unless they are severe: a chipped corner of
  // anodising is not a broken phone, a bent rail is.
  if (componentId === "frame" && f.severity !== "severe") return false;

  return true;
}

/** True when at least one component carries evidence of real structural damage. */
export function hasStructuralDamage(specialists: Pick<SpecialistResult, "id" | "findings">[]): boolean {
  return specialists.some((s) => s.findings.some((f) => isStructuralFinding(s.id, f)));
}

// Is a Flash pass ambiguous enough to be worth escalating to the pricier Pro
// model? Escalate on any real uncertainty: a component the model couldn't see
// clearly, a wide grade spread across components, a claimed-model mismatch, a
// suspected aftermarket part, or a shaky intake. Cheap phones grade once on
// Flash; only the genuinely borderline ones pay for Pro.
function isBorderline(pass: VisionPass): boolean {
  const active = pass.specialists.filter((s) => s.weight > 0);
  if (active.length === 0) return true;
  const lowConf = active.some((s) => s.confidence < 0.6);
  const idx = active
    .map((s) => COSMETIC_TIERS.indexOf(s.grade as CosmeticGrade))
    .filter((i) => i >= 0);
  const wideSpread = idx.length > 0 && Math.max(...idx) - Math.min(...idx) >= 2;
  const mismatch = pass.device?.match === "mismatch";
  const suspectOem = pass.oem?.verdict === "suspect_aftermarket";
  const shakyIntake = !pass.intake.passed || pass.intake.missingAngles.length > 0;

  /**
   * CONFIDENTLY PRISTINE IS ALSO BORDERLINE.
   *
   * Every trigger above keys on the model being UNSURE. A pass that misses a
   * defect isn't unsure — it is confidently wrong, and it therefore never
   * escalated. That is how a clear scratch straight across the Apple logo came
   * back as "rear glass intact, no visible defects" at 0.95 confidence and
   * settled on Flash at Grade A.
   *
   * So: when Flash claims the front or the back — the two surfaces that carry
   * the most value and the most damage — is spotless with NOTHING found, we pay
   * for the Pro look. A second opinion on "there's nothing here" is worth far
   * more than a second opinion on "I'm not sure", because only one of those two
   * silently overpays.
   */
  const pristineHighValue = active.some(
    (s) =>
      (s.id === "front" || s.id === "back") &&
      (s.grade === "Premium" || s.grade === "A") &&
      s.findings.length === 0,
  );

  /**
   * ONE SIDE MARKED, THE OTHERS SILENT.
   *
   * The frame is photographed from several angles, so wear that appears on the
   * right rail almost always appears on the left too. When the frame comes back
   * with findings from exactly one photo while several side photos exist, the
   * pass has described one side and said nothing about the rest — which is what
   * produced a report highlighting one rail and leaving its twin unmarked.
   */
  const frame = active.find((s) => s.id === "frame");
  const framePhotos = new Set((frame?.findings ?? []).map((f) => f.photoIndex));
  const lopsidedFrame = !!frame && frame.findings.length > 0 && framePhotos.size === 1 && pass.photoCount >= 4;

  return (
    lowConf || wideSpread || mismatch || suspectOem || shakyIntake || pristineHighValue || lopsidedFrame
  );
}

/** True when the configured/answering provider actually has a stronger Pro tier. */
export function proRefinementAvailable(providerThatAnswered?: string | null): boolean {
  const p = (providerThatAnswered as VisionProvider) || selectedProvider();
  return hasDistinctTiers(p);
}

// ---- Public entry: run the whole cascade ----
// opts.forceTier runs a SINGLE pass at that tier (no internal escalation) so the
// route can show the Flash grade instantly and run the Pro refinement in the
// background. With no forceTier it does the synchronous two-tier escalation.
export async function runVisionCascade(
  photos: string[],
  model = "",
  opts: {
    forceTier?: VisionTier;
    litCount?: number;
    /** The display-sweep frames appended to `photos`, and which pattern each is. */
    display?: { startIndex: number; patterns: string[] };
    /**
     * Grade with ONE named vendor and no fallback — the "re-grade with ChatGPT"
     * path. A second opinion is only worth anything if it genuinely comes from
     * the model the operator picked.
     */
    provider?: VisionProvider;
  } = {}
): Promise<VisionCascadeResult> {
  // Two-tier vision: a cheap Flash pass inspects every photo; only a BORDERLINE
  // result escalates to the pricier, more-accurate Pro model — and only when the
  // provider actually has a distinct Pro tier (Gemini does; Kimi K3 is both, so
  // re-running would be a wasted identical call). No provider or no photos →
  // deterministic stub. `tierUsed` records what actually graded, for honesty.
  let intake: IntakeResult;
  let specialists: SpecialistResult[];
  let device: DeviceIdentity | undefined;
  let obstruction: Obstruction | undefined;
  let oem: OemVerdict | undefined;
  let tierUsed: "stub" | "flash" | "pro" = "stub";
  let escalated = false;
  let borderline = false;
  let provider: string | null = null;
  let visionModel: string | null = null;
  let deviceBoxes: DevicePlacement[] | undefined;
  // Why nothing answered, if nothing did. Stays null once any pass answers.
  let visionError: VisionOutcome["error"] = null;

  if (!visionConfigured() || photos.length === 0) {
    intake = await runIntake("", photos);
    specialists = SPECIALISTS.map((def) => stubSpecialist(def, photos, model));
    if (!visionConfigured()) visionError = "no_key";
  } else if (opts.forceTier) {
    // Single forced pass — the caller drives escalation (async, from the route).
    // In pro-only mode a request for Flash is honoured as Pro: the whole point
    // of the switch is that the cheap tier never decides a grade, and silently
    // letting a caller opt back into it would defeat it.
    const forced: VisionTier = proOnly() ? "pro" : opts.forceTier;
    const pass = await runVisionPass(photos, model, forced, opts.litCount, opts.display, opts.provider);
    if (pass.answered) {
      tierUsed = forced;
      escalated = forced === "pro";
      borderline = isBorderline(pass);
      provider = pass.provider;
      visionModel = pass.model;
    } else visionError = pass.error;
    ({ intake, specialists, device, obstruction, oem } = pass);
    deviceBoxes = pass.deviceBoxes;
  } else if (proOnly()) {
    // No triage tier at all — grade once, on Pro.
    const pass = await runVisionPass(photos, model, "pro", opts.litCount, opts.display, opts.provider);
    if (pass.answered) {
      tierUsed = "pro";
      escalated = true;
      borderline = isBorderline(pass);
      provider = pass.provider;
      visionModel = pass.model;
    } else visionError = pass.error;
    ({ intake, specialists, device, obstruction, oem } = pass);
    deviceBoxes = pass.deviceBoxes;
  } else {
    let pass = await runVisionPass(photos, model, "flash", opts.litCount, opts.display, opts.provider);
    if (pass.answered) {
      tierUsed = "flash";
      borderline = isBorderline(pass);
      provider = pass.provider;
      visionModel = pass.model;
    } else visionError = pass.error;
    if (pass.answered && borderline && pass.provider && hasDistinctTiers(pass.provider as any)) {
      const pro = await runVisionPass(photos, model, "pro", opts.litCount, opts.display, opts.provider);
      if (pro.answered) {
        pass = pro;
        tierUsed = "pro";
        escalated = true;
        borderline = isBorderline(pro);
        provider = pro.provider;
        visionModel = pro.model;
      }
    }
    ({ intake, specialists, device, obstruction, oem } = pass);
    deviceBoxes = pass.deviceBoxes;
  }

  // A case/cover/protector hides the real surface — the cosmetic grade cannot be
  // trusted. Force a retake with a clear, specific reason.
  if (obstruction?.present) {
    const label = obstruction.type && obstruction.type !== "none"
      ? obstruction.type
      : "cover";
    intake = {
      ...intake,
      passed: false,
      issues: [
        `Remove the ${label} and retake — it hides the phone's real condition.`,
        ...intake.issues,
      ].slice(0, 5),
    };
  }

  // "gemini" only if at least one specialist genuinely got a model response;
  // if the key exists but every call fell back to the stub, say so honestly.
  const source: "gemini" | "stub" = specialists.some((s) => s.stub === false)
    ? "gemini"
    : "stub";

  const graded = finalGrade(specialists);
  // A COVERED PHONE IS AN UNINSPECTED PHONE — ENFORCE IT, DON'T JUST ASK.
  //
  // STEP 0 of the prompt tells the model that grading a cased device is "the
  // single worst error you can make here", and when a cover IS detected we
  // already set intake.passed = false above. But nothing acted on it: intake
  // only fed `conclusive` / `needsHumanReview`, so the composite was still
  // published and still priced. In production that let 7 of 29 graded sessions
  // through with a failed intake — including a Samsung graded **A** whose own
  // report said "Remove the case and retake — it hides the phone's real
  // condition", and an iPhone 13 Pro graded **A** through a screen protector.
  //
  // This is also a direct cause of the same-phone-different-grade complaint:
  // one capture of a device shot through a screen protector and another shot
  // bare are not two readings of the same surface, and no amount of model
  // consensus reconciles them. Refusing the grade is the honest answer — the
  // seller is asked to retake, exactly as the report already told them to.
  const { score, coverage } = graded;
  // OFF BY DEFAULT — this one is a business call, not a bug fix.
  //
  // Withholding the grade is the accurate answer (a covered phone genuinely
  // wasn't inspected), but it costs a quote at the top of the funnel: on the
  // current production data 4 of 29 graded sessions would become "retake your
  // photos" instead of an offer. So the capability ships dormant and the
  // operator decides, without needing a deploy to change their mind:
  //   setting `withhold_grade_on_cover` = "true"  (or env WITHHOLD_GRADE_ON_COVER)
  // Until then behaviour is unchanged: the cover is still detected, still sets
  // intake.passed = false, and still prints the retake instruction on the report.
  const withholdOnCover =
    (getSetting("withhold_grade_on_cover", "WITHHOLD_GRADE_ON_COVER") || "").toLowerCase().trim() === "true";
  const grade = obstruction?.present && withholdOnCover ? ("" as const) : graded.grade;
  const findings = specialists.flatMap((s) =>
    s.findings.map((f) => ({ ...f }))
  );

  const active = specialists.filter((s) => s.weight > 0);
  const avgConf =
    active.length > 0
      ? active.reduce((a, s) => a + s.confidence, 0) / active.length
      : 0.5;

  // Backward-compatible CosmeticResult fields.
  // Coverage is part of being "conclusive": previously `active.every(...)` only
  // looked at the components that WERE seen, so a device with three unseen
  // surfaces could still be conclusive — and then priced at the best-case grade.
  const conclusive =
    intake.passed &&
    intake.missingAngles.length === 0 &&
    coverage >= 0.99 &&
    avgConf >= 0.6 &&
    active.every((s) => s.confidence >= 0.6);

  // The explicit human-review flag from the pipeline design: a real AI grade that
  // is STILL not conclusive after the best available model ran — or that flags a
  // model mismatch / suspected aftermarket part — should not auto-price without a
  // person looking. (A stub result isn't flagged for review; it's flagged as a
  // stub, which the offer path already discounts.)
  const needsHumanReview =
    tierUsed !== "stub" &&
    (!conclusive || device?.match === "mismatch" || oem?.verdict === "suspect_aftermarket");

  // Unassessed components ("") index to -1 and are excluded from the range.
  const grades = active
    .map((s) => COSMETIC_TIERS.indexOf(s.grade as CosmeticGrade))
    .filter((i) => i >= 0);
  // An unseen surface can hide anything, so it must push the WORST case down —
  // otherwise best===worst, the uncertainty band is zero wide, and the offer
  // engine quotes the optimistic grade as if it were confirmed.
  const worstIdx = coverage < 0.99
    ? COSMETIC_TIERS.length - 1 // something wasn't inspected → worst case is D
    : Math.max(...grades);
  const range =
    !conclusive && grades.length
      ? {
          best: COSMETIC_TIERS[Math.min(...grades)],
          worst: COSMETIC_TIERS[worstIdx],
        }
      : undefined;

  const assessments: Assessment[] = active.map((s) => ({
    component: s.name.replace(" Specialist", ""),
    condition: s.grade,
    component_group: "Cosmetic Classification",
    weight: s.weight,
    assessment_types: [s.id],
  }));

  return {
    // CosmeticResult surface
    grade,
    confidence: Math.round(avgConf * 100) / 100,
    defects: findings.map((f) => f.label),
    photoIssues: intake.issues,
    needMoreAngles: intake.missingAngles,
    question: "",
    conclusive,
    gradeRange: range,
    notes:
      tierUsed === "stub"
        ? `Stub cascade (${stubReason(visionError)}) · composite ${grade} (${score}/100).`
        : `${active.length} specialists · ${tierUsed}${escalated ? " (escalated)" : ""} · composite ${grade} (${score}/100).`,
    source,
    // Agentic detail
    intake,
    specialists,
    findings,
    assessments,
    score,
    device,
    obstruction,
    oem,
    tierUsed,
    escalated,
    needsHumanReview,
    borderline,
    provider,
    visionModel,
    coverage,
    deviceBoxes,
    visionError: tierUsed === "stub" ? visionError : null,
  };
}

/** The reason a stub result gives, in the words an operator can act on. */
function stubReason(e: VisionOutcome["error"]): string {
  switch (e) {
    case "unavailable":
      return "vision model unavailable — the provider is overloaded or erroring, not a key problem";
    case "quota":
      return "vision quota or rate limit reached";
    case "auth":
      return "vision key rejected";
    case "network":
      return "vision service unreachable";
    case "timeout":
      return "vision model took too long to answer";
    case "model_gone":
      return "vision model not found — it has probably been retired; update the model setting";
    case "bad_response":
      return "vision model returned an unusable answer";
    case "no_key":
      return "no working vision key";
    default:
      return "no photos to inspect";
  }
}

/**
 * CONSENSUS RE-GRADE — settle a grade instead of sampling one.
 *
 * Observed on production photos: the same six images, the same Pro model, the
 * same temperature-0 config, graded **B with two located findings** on one run
 * and **A with none** on the next two. Gemini 3 is a reasoning model; two runs
 * can take different internal paths and land on different verdicts, and no
 * amount of temperature/topK/seed pinning makes that go away. A re-grade that
 * returns whichever of those two answers it happened to draw is a coin flip
 * wearing a letter grade.
 *
 * So a settling re-grade runs the pass TWICE, concurrently, and reconciles:
 *
 *   • GRADE — the WORSE of the two wins. An inspection that found damage saw
 *     something the other missed; damage does not un-happen because a second
 *     look was luckier. Being wrong toward "worse" costs an argument, being
 *     wrong toward "better" costs the buy-back price.
 *   • FINDINGS — the UNION, deduped by component+label+photo. Each run's misses
 *     are the other's catches.
 *   • DISAGREEMENT — if the two runs produced different grades, the result is
 *     flagged for human review and says so. That is the honest signal: the
 *     evidence did not settle it, and a person should look.
 */
export function reconcilePasses(
  a: VisionCascadeResult,
  b: VisionCascadeResult,
): VisionCascadeResult {
  // A pass that never answered has nothing to contribute.
  if (a.tierUsed === "stub") return b;
  if (b.tierUsed === "stub") return a;

  const rank = (g: string) => {
    const i = (COSMETIC_TIERS as readonly string[]).indexOf(g);
    return i < 0 ? Infinity : i; // "" (not assessed) sorts as best-unknown
  };
  // COSMETIC_TIERS is Premium→D, so a HIGHER index is a WORSE grade.
  const worse = (x: string, y: string) => {
    const rx = rank(x);
    const ry = rank(y);
    if (rx === Infinity) return y;
    if (ry === Infinity) return x;
    return rx >= ry ? x : y;
  };

  const key = (id: string, f: Finding) =>
    `${id}|${(f.label || f.type || "").toLowerCase().trim()}|${f.photoIndex}`;

  const specialists: SpecialistResult[] = SPECIALISTS.map((def) => {
    const sa = a.specialists.find((s) => s.id === def.id);
    const sb = b.specialists.find((s) => s.id === def.id);
    if (!sa) return sb!;
    if (!sb) return sa;

    const merged = new Map<string, Finding>();
    for (const f of sa.findings) merged.set(key(def.id, f), f);
    for (const f of sb.findings) if (!merged.has(key(def.id, f))) merged.set(key(def.id, f), f);
    let findings = [...merged.values()];

    // STRUCTURAL DAMAGE MUST BE CORROBORATED.
    //
    // Union-of-findings is right for scratches — each run's misses are the
    // other's catches — but wrong for the one finding type that overrides the
    // whole grade. Under a plain union, a crack invented by EITHER pass forces
    // D, so drawing two samples makes a hallucination *more* likely to decide
    // the grade, not less. (Production: one pass reported "Shattered glass",
    // crack/severe, conf 0.9, on a Z Fold6 that every other pass called
    // Premium/A — and D is what got published.)
    //
    // Corroboration is judged per COMPONENT, not per label: two passes looking
    // at the same real crack routinely word it differently ("cracked glass" vs
    // "Shattered glass"), and demanding identical prose would discard genuine
    // damage. If both passes saw structural damage on this surface, it stands;
    // if only one did, it stays visible but is flagged for a human instead of
    // silently setting the floor.
    const aStructural = sa.findings.some((f) => isStructuralFinding(def.id, f));
    const bStructural = sb.findings.some((f) => isStructuralFinding(def.id, f));
    if (aStructural !== bStructural) {
      findings = findings.map((f) =>
        isStructuralFinding(def.id, f) ? { ...f, uncorroborated: true } : f,
      );
    }

    // A component only one run could see keeps the grade of the run that saw it.
    const grade = !sa.grade ? sb.grade : !sb.grade ? sa.grade : (worse(sa.grade, sb.grade) as CosmeticGrade | "");

    return {
      ...sa,
      grade,
      // Confidence is the LOWER of the two — the runs disagreeing is itself
      // evidence that this surface is harder to read than either run claimed.
      confidence: Math.min(sa.confidence, sb.confidence),
      findings,
      notes: sa.notes === sb.notes ? sa.notes : `${sa.notes} · Second pass: ${sb.notes}`,
    };
  }).filter(Boolean);

  const settled = finalGrade(specialists);
  const disagreed = a.grade !== b.grade;

  const findings = specialists.flatMap((s) => s.findings);
  // One pass alleged structural damage the other could not see. The grade did
  // NOT drop to D on that alone — so a person has to be the one to decide.
  const contestedStructural = findings.filter((f) => f.uncorroborated);
  return {
    ...a,
    specialists,
    findings,
    grade: settled.grade,
    score: settled.score,
    coverage: settled.coverage,
    // Either run spotting a mismatch or aftermarket tell is worth surfacing.
    device: a.device?.match === "mismatch" ? a.device : b.device?.match === "mismatch" ? b.device : a.device,
    oem:
      a.oem?.verdict === "suspect_aftermarket"
        ? a.oem
        : b.oem?.verdict === "suspect_aftermarket"
          ? b.oem
          : a.oem,
    obstruction: a.obstruction?.present ? a.obstruction : b.obstruction,
    needsHumanReview:
      a.needsHumanReview || b.needsHumanReview || disagreed || contestedStructural.length > 0,
    notes: contestedStructural.length
      ? `One pass reported ${contestedStructural
          .map((f) => `"${f.label || f.type}"`)
          .slice(0, 3)
          .join(", ")} and the other did not see it. Uncorroborated damage does not set the grade by itself — graded ${settled.grade} on the evidence both passes agreed on. Needs a human to confirm.`
      : disagreed
        ? `Two independent passes disagreed (${a.grade || "—"} vs ${b.grade || "—"}); recorded the more conservative grade and every finding either pass located. Worth a human look.`
        : `${specialists.filter((s) => s.grade).length} components · ${a.tierUsed} · two passes agreed on ${settled.grade}.`,
    assessments: specialists
      .filter((s) => s.grade)
      .map((s) => ({
        component: s.name,
        condition: s.grade as string,
        component_group: "Cosmetic Classification" as const,
        weight: s.weight,
        assessment_types: ["visual"],
      })),
  };
}
