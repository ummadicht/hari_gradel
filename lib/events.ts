import { db } from "./db";

/**
 * Session audit trail — append-only.
 *
 * Every meaningful transition writes one row. The console reconstructs the PATH
 * from these ("device-identification · stayed for 18s") and the audit log filters
 * across them. Two rules make the trail trustworthy:
 *
 *  1. APPEND ONLY. Nothing updates or deletes an event. Dwell time is derived by
 *     diffing consecutive rows, so editing one would silently rewrite history.
 *  2. NEVER THROWS. Logging is observability, not business logic — a failure to
 *     write an audit row must never fail the grade, the capture, or the offer.
 */

export const STEPS = [
  "layout",
  "device-identification",
  "cosmetics",
  "display",
  "battery",
  "functional-tests",
  "offer",
] as const;
export type Step = (typeof STEPS)[number];

export type SessionEvent = {
  id: number;
  session_id: string;
  step: string;
  event: string;
  detail: Record<string, any>;
  at: string;
};

export function logEvent(
  sessionId: string,
  step: Step | string,
  event: string,
  detail: Record<string, any> = {},
): void {
  try {
    db.prepare(
      "INSERT INTO session_events (session_id, step, event, detail) VALUES (?, ?, ?, ?)",
    ).run(sessionId, String(step).slice(0, 40), String(event).slice(0, 40), JSON.stringify(detail));
  } catch {
    /* audit must never break the flow it observes */
  }
}

function hydrate(r: any): SessionEvent {
  let detail: Record<string, any> = {};
  try {
    detail = JSON.parse(r.detail ?? "{}");
  } catch {
    /* keep the row even if its payload is corrupt */
  }
  return { id: r.id, session_id: r.session_id, step: r.step, event: r.event, detail, at: r.at };
}

export function eventsFor(sessionId: string): SessionEvent[] {
  return (
    db
      .prepare("SELECT * FROM session_events WHERE session_id = ? ORDER BY id ASC")
      .all(sessionId) as any[]
  ).map(hydrate);
}

export type PathStep = {
  step: string;
  firstAt: string;
  lastAt: string;
  /** Seconds between entering this step and entering the next one. */
  stayedSec: number | null;
  events: { event: string; at: string; detail: Record<string, any> }[];
};

/**
 * Collapse the raw trail into the PATH view: consecutive events of the same step
 * become one entry, and dwell time is (next step's start − this step's start).
 * The LAST step has no successor, so its dwell is null rather than a guess —
 * measuring it to "now" would make an abandoned session look like a long one.
 */
export function buildPath(events: SessionEvent[]): PathStep[] {
  const path: PathStep[] = [];
  for (const e of events) {
    const cur = path[path.length - 1];
    if (cur && cur.step === e.step) {
      cur.lastAt = e.at;
      cur.events.push({ event: e.event, at: e.at, detail: e.detail });
    } else {
      path.push({
        step: e.step,
        firstAt: e.at,
        lastAt: e.at,
        stayedSec: null,
        events: [{ event: e.event, at: e.at, detail: e.detail }],
      });
    }
  }
  for (let i = 0; i < path.length - 1; i++) {
    const a = Date.parse(path[i].firstAt.replace(" ", "T") + "Z");
    const b = Date.parse(path[i + 1].firstAt.replace(" ", "T") + "Z");
    path[i].stayedSec = Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, Math.round((b - a) / 1000)) : null;
  }
  return path;
}

/** "1s" · "18s" · "1m 7s" — the Pandas "Stayed for …" format. */
export function humanDuration(sec: number | null): string {
  if (sec == null) return "—";
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

export type AuditFilter = {
  clientIds?: string[]; // scope; empty/undefined = no client restriction (super only)
  client?: string;
  model?: string;
  grade?: string;
  step?: string;
  event?: string;
  since?: string; // ISO or 'YYYY-MM-DD'
  until?: string;
  limit?: number;
};

export type AuditRow = SessionEvent & {
  client_id: string;
  model: string;
  cosmetic_grade: string;
  overall_grade: string;
};

/**
 * The audit log: events joined to their session so it can be filtered by the
 * things an operator actually asks about — time, client, model, grade.
 * `clientIds` is the security scope and is applied separately from the `client`
 * filter, so a client admin narrowing by client can never widen past their own.
 */
export function auditLog(f: AuditFilter): AuditRow[] {
  const where: string[] = [];
  const args: any[] = [];

  if (f.clientIds?.length) {
    where.push(`s.client_id IN (${f.clientIds.map(() => "?").join(",")})`);
    args.push(...f.clientIds);
  }
  if (f.client) {
    where.push("s.client_id = ?");
    args.push(f.client);
  }
  if (f.model) {
    where.push("s.model LIKE ?");
    args.push(`%${f.model}%`);
  }
  if (f.grade) {
    where.push("s.cosmetic_grade = ?");
    args.push(f.grade);
  }
  if (f.step) {
    where.push("e.step = ?");
    args.push(f.step);
  }
  if (f.event) {
    where.push("e.event = ?");
    args.push(f.event);
  }
  if (f.since) {
    where.push("e.at >= ?");
    args.push(f.since);
  }
  if (f.until) {
    where.push("e.at <= ?");
    args.push(f.until);
  }

  const limit = Math.min(500, Math.max(1, f.limit ?? 200));
  const rows = db
    .prepare(
      `SELECT e.*, s.client_id, s.model, s.cosmetic_grade, s.overall_grade
       FROM session_events e
       JOIN sessions s ON s.id = e.session_id
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY e.id DESC LIMIT ?`,
    )
    .all(...args, limit) as any[];
  return rows.map((r) => ({ ...hydrate(r), client_id: r.client_id, model: r.model, cosmetic_grade: r.cosmetic_grade, overall_grade: r.overall_grade }));
}

/** Distinct values for the audit-log filter dropdowns, within scope. */
export function auditFacets(clientIds?: string[]) {
  const scoped = clientIds?.length ?? 0;
  const clause = scoped
    ? `WHERE client_id IN (${clientIds!.map(() => "?").join(",")}) AND `
    : "WHERE ";
  const args = scoped ? clientIds! : [];

  const distinct = (column: string): string[] =>
    (
      db
        .prepare(`SELECT DISTINCT ${column} AS v FROM sessions ${clause} ${column} != '' ORDER BY v`)
        .all(...args) as { v: string }[]
    )
      .map((r) => r.v)
      .filter(Boolean);

  return {
    models: distinct("model"),
    grades: distinct("cosmetic_grade"),
    steps: (db.prepare("SELECT DISTINCT step AS v FROM session_events ORDER BY v").all() as { v: string }[]).map((r) => r.v),
    events: (db.prepare("SELECT DISTINCT event AS v FROM session_events ORDER BY v").all() as { v: string }[]).map((r) => r.v),
  };
}
