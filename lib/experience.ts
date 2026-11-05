/**
 * Experience mode — WHO is looking, not what the engine does.
 *
 * "consumer"  — the seller trading in their own phone. They get plain inspection
 *               language and standard comments. They are NOT shown that a model
 *               graded it, which vendor it was, which tier ran, or raw model
 *               confidences: that is our implementation detail, and surfacing it
 *               invites "the robot got it wrong" rather than a conversation about
 *               the actual evidence (which IS shown — photos, marks, reasons).
 * "operator"  — store counter / warehouse / back-office. Gets the full technical
 *               trail: provider, tier, escalation, confidences, review flags.
 *
 * CRITICAL INVARIANT: this changes PRESENTATION ONLY. It must never reach the
 * capture gate, the inspection prompt, the grade math, or the offer engine — no
 * module under lib/ that computes an outcome may import this. The same photos
 * must produce the same grade and the same price in both modes.
 */

export type ExperienceId = "consumer" | "operator";

export const DEFAULT_EXPERIENCE: ExperienceId = "consumer";

/**
 * Resolve the experience. Operator presentation is granted by STAFF AUTH, not by
 * a URL — a seller cannot flip themselves into the operator view, and an
 * operator never has to. `?mode=` is honoured only to force the *consumer* view
 * (useful for staff previewing what a seller sees).
 */
export function resolveExperience(opts: {
  authed?: boolean;
  requested?: string | null;
}): ExperienceId {
  const req = (opts.requested || "").toLowerCase().trim();
  if (req === "consumer") return "consumer"; // staff previewing the seller view
  return opts.authed ? "operator" : "consumer";
}

/**
 * Consumer-facing wording for things the engine describes technically.
 *
 * These are the "standard comments" — fixed, human phrasing that says what was
 * checked and what was found, without naming the machinery behind it.
 */
export const CONSUMER_TX = {
  inspectionTitle: "Condition report",
  inspectionSub: "What we checked on each side.",
  liveBadge: "Checked",
  gradedBy: "GradeIQ",
  componentGrading: "Condition by part",
  displayCheck: "Screen check",
  offerLoading: "Preparing your offer…",
  evidenceNote:
    "The exact photos we assessed, with every mark we found boxed and labelled. Nothing is entered by hand.",
  notConfident: "We couldn't confirm the condition",
  notConfidentBody:
    "The photos weren't clear enough to be sure, so this is a provisional figure.",
  needsReview: "Being double-checked",
  needsReviewBody:
    "A specialist is confirming this one before it's finalised — you don't need to do anything.",
  notGraded: "Not checked from photos yet",
  takePhotos: "take photos for an instant condition check",
  // SUP-63: the background grade died. Say so, and say who acts: not the seller.
  unfinished: "Grading didn't finish",
  unfinishedBody:
    "We couldn't finish checking your phone's condition from the photos. Someone at the store will check it again. You don't need to do anything.",
} as const;

/** Operator wording — the honest technical trail. */
export const OPERATOR_TX = {
  inspectionTitle: "AI inspection",
  inspectionSub: "What the camera looked for, side by side.",
  liveBadge: "Live AI",
  gradedBy: "GradeIQ Vision AI",
  componentGrading: "Component grading · Vision AI",
  displayCheck: "Display — AI validated",
  offerLoading: "Generating AI trade-in offer…",
  evidenceNote:
    "The exact frames the AI graded, with every located defect boxed and tagged. Nothing is entered by hand.",
  notConfident: "AI not confident",
  notConfidentBody:
    "The model couldn't confirm the condition from the photos, so the grade is provisional.",
  /* SAY WHICH ONE, NOT ALL THREE.
   *
   * The old copy listed every possible trigger — "low confidence, a model
   * mismatch, or a suspected non-OEM part" — leaving the reader to work out
   * which actually fired. On a report whose Model Identity panel already says
   * "mismatch" in red, a banner hedging across three causes reads as vague
   * boilerplate and gets skipped. The specific reason is right there on the
   * page; this line's job is only to say what to DO about it. */
  needsReview: "Needs a second look before payout",
  needsReviewBody:
    "Something on this report needs confirming by a person — see the flagged panel below for what it is.",
  notGraded: "Not graded by camera yet",
  takePhotos: "take photos for an AI grade",
  unfinished: "Grading did not finish",
  unfinishedBody:
    "The background grade never came back and nothing is still working on it. Re-grade to settle it.",
} as const;

export function tx(experience: ExperienceId) {
  return experience === "operator" ? OPERATOR_TX : CONSUMER_TX;
}
