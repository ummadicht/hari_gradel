import { db } from "./db";
import { MAX_EVENTS_PER_SESSION, MAX_EVENTS_PER_STEP } from "./capture/captureEvents";

/**
 * How each photograph was captured — and how each one FAILED to be captured.
 *
 * The session already records the capture GATE's verdict. What it has never
 * recorded is the numbers behind that verdict, or anything about frames that
 * were refused or steps that were abandoned. So the question worth asking
 * cannot currently be asked:
 *
 *     does poor capture quality predict an unstable grade?
 *
 * Answering it needs per-attempt measurements sitting next to the grading runs
 * they produced. `grading_runs` carries grade, score, tier and the exact model;
 * joining on session_id is what turns "AR guidance should improve consistency"
 * from a belief into a measurement.
 *
 * OBSERVATION MODE. Nothing here gates a capture, changes a grade, or shows a
 * message. It is a recording, and a failure to record must never cost the
 * seller their photo — every write is best-effort and every failure is counted
 * rather than thrown.
 *
 * This is the SQLite shape of the proposed `capture_attempts` table; UUID /
 * JSONB / TIMESTAMPTZ become TEXT, matching every other JSON column here.
 */

db.exec(`
  CREATE TABLE IF NOT EXISTS capture_telemetry (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    -- Client-generated idempotency key. sendBeacon has no response and no
    -- retry visibility, so a flaky network genuinely does deliver the same
    -- event twice; without this the duplicate becomes a second "attempt" and
    -- inflates exactly the retake metric this table exists to measure.
    event_id       TEXT NOT NULL UNIQUE,
    session_id     TEXT NOT NULL,
    client_id      TEXT NOT NULL DEFAULT '',
    surface        TEXT NOT NULL DEFAULT '',   -- v2cam | cosmetic
    -- stepId is the STABLE identifier (tenant journeys reorder and rename
    -- steps); stepLabel is what the operator actually saw. Grouping telemetry
    -- by a display label silently merges two different steps that happen to
    -- share a name, and splits one step that got reworded.
    step_id        TEXT NOT NULL DEFAULT '',
    step_label     TEXT NOT NULL DEFAULT '',
    photo_index    INTEGER NOT NULL DEFAULT -1,
    attempt        INTEGER NOT NULL DEFAULT 1,
    outcome        TEXT NOT NULL DEFAULT 'captured',
    measurements   TEXT NOT NULL DEFAULT '{}',
    -- What the SURFACE decided, and separately what guidance WOULD have said.
    actual_verdict TEXT NOT NULL DEFAULT '{}',
    experimental_instruction TEXT NOT NULL DEFAULT '',
    guidance       TEXT NOT NULL DEFAULT '{}',
    -- Two profiles, not one: the arithmetic and the acceptance rules are not
    -- the same thing and do not currently agree.
    measurement_profile TEXT NOT NULL DEFAULT '',
    acceptance_profile  TEXT NOT NULL DEFAULT '',
    at             TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_captel_session ON capture_telemetry(session_id, id);
  CREATE INDEX IF NOT EXISTS idx_captel_client  ON capture_telemetry(client_id, at);
  -- NOTE: the (session_id, step_id) index is created AFTER the migration below,
  -- not here. On a database that already has the Release 1 table, the CREATE
  -- TABLE above is a no-op, so step_id does not exist yet and indexing it here
  -- fails the whole statement — taking module load, and therefore the build,
  -- down with it.
`);

/**
 * Migrate installs that already have the Release 1 table.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op against an existing table, so a
 * deployed database keeps the old shape and every new column silently reads as
 * undefined. Production already holds real capture rows from live sessions —
 * dropping and recreating would destroy the only field data we have, which is
 * the entire point of Release 1.
 *
 * Additive columns, then a backfill, then the UNIQUE index LAST: the index
 * cannot be created until every existing row has a distinct event_id.
 */
for (const [col, def] of [
  ["event_id", "TEXT NOT NULL DEFAULT ''"],
  ["step_id", "TEXT NOT NULL DEFAULT ''"],
  ["step_label", "TEXT NOT NULL DEFAULT ''"],
  ["actual_verdict", "TEXT NOT NULL DEFAULT '{}'"],
  ["experimental_instruction", "TEXT NOT NULL DEFAULT ''"],
  ["measurement_profile", "TEXT NOT NULL DEFAULT ''"],
  ["acceptance_profile", "TEXT NOT NULL DEFAULT ''"],
] as const) {
  const has = (
    db.prepare("PRAGMA table_info(capture_telemetry)").all() as { name: string }[]
  ).some((c) => c.name === col);
  if (!has) {
    try {
      db.exec(`ALTER TABLE capture_telemetry ADD COLUMN ${col} ${def};`);
    } catch {
      /* concurrent init raced us — it exists now, which is all we wanted */
    }
  }
}

