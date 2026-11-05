import { db } from "./db";

/**
 * Append-only record of every contradiction and every process violation.
 *
 * WHY THIS EXISTS — the failure it prevents:
 *
 * GradeIQ already detects identity fraud. `checkIdentity()` returns
 * match/mismatch/unverified and `computeTrust()` hard-caps the score at 35 on a
 * mismatch. But all of it is DERIVED AT RENDER TIME from the current session
 * row, and one write path actively destroys the evidence it depends on:
 * `/api/sessions/[id]/ocr` overwrites `s.imei` with the OCR'd IMEI. So if a
 * seller types phone 1's IMEI and shows phone 2's Settings screen, the session
 * silently becomes phone 2 — and `checkIdentity()` then compares phone 2 with
 * phone 2 and reports "match". The fraud erases its own evidence.
 *
 * A derived check can be undone by a later write. A recorded event cannot.
 *
 * THE RULE: RECORD BEFORE RECONCILE. The event is written at the moment of
 * disagreement, before any field is updated. Rows are never edited — a
 * resolution is a NEW row referencing the old one, exactly like `session_events`
 * and `grading_runs`.
 */

db.exec(`
  CREATE TABLE IF NOT EXISTS compliance_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,
    client_id   TEXT NOT NULL DEFAULT '',
    -- family.kind, e.g. identity.imei_mismatch
    kind        TEXT NOT NULL,
    severity    TEXT NOT NULL DEFAULT 'record',  -- block | flag | record
    -- Both sides of the contradiction, verbatim. Storing only "mismatch" makes
    -- a dispute unarguable in the wrong direction: you cannot show WHAT
    -- disagreed months later.
    expected    TEXT NOT NULL DEFAULT '',
    observed    TEXT NOT NULL DEFAULT '',
    source      TEXT NOT NULL DEFAULT '',        -- typed | ocr | vision | fingerprint | imei_lookup | process
    detail      TEXT NOT NULL DEFAULT '{}',
    actor       TEXT NOT NULL DEFAULT '',
    at          TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_comp_session ON compliance_events(session_id, id);
  CREATE INDEX IF NOT EXISTS idx_comp_kind    ON compliance_events(kind, at);
  CREATE INDEX IF NOT EXISTS idx_comp_client  ON compliance_events(client_id, at);
`);

import {
  COMPLIANCE_KINDS,
  isComplianceKind,
  DEFAULT_SEVERITY,
  type ComplianceKind,
  type ComplianceSeverity,
} from "./complianceKinds";

export {
  COMPLIANCE_KINDS,
  isComplianceKind,
  DEFAULT_SEVERITY,
  type ComplianceKind,
  type ComplianceSeverity,
};

export type ComplianceInput = {
  sessionId: string;
  clientId?: string;
  kind: ComplianceKind;
  severity?: ComplianceSeverity;
  expected?: unknown;
  observed?: unknown;
  source?: string;
  detail?: unknown;
  actor?: string;
};

/**
 * Best-effort by construction: a failure to record must never break the flow it
 * is observing. But unlike telemetry, a failed write here is worth knowing
 * about, so the boolean is returned rather than swallowed.
 */
export function recordCompliance(e: ComplianceInput): boolean {
  try {
    db.prepare(
      `INSERT INTO compliance_events
         (session_id, client_id, kind, severity, expected, observed, source, detail, actor)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      e.sessionId,
      (e.clientId || "").slice(0, 40),
      e.kind,
      e.severity || DEFAULT_SEVERITY[e.kind] || "record",
      String(e.expected ?? "").slice(0, 120),
      String(e.observed ?? "").slice(0, 120),
      (e.source || "").slice(0, 24),
      JSON.stringify(e.detail ?? {}),
      (e.actor || "").slice(0, 60)
    );
    return true;
  } catch {
    return false;
  }
}

export type ComplianceRow = {
  id: number;
  session_id: string;
  kind: ComplianceKind;
  severity: ComplianceSeverity;
  expected: string;
  observed: string;
  source: string;
  detail: Record<string, unknown>;
  actor: string;
  at: string;
};

export function listCompliance(sessionId: string): ComplianceRow[] {
  try {
    return (
      db
        .prepare("SELECT * FROM compliance_events WHERE session_id = ? ORDER BY id")
        .all(sessionId) as Record<string, unknown>[]
    ).map((r: any) => {
      let detail = {};
      try {
        detail = JSON.parse(r.detail || "{}");
      } catch {
        /* a malformed detail must not hide the event it belongs to */
      }
      return { ...r, detail } as ComplianceRow;
    });
  } catch {
    return [];
  }
}

/** Does anything on this session stop money moving? */
export function hasBlockingCompliance(sessionId: string): boolean {
  try {
    const r = db
      .prepare("SELECT COUNT(*) AS n FROM compliance_events WHERE session_id = ? AND severity = 'block'")
      .get(sessionId) as { n: number };
    return r.n > 0;
  } catch {
    return false;
  }
}

/**
 * Freshness window for a challenge-response screenshot.
 *
 * NOT 60 seconds. The real round trip is: leave the browser → open the dialer →
 * dial → screenshot → return → find the file in the picker. On iOS that is
 * routinely 45–90s for someone doing it the first time, and a backgrounded
 * Safari tab can be discarded outright. A 60s window would reject a large share
 * of honest sellers and teach operators to disable the check.
 *
 * Start wide, measure the real distribution from the recorded events, then
 * tighten on evidence.
 */
export const SCREENSHOT_TTL_MS = 180_000;

/**
 * Was this screenshot taken during the challenge?
 *
 * BOTH timestamps come from the DEVICE clock — `issuedAt` is captured by the
 * browser when the challenge is shown, and `takenAt` is the file's own
 * `lastModified`. Comparing the file against a SERVER time instead would fail
 * every phone whose clock is a few minutes off; comparing device-to-device makes
 * the skew cancel.
 *
 * This is a speed bump, not proof — on Android a file manager can rewrite an
 * mtime. It raises cost and, more importantly, leaves a record.
 */
export function checkScreenshotFreshness(
  issuedAt: number,
  takenAt: number,
  ttlMs: number = SCREENSHOT_TTL_MS
): { fresh: boolean; ageMs: number; reason: string } {
  if (!Number.isFinite(issuedAt) || !Number.isFinite(takenAt) || takenAt <= 0) {
    return { fresh: false, ageMs: 0, reason: "no timestamp on the image" };
  }
  const ageMs = takenAt - issuedAt;
  // Predating the challenge is the interesting case: a picture that existed
  // before we asked for it was taken of something else, possibly another phone.
  if (ageMs < -5_000) return { fresh: false, ageMs, reason: "taken before the check started" };
  if (ageMs > ttlMs) {
    return { fresh: false, ageMs, reason: `taken ${Math.round(ageMs / 1000)}s ago, limit ${Math.round(ttlMs / 1000)}s` };
  }
  return { fresh: true, ageMs, reason: "" };
}
