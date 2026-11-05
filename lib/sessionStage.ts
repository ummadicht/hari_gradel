/**
 * Where a session actually got to, and what is worth knowing about it.
 *
 * The monitor has always shown `status` — a column the app writes at three
 * points ("open" / "functional_done" / "graded"). That answers "did grading
 * finish", which is not the question an operator asks. The question is: of the
 * phones that started today, how many were photographed, how many were tested,
 * how many produced an offer, and where did the rest stop?
 *
 * Two orthogonal ideas, deliberately not merged:
 *
 *   STAGE — the furthest point on the journey this session reached. Ordered,
 *           one value, so sessions can be counted into a funnel.
 *   TAGS  — facts worth filtering on that are NOT positions on the journey:
 *           needs review, offer blocked, retakes, a camera fault, no Settings
 *           evidence. A session can carry several, or none.
 *
 * Folding tags into stage is the mistake this avoids. "Needs review" is not
 * further along than "graded" and not behind it, and a stage list containing
 * both stops being a funnel.
 *
 * Pure and dependency-free so it can be unit tested and reused server-side or
 * in the browser.
 */

export const STAGES = [
  "started", // a session row exists and nothing else happened
  "identified", // we know what the device is
  "capturing", // photos are arriving but the set is not complete
  "photographed", // the capture set passed the gate
  "tested", // functional results recorded
  "graded", // a cosmetic grade exists
  "offered", // a price was computed
  "accepted", // the seller took it
] as const;

export type Stage = (typeof STAGES)[number];

export const STAGE_LABEL: Record<Stage, string> = {
  started: "Started",
  identified: "Identified",
  capturing: "Capturing",
  photographed: "Photos done",
  tested: "Tested",
  graded: "Graded",
  offered: "Offered",
  accepted: "Accepted",
};

export type SessionTag =
  | "review" // AI asked for a human
  | "blocked" // offer withheld (cover, model mismatch, non-OEM…)
  | "retakes" // the capture gate sent them back
  | "abandoned-step" // an operator left a capture step without shooting it
  | "camera-fault" // optical assessment found real hardware damage
  | "no-settings" // no Settings/About screenshot was captured at all
  | "no-imei-proof" // a screenshot exists, but no IMEI was read from it
  | "stalled"; // stopped short of an offer and has not moved since

export const TAG_LABEL: Record<SessionTag, string> = {
  review: "Needs review",
  blocked: "Offer blocked",
  retakes: "Retaken",
  "abandoned-step": "Step abandoned",
  "camera-fault": "Camera fault",
  "no-settings": "No Settings shot",
  "no-imei-proof": "IMEI unproven",
  stalled: "Stalled",
};

/** Everything the derivation needs. All optional — a partial row degrades, never throws. */
export type StageInput = {
  imei?: string | null;
  model?: string | null;
  photoCount?: number | null;
  photoTarget?: number | null;
  captureVerdict?: string | null;
  functional?: Record<string, unknown> | null;
  cosmeticGrade?: string | null;
  review?: number | boolean | null;
  offer?: { offer?: unknown; blocked?: unknown } | null;
  accepted?: number | boolean | null;
  ocrImei?: string | null;
  /** How many Settings/About screenshots were captured. */
  ocrShots?: number | null;
  cameraAssessment?: { lenses?: { verdict?: string; findings?: { impact?: string }[] }[] } | null;
  /** Capture-attempt outcomes for this session (Phase 1 telemetry). */
  captureOutcomes?: string[] | null;
  updatedAt?: string | null;
  /** Injected so the function stays pure and testable. */
  now?: number;
};

/** A session short of an offer and untouched for this long is not in progress. */
export const STALL_MS = 45 * 60 * 1000;

