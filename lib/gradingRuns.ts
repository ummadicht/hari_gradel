import { db } from "./db";
import type { VisionCascadeResult } from "./visionAgents";

/**
 * Grading history — every time this session's photos were graded.
 *
 * A re-grade overwrites `sessions.cosmetic` in place, so before this the
 * previous verdict vanished the moment a new one landed. That is the one thing
 * an operator always asks about a changed grade: what did it say before, which
 * model produced it, and who asked for the re-run. Append-only; nothing here is
 * ever updated or deleted, and a failure to record a run must never fail the
 * grade it is describing.
 */

export type RunTrigger = "capture" | "refine" | "reprocess";

export type GradingRun = {
  id: number;
  session_id: string;
  grade: string;
  tier: string;
  /** Exact model string that answered — a tier is not a model. */
  model: string;
  escalated: boolean;
  score: number | null;
  findings: number;
  coverage: number | null;
  review: boolean;
  trigger: RunTrigger;
  actor: string;
  photos: number;
  at: string;
};

export function recordRun(
  sessionId: string,
  cosmetic: Partial<VisionCascadeResult>,
  opts: { trigger: RunTrigger; actor?: string; photos?: number },
): void {
  try {
    db.prepare(
      `INSERT INTO grading_runs
         (session_id, grade, tier, model, escalated, score, findings, coverage, review, trigger, actor, photos, snapshot)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sessionId,
      cosmetic.grade ?? "",
      cosmetic.tierUsed ?? "",
      cosmetic.visionModel ?? "",
      cosmetic.escalated ? 1 : 0,
      typeof cosmetic.score === "number" ? cosmetic.score : null,
      Array.isArray(cosmetic.findings) ? cosmetic.findings.length : 0,
      typeof cosmetic.coverage === "number" ? cosmetic.coverage : null,
      cosmetic.needsHumanReview ? 1 : 0,
      opts.trigger,
      (opts.actor || "").slice(0, 60),
      opts.photos ?? 0,
      JSON.stringify(cosmetic ?? {}),
    );
  } catch {
    /* history is a record of the work, never a gate on it */
  }
}

function hydrate(r: any): GradingRun {
  return {
    id: r.id,
    session_id: r.session_id,
    grade: r.grade,
    tier: r.tier,
    model: r.model ?? "",
    escalated: !!r.escalated,
    score: r.score,
    findings: r.findings,
    coverage: r.coverage,
    review: !!r.review,
    trigger: r.trigger,
    actor: r.actor,
    photos: r.photos,
    at: r.at,
  };
}

/** Every run for a session, oldest first. */
export function runsFor(sessionId: string): GradingRun[] {
  try {
    return (
      db.prepare("SELECT * FROM grading_runs WHERE session_id = ? ORDER BY id ASC").all(sessionId) as any[]
    ).map(hydrate);
  } catch {
    return [];
  }
}

/** The run before the newest one — what the grade used to say. */
export function previousRun(sessionId: string): GradingRun | null {
  const runs = runsFor(sessionId);
  return runs.length >= 2 ? runs[runs.length - 2] : null;
}

/** The stored cascade snapshot for one run, for inspecting a past verdict. */
export function runSnapshot(runId: number): Record<string, any> | null {
  try {
    const row = db.prepare("SELECT snapshot FROM grading_runs WHERE id = ?").get(runId) as
      | { snapshot: string }
      | undefined;
    return row ? JSON.parse(row.snapshot || "{}") : null;
  } catch {
    return null;
  }
}

export type GradeDiff = {
  changed: boolean;
  from: string;
  to: string;
  /** Movement on the ladder: negative = graded worse than before. */
  direction: "better" | "worse" | "same" | "unknown";
  tierFrom: string;
  tierTo: string;
  findingsFrom: number;
  findingsTo: number;
  /** Components whose grade differs between the two runs. */
  components: { id: string; from: string; to: string }[];
};

const LADDER = ["D", "C", "B", "A", "Premium"];

/**
 * What actually changed between two cascade results.
 *
 * Reporting "re-checked ✓" and reloading told the operator nothing — they had
 * to remember the old letter themselves. A diff is the entire point of a manual
 * re-run.
 */
export function diffRuns(
  before: Partial<VisionCascadeResult> | null,
  after: Partial<VisionCascadeResult>,
): GradeDiff {
  const from = before?.grade ?? "";
  const to = after.grade ?? "";
  const i = LADDER.indexOf(from);
  const j = LADDER.indexOf(to);
  const direction: GradeDiff["direction"] =
    i < 0 || j < 0 ? "unknown" : j > i ? "better" : j < i ? "worse" : "same";

  const bySide = (r: Partial<VisionCascadeResult> | null) =>
    Object.fromEntries((r?.specialists ?? []).map((s) => [s.id, s.grade || ""]));
  const b = bySide(before);
  const a = bySide(after);
  const components = Array.from(new Set([...Object.keys(b), ...Object.keys(a)]))
    .filter((k) => (b[k] ?? "") !== (a[k] ?? ""))
    .map((k) => ({ id: k, from: b[k] ?? "", to: a[k] ?? "" }));

  return {
    changed: from !== to || components.length > 0,
    from,
    to,
    direction,
    tierFrom: before?.tierUsed ?? "",
    tierTo: after.tierUsed ?? "",
    findingsFrom: before?.findings?.length ?? 0,
    findingsTo: after.findings?.length ?? 0,
    components,
  };
}
