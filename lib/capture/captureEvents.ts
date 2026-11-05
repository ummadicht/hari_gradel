// Controlled vocabulary for capture-attempt telemetry.
//
// Release 1 recorded exactly one kind of event: an accepted frame. That made
// three of its own fields meaningless — `attempt` was always 1, `retakeCount`
// always 0, and `outcome` always "captured" — and it silently discarded the
// only events that say anything about whether guidance is needed: the shutter
// presses that were refused, and the steps an operator walked away from.
//
// Free-text outcomes would defeat the point, since the whole purpose is to
// count categories across stores. These are the categories.

/** Why a capture attempt ended. Enforced at the API boundary. */
export const CAPTURE_OUTCOMES = [
  /** The frame became evidence. */
  "captured",
  /** Shutter pressed (or auto-fire armed) but the quality gate refused it. */
  "rejected_quality",
  /** Refused because the phone had not been turned — same view twice. */
  "rejected_duplicate",
  /** The authoritative server gate sent this angle back for a retake. */
  "rejected_server",
  /** An already-captured angle was shot again, replacing the earlier frame. */
  "replaced",
  /** The operator left the step (or the flow) without capturing it. */
  "abandoned",
] as const;

export type CaptureOutcome = (typeof CAPTURE_OUTCOMES)[number];

export const isCaptureOutcome = (v: unknown): v is CaptureOutcome =>
  typeof v === "string" && (CAPTURE_OUTCOMES as readonly string[]).includes(v);

/** Instructions the observation-mode engine can derive. */
export const INSTRUCTIONS = [
  "TOO_DARK",
  "REDUCE_GLARE",
  "FILL_THE_BOX",
  "HOLD_STEADY",
  "CAPTURE_READY",
] as const;

export type InstructionName = (typeof INSTRUCTIONS)[number];

export const isInstruction = (v: unknown): v is InstructionName =>
  typeof v === "string" && (INSTRUCTIONS as readonly string[]).includes(v);

/**
 * Version tags, kept as two SEPARATE names on purpose.
 *
 * `measurementProfile` identifies the arithmetic that produced the numbers.
 * `acceptanceProfile` identifies the rules that actually accepted or refused
 * the frame — which today is still each surface's own legacy code, sampling a
 * different region from the analyzer. Collapsing these into one "profile"
 * would assert a shared acceptance policy that does not yet exist, and would
 * make the first calibration pass compare numbers that were never comparable.
 */
export const MEASUREMENT_PROFILE = "frame-measure-v2";
export const ACCEPTANCE_PROFILE = {
  /** V2Cam's own assess(): guide-rect region, Laplacian < 90 is soft. */
  v2cam: "v2cam-legacy-v3",
  /** CosmeticCapture's assess(): 0.6-centre region, Laplacian < 65 is soft. */
  cosmetic: "cosmetic-legacy-v1",
} as const;

/** What the SURFACE actually decided, recorded alongside what guidance would have said. */
export type ActualVerdict = {
  accepted: boolean;
  /** The operator-visible reason, verbatim. */
  reason: string;
};

/** Bounds. A session that exceeds these is malfunctioning or hostile; either
 *  way the extra rows are noise and must not be allowed to grow unbounded. */
export const MAX_EVENTS_PER_SESSION = 300;
export const MAX_EVENTS_PER_STEP = 60;

/** RFC4122-ish v4, good enough as an idempotency key. */
export function newEventId(): string {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return "e-" + Math.random().toString(36).slice(2) + "-" + Math.random().toString(36).slice(2);
}