export function deriveStage(i: StageInput): Stage {
  if (i.accepted) return "accepted";
  // An offer that exists but was BLOCKED is still an offer stage — the pipeline
  // ran to the end. Why it was withheld is a tag, not a lesser stage.
  if (i.offer && (i.offer.offer !== undefined || i.offer.blocked !== undefined)) return "offered";
  if (i.cosmeticGrade) return "graded";

  const fn = i.functional ?? {};
  // Only real verdicts count. A functional object full of "skip" means the
  // tests were walked past, not run.
  const answered = Object.values(fn).filter((v) => v === "pass" || v === "fail").length;
  if (answered > 0) return "tested";

  const n = i.photoCount ?? 0;
  if (n > 0) {
    const target = i.photoTarget ?? 6;
    // The server capture gate is the authority on "complete". Its absence is
    // not completion — a set that was never submitted is still capturing.
    if (i.captureVerdict === "ok" || n >= target) return "photographed";
    return "capturing";
  }

  if (i.imei || i.model) return "identified";
  return "started";
}

export function deriveTags(i: StageInput): SessionTag[] {
  const tags: SessionTag[] = [];

  if (i.review) tags.push("review");
  if (i.offer?.blocked) tags.push("blocked");

  const outcomes = i.captureOutcomes ?? [];
  if (outcomes.includes("rejected_server") || outcomes.includes("replaced")) tags.push("retakes");
  if (outcomes.includes("abandoned")) tags.push("abandoned-step");

  const lenses = i.cameraAssessment?.lenses ?? [];
  // Only a genuine `fault` counts. A smudged lens and a cracked one both look
  // bad in a photograph, and only one of them is worth money.
  if (
    lenses.some(
      (l) => l.verdict === "faulty" || (l.findings ?? []).some((f) => f.impact === "fault")
    )
  ) {
    tags.push("camera-fault");
  }

  /**
   * Two DIFFERENT failures, deliberately separated.
   *
   * Measured on production: 27 of 59 sessions captured a Settings screenshot,
   * and ZERO of 59 produced an `ocr.imei`. Collapsing both into one tag made it
   * fire on every session, which makes it useless as a filter and hides the
   * actual problem — evidence is being captured and then not read.
   *
   * This matters beyond the monitor: the OCR'd IMEI is what overwrites a typed
   * one, so the anti-substitution path everyone assumes exists has never
   * actually fired in production.
   */
  if (!i.ocrShots) tags.push("no-settings");
  else if (!i.ocrImei) tags.push("no-imei-proof");

  const stage = deriveStage(i);
  if (stage !== "offered" && stage !== "accepted" && i.updatedAt) {
    const t = Date.parse(i.updatedAt.replace(" ", "T") + (i.updatedAt.endsWith("Z") ? "" : "Z"));
    const now = i.now ?? Date.now();
    if (Number.isFinite(t) && now - t > STALL_MS) tags.push("stalled");
  }

  return tags;
}

export function describeSession(i: StageInput): { stage: Stage; tags: SessionTag[] } {
  return { stage: deriveStage(i), tags: deriveTags(i) };
}

/** Funnel counts, in journey order — every stage present even at zero. */
export function funnel(sessions: StageInput[]): { stage: Stage; count: number }[] {
  const counts = new Map<Stage, number>(STAGES.map((s) => [s, 0]));
  for (const s of sessions) counts.set(deriveStage(s), (counts.get(deriveStage(s)) ?? 0) + 1);
  return STAGES.map((stage) => ({ stage, count: counts.get(stage) ?? 0 }));
}

/**
 * CUMULATIVE funnel — "how many reached at least this far".
 *
 * Deliberately separate from `funnel()` above, which is TERMINAL ("how many
 * stopped here"). Both are legitimate and they answer different questions:
 * a conversion view wants cumulative, a "what is stuck" view wants terminal.
 * The console previously had a cumulative funnel hand-rolled inside
 * CommandCenter with its own rules (`photo_count >= 4`), so the two screens
 * could and did disagree about the same session. One derivation, two views.
 */