try {
  const cols = (db.prepare("PRAGMA table_info(capture_telemetry)").all() as { name: string }[])
    .map((c) => c.name);
  // Release 1 named these `step`, `instruction` and `profile`. Carry the values
  // across so the rows already collected stay comparable with new ones.
  if (cols.includes("step")) {
    db.exec("UPDATE capture_telemetry SET step_label = step WHERE step_label = '' AND step <> ''");
    db.exec("UPDATE capture_telemetry SET step_id = step WHERE step_id = '' AND step <> ''");
  }
  if (cols.includes("instruction")) {
    db.exec(
      "UPDATE capture_telemetry SET experimental_instruction = instruction WHERE experimental_instruction = '' AND instruction <> ''"
    );
  }
  if (cols.includes("profile")) {
    db.exec(
      "UPDATE capture_telemetry SET measurement_profile = profile WHERE measurement_profile = '' AND profile <> ''"
    );
  }
  // Pre-idempotency rows get a synthetic key derived from their row id, which
  // is unique by construction and cannot collide with a client UUID.
  db.exec("UPDATE capture_telemetry SET event_id = 'legacy-' || id WHERE event_id = ''");
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_captel_eventid ON capture_telemetry(event_id)"
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_captel_step ON capture_telemetry(session_id, step_id)"
  );
} catch {
  /* a legacy row with a genuine duplicate would block the index; leave it
     un-indexed rather than refusing to boot the app over telemetry */
}

export type RecordResult =
  | { ok: true }
  | { ok: false; reason: "duplicate" | "session_limit" | "step_limit" | "error" };

export type CaptureTelemetryInput = {
  eventId: string;
  sessionId: string;
  clientId?: string;
  surface?: string;
  stepId?: string;
  stepLabel?: string;
  photoIndex?: number;
  attempt?: number;
  outcome?: string;
  measurements?: unknown;
  actualVerdict?: unknown;
  experimentalInstruction?: string;
  guidance?: unknown;
  measurementProfile?: string;
  acceptanceProfile?: string;
};

/**
 * Returns WHY a write was refused rather than swallowing it. The caller logs
 * the reason — a silently dropped event is indistinguishable from a step that
 * never happened, which would quietly bias every retake statistic downward.
 */
export function recordCapture(t: CaptureTelemetryInput): RecordResult {
  try {
    const perSession = db
      .prepare("SELECT COUNT(*) AS n FROM capture_telemetry WHERE session_id = ?")
      .get(t.sessionId) as { n: number };
    if (perSession.n >= MAX_EVENTS_PER_SESSION) return { ok: false, reason: "session_limit" };

    if (t.stepId) {
      const perStep = db
        .prepare("SELECT COUNT(*) AS n FROM capture_telemetry WHERE session_id = ? AND step_id = ?")
        .get(t.sessionId, t.stepId) as { n: number };
      if (perStep.n >= MAX_EVENTS_PER_STEP) return { ok: false, reason: "step_limit" };
    }

    db.prepare(
      `INSERT INTO capture_telemetry
         (event_id, session_id, client_id, surface, step_id, step_label, photo_index,
          attempt, outcome, measurements, actual_verdict, experimental_instruction,
          guidance, measurement_profile, acceptance_profile)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      t.eventId,
      t.sessionId,
      (t.clientId || "").slice(0, 40),
      (t.surface || "").slice(0, 24),
      (t.stepId || "").slice(0, 60),
      (t.stepLabel || "").slice(0, 80),
      Number.isInteger(t.photoIndex) ? t.photoIndex : -1,
      Number.isInteger(t.attempt) ? t.attempt : 1,
      t.outcome || "captured",
      JSON.stringify(t.measurements ?? {}),
      JSON.stringify(t.actualVerdict ?? {}),
      (t.experimentalInstruction || "").slice(0, 32),
      JSON.stringify(t.guidance ?? {}),
      (t.measurementProfile || "").slice(0, 40),
      (t.acceptanceProfile || "").slice(0, 40)
    );
    return { ok: true };
  } catch (e) {
    // A UNIQUE violation on event_id is the idempotency key doing its job, not
    // a fault — the same event arrived twice and the second one is discarded.
    const msg = String((e as Error)?.message || "");
    const code = (e as { code?: string })?.code;
    if (msg.includes("UNIQUE") || /duplicate key/i.test(msg) || code === "23505") {
      return { ok: false, reason: "duplicate" };
    }
    return { ok: false, reason: "error" };
  }
}

export type CaptureTelemetryRow = {
  id: number;
  event_id: string;
  session_id: string;
  surface: string;
  step_id: string;
  step_label: string;
  photo_index: number;
  attempt: number;
  outcome: string;
  measurements: Record<string, unknown>;
  actual_verdict: Record<string, unknown>;
  experimental_instruction: string;
  guidance: Record<string, unknown>;
  measurement_profile: string;
  acceptance_profile: string;
  at: string;
};

const parse = (s: string) => {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return {};
  }
};

export function listCaptures(sessionId: string): CaptureTelemetryRow[] {
  try {
    return (
      db
        .prepare("SELECT * FROM capture_telemetry WHERE session_id = ? ORDER BY id")
        .all(sessionId) as Record<string, never>[]
    ).map((r: any) => ({
      ...r,
      measurements: parse(r.measurements),
      actual_verdict: parse(r.actual_verdict),
      guidance: parse(r.guidance),
    })) as CaptureTelemetryRow[];
  } catch {
    return [];
  }
}