export function reachedFunnel(
  sessions: (StageInput | { stage: Stage })[]
): { stage: Stage; count: number }[] {
  const idx = new Map<Stage, number>(STAGES.map((s, i) => [s, i]));
  const reached = STAGES.map((stage) => ({ stage, count: 0 }));
  for (const s of sessions) {
    // Accept an ALREADY-DERIVED stage. The API derives it once server-side; a
    // client re-deriving it from raw columns is how the two views drifted apart
    // in the first place.
    const st = "stage" in s && typeof (s as { stage: Stage }).stage === "string"
      ? (s as { stage: Stage }).stage
      : deriveStage(s as StageInput);
    const at = idx.get(st) ?? 0;
    for (let i = 0; i <= at; i++) reached[i].count++;
  }
  return reached;
}

/** How urgently a session needs a human. Ordered; higher wins. */
export type Severity = "hold" | "review" | "gap" | "stalled" | "normal";

export const SEVERITY_RANK: Record<Severity, number> = {
  hold: 4,
  review: 3,
  gap: 2,
  stalled: 1,
  normal: 0,
};

/**
 * Replaces CommandCenter's `riskFor()`, which was a FOURTH opinion on the same
 * facts — it scored `photo_count < 4` as an evidence gap while the funnel beside
 * it counted `>= 4` as complete, and neither agreed with the capture gate.
 *
 * Derived from tags, so a rule only ever has to change in one place.
 */
export function severityFor(
  i: StageInput | { stage: Stage; tags: SessionTag[] }
): { level: Severity; reason: string } {
  // Accept ALREADY-DERIVED stage/tags. The API derives them server-side and
  // strips the raw columns before responding, so a browser caller has no
  // `ocrShots` or `cameraAssessment` to recompute from — silently re-deriving
  // there would flag every session as missing evidence it never received.
  const pre = "tags" in i && Array.isArray((i as { tags: SessionTag[] }).tags);
  const tags = pre ? (i as { tags: SessionTag[] }).tags : deriveTags(i as StageInput);
  const stage = pre ? (i as { stage: Stage }).stage : deriveStage(i as StageInput);

  // Money is involved and something says do not pay yet.
  if (tags.includes("blocked")) return { level: "hold", reason: "Offer blocked by a hard-stop rule" };
  if (tags.includes("camera-fault")) return { level: "hold", reason: "Camera hardware fault found" };
  if (tags.includes("review")) return { level: "review", reason: "AI inspection asked for a human" };

  // An identity gap only MATTERS once a price exists — before that the seller
  // simply has not reached the Settings step yet, and flagging it would light
  // up every in-progress session.
  if ((stage === "offered" || stage === "accepted") && (tags.includes("no-settings") || tags.includes("no-imei-proof"))) {
    return { level: "gap", reason: "Priced without a verified IMEI" };
  }

  if (tags.includes("stalled")) return { level: "stalled", reason: "Stopped short of an offer" };
  return { level: "normal", reason: "No exception signal" };
}

/**
 * The levels that mean SOMEBODY MUST DECIDE SOMETHING.
 *
 * `stalled` is deliberately excluded. A stalled session is a seller who walked
 * away — funnel dropoff, not a pending decision — and on real data it is the
 * most common state by far (22 of 59 on prod, essentially all of a dev
 * database). Counting it into a red badge makes the badge read "110 of 110",
 * which teaches an operator to ignore the one number that should always be
 * worth looking at. It stays available as a filter, just not as an alarm.
 */
export const ACTIONABLE: Severity[] = ["hold", "review", "gap"];

/** Sessions needing attention, worst first. */
export function exceptions<T extends StageInput | { stage: Stage; tags: SessionTag[] }>(
  sessions: T[]
): { session: T; level: Severity; reason: string }[] {
  return sessions
    .map((session) => ({ session, ...severityFor(session) }))
    .filter((x) => x.level !== "normal")
    .sort((a, b) => SEVERITY_RANK[b.level] - SEVERITY_RANK[a.level]);
}
