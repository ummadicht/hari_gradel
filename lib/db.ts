import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createPostgresDb, getPostgresUrl } from "./pgAdapter";

// Single shared connection (cached across hot-reloads in dev).
const g = globalThis as unknown as { __gradeiq_db?: Database.Database };

function init(): Database.Database {
  const dir = path.join(process.cwd(), "data");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, "uploads"), { recursive: true });
  const pgUrl = getPostgresUrl();
  const db: Database.Database = pgUrl
    ? createPostgresDb(pgUrl)
    : new Database(path.join(dir, "gradeiq.db"));
  if (!pgUrl) {
    db.pragma("journal_mode = WAL");
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id              TEXT PRIMARY KEY,          -- short join token, e.g. "k3f9q2"
      imei            TEXT NOT NULL DEFAULT '',
      model           TEXT NOT NULL DEFAULT '',
      status          TEXT NOT NULL DEFAULT 'open', -- open | functional_done | graded
      functional      TEXT NOT NULL DEFAULT '{}',   -- { [testId]: 'pass'|'fail'|'skip' }
      cosmetic        TEXT NOT NULL DEFAULT '{}',   -- Gemini result { grade, confidence, defects, notes }
      photos          TEXT NOT NULL DEFAULT '[]',   -- ['/uploads/<file>.jpg', ...]
      functional_grade TEXT NOT NULL DEFAULT '',    -- 'Working' | 'Faulty' | ''
      cosmetic_grade  TEXT NOT NULL DEFAULT '',      -- 'Premium'|'A'|'B'|'C'|'D'|''
      overall_grade   TEXT NOT NULL DEFAULT '',
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Append-only audit trail. Every meaningful transition in a journey lands
    -- here so the console can reconstruct the PATH ("device-identification —
    -- stayed for 18s") and answer "what actually happened to this device".
    -- Never updated or deleted: dwell time is derived by diffing consecutive
    -- rows, so mutating one would rewrite history.
    CREATE TABLE IF NOT EXISTS session_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      step       TEXT NOT NULL,   -- layout | device-identification | cosmetics | …
      event      TEXT NOT NULL,   -- enter | graded | rejected | offer | accepted …
      detail     TEXT NOT NULL DEFAULT '{}',
      at         TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_events_session ON session_events(session_id, id);
    CREATE INDEX IF NOT EXISTS idx_events_at ON session_events(at);

    -- GRADING RUNS — one row per time this session's photos were graded.
    -- Re-grading overwrites sessions.cosmetic in place, so without this the
    -- previous verdict was simply gone: nobody could answer "it said A this
    -- morning, why does it say C now?". Append-only, like session_events.
    CREATE TABLE IF NOT EXISTS grading_runs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id   TEXT NOT NULL,
      grade        TEXT NOT NULL DEFAULT '',   -- cosmetic grade this run produced
      tier         TEXT NOT NULL DEFAULT '',   -- stub | flash | pro
      escalated    INTEGER NOT NULL DEFAULT 0,
      score        REAL,
      findings     INTEGER NOT NULL DEFAULT 0,
      coverage     REAL,
      review       INTEGER NOT NULL DEFAULT 0, -- needsHumanReview
      trigger      TEXT NOT NULL DEFAULT 'capture', -- capture | refine | reprocess
      actor        TEXT NOT NULL DEFAULT '',   -- who asked for it ('' = the flow itself)
      photos       INTEGER NOT NULL DEFAULT 0,
      -- The full cascade result, so a past run can be inspected, not just counted.
      snapshot     TEXT NOT NULL DEFAULT '{}',
      at           TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_runs_session ON grading_runs(session_id, id);

    -- Per-client API keys. A client integrates with GradeIQ by calling the
    -- public /api/v1/* surface with a Bearer key that is SCOPED to their tenant.
    -- We store only a SHA-256 hash of the key (never the key itself) plus a
    -- short display prefix, so a leaked database can't be used to call the API.
    CREATE TABLE IF NOT EXISTS api_keys (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id   TEXT NOT NULL,
      label       TEXT NOT NULL DEFAULT '',
      prefix      TEXT NOT NULL,            -- first chars, shown so a key is recognisable
      hash        TEXT NOT NULL,            -- sha256(fullKey) — the only stored form
      scopes      TEXT NOT NULL DEFAULT 'read', -- csv: read[,reprocess]
      created_by  TEXT NOT NULL DEFAULT '',
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT,
      revoked_at  TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_apikeys_hash ON api_keys(hash);
    CREATE INDEX IF NOT EXISTS idx_apikeys_client ON api_keys(client_id);

    -- PER-IMEI LOOKUP CACHE (lib/imeiCache.ts). Every IMEI lookup spends paid
    -- Phonecheck calls (station GetDeviceInfo, then GSMA CheckEsn), and the same
    -- IMEI is asked again and again — SwapUp's resolve, then session create, a
    -- rescan, a reissue. One row per IMEI holds the identity AND the one
    -- Phonecheck answer it came from; a row younger than the TTL (24 h, so a
    -- lost/stolen report still lands the next day) answers with no call at all.
    CREATE TABLE IF NOT EXISTS imei_lookups (
      imei       TEXT PRIMARY KEY,
      info       TEXT NOT NULL,              -- ImeiInfo JSON
      phonecheck TEXT NOT NULL DEFAULT '{}', -- the PhonecheckReport it was derived from
      at         TEXT NOT NULL               -- ISO time of the paid lookup
    );

    -- PAID LOOKUP COUNTER (lib/lookupBudget.ts). One row per UTC day, caller
    -- IP and kind of caller, counting the IMEI lookups that actually spent a
    -- Phonecheck call ('paid') and the ones held back by the per-IP daily limit
    -- or because the caller had no right to one ('skipped') or by the daily
    -- total for all anonymous callers ('ceiling'). Both anonymous limits are
    -- read from here, and staff see the day's totals.
    CREATE TABLE IF NOT EXISTS paid_lookups (
      day     TEXT NOT NULL,               -- UTC yyyy-mm-dd
      ip      TEXT NOT NULL,               -- first X-Forwarded-For entry ('' = none)
      caller  TEXT NOT NULL,               -- server | retail | staff | channel | anonymous | internal
      outcome TEXT NOT NULL,               -- paid | skipped | ceiling
      n       INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, ip, caller, outcome)
    );

    -- CALL BUDGET (lib/lookupBudget.ts, SUP-80). Anonymous uploads and vision
    -- calls let through ('allowed') or refused with a 429 ('refused'), per
    -- caller IP per UTC hour and per session per UTC day. The limits are read
    -- from here; rows older than two weeks are dropped.
    CREATE TABLE IF NOT EXISTS call_budget (
      budget  TEXT NOT NULL,               -- uploads
      win     TEXT NOT NULL,               -- UTC yyyy-mm-ddThh (scope ip) | yyyy-mm-dd (scope session)
      scope   TEXT NOT NULL,               -- ip | session
      k       TEXT NOT NULL,               -- the IP ('' = none) or the session id
      outcome TEXT NOT NULL,               -- allowed | refused
      n       INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (budget, win, scope, k, outcome)
    );

    -- HARDWARE & BROWSER SENSOR SCANS. Persists every sensor scan run (full or
    -- single-sensor) with customer/device phone, IMEI, model, store metadata,
    -- timestamp, and IANA timezone.
    CREATE TABLE IF NOT EXISTS sensor_scans (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id      TEXT NOT NULL DEFAULT '',
      client_id       TEXT NOT NULL DEFAULT 'default',
      phone           TEXT NOT NULL DEFAULT '',
      imei            TEXT NOT NULL DEFAULT '',
      model           TEXT NOT NULL DEFAULT '',
      store_id        TEXT NOT NULL DEFAULT '',
      store_name      TEXT NOT NULL DEFAULT '',
      store_info      TEXT NOT NULL DEFAULT '{}',
      pass_count      INTEGER NOT NULL DEFAULT 0,
      fail_count      INTEGER NOT NULL DEFAULT 0,
      skip_count      INTEGER NOT NULL DEFAULT 0,
      total_count     INTEGER NOT NULL DEFAULT 0,
      duration_ms     INTEGER NOT NULL DEFAULT 0,
      functional_map  TEXT NOT NULL DEFAULT '{}',
      sensor_readings TEXT NOT NULL DEFAULT '[]',
      device_info     TEXT NOT NULL DEFAULT '{}',
      scanned_at      TEXT NOT NULL DEFAULT (datetime('now')),
      timezone        TEXT NOT NULL DEFAULT 'UTC',
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sensor_scans_client ON sensor_scans(client_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_sensor_scans_session ON sensor_scans(session_id);
    CREATE INDEX IF NOT EXISTS idx_sensor_scans_imei ON sensor_scans(imei);

    -- STORES DIRECTORY. Persists retail / partner store information per client.
    CREATE TABLE IF NOT EXISTS stores (
      id          TEXT PRIMARY KEY,
      client_id   TEXT NOT NULL DEFAULT 'default',
      store_name  TEXT NOT NULL DEFAULT '',
      branch      TEXT NOT NULL DEFAULT '',
      phone       TEXT NOT NULL DEFAULT '',
      address     TEXT NOT NULL DEFAULT '',
      city        TEXT NOT NULL DEFAULT '',
      timezone    TEXT NOT NULL DEFAULT 'UTC',
      vpa         TEXT NOT NULL DEFAULT '',
      operator    TEXT NOT NULL DEFAULT '',
      store_info  TEXT NOT NULL DEFAULT '{}',
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_stores_client ON stores(client_id, updated_at);

    -- DIAGNOSTIC SUMMARY REPORTS. Persists generated summary PDFs and diagnostic
    -- outcome snapshots per client/store with phone, IMEI, datetime, and timezone.
    CREATE TABLE IF NOT EXISTS diagnostic_reports (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id       TEXT NOT NULL DEFAULT 'default',
      session_id      TEXT NOT NULL DEFAULT '',
      phone           TEXT NOT NULL DEFAULT '',
      imei            TEXT NOT NULL DEFAULT '',
      store_id        TEXT NOT NULL DEFAULT '',
      store_name      TEXT NOT NULL DEFAULT '',
      store_info      TEXT NOT NULL DEFAULT '{}',
      pass_count      INTEGER NOT NULL DEFAULT 0,
      fail_count      INTEGER NOT NULL DEFAULT 0,
      skip_count      INTEGER NOT NULL DEFAULT 0,
      total_checks    INTEGER NOT NULL DEFAULT 0,
      sessions_count  INTEGER NOT NULL DEFAULT 0,
      report_payload  TEXT NOT NULL DEFAULT '{}',
      generated_at    TEXT NOT NULL DEFAULT (datetime('now')),
      timezone        TEXT NOT NULL DEFAULT 'UTC',
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_diag_reports_client ON diagnostic_reports(client_id, created_at);
  `);

  // grading_runs gained `model` after the first release. Its own doc comment
  // always promised "which model produced it", but only the TIER was stored —
  // and a tier is not a model. Pro currently resolves to a PREVIEW alias, which
  // Google may re-point to a new build at any time; without the exact string on
  // every run, a grade shifting under us would be indistinguishable from noise.
  for (const [col, def] of [["model", "TEXT NOT NULL DEFAULT ''"]] as const) {
    const has = (
      db.prepare("PRAGMA table_info(grading_runs)").all() as { name: string }[]
    ).some((c) => c.name === col);
    if (!has) {
      try {
        db.exec(`ALTER TABLE grading_runs ADD COLUMN ${col} ${def};`);
      } catch {
        // Concurrent init raced us — it exists now, which is all we wanted.
      }
    }
  }

  // Lightweight migrations for columns added after the first release.
  for (const [col, def] of [
    ["profile", "TEXT NOT NULL DEFAULT '{}'"],
    ["device", "TEXT NOT NULL DEFAULT '{}'"],
    ["imei_info", "TEXT NOT NULL DEFAULT '{}'"],
    ["phonecheck", "TEXT NOT NULL DEFAULT '{}'"],
    ["offer", "TEXT NOT NULL DEFAULT '{}'"],
    ["accepted", "INTEGER NOT NULL DEFAULT 0"],
    ["verification", "TEXT NOT NULL DEFAULT '{}'"],
    ["assessments", "TEXT NOT NULL DEFAULT '[]'"],
    ["parts", "TEXT NOT NULL DEFAULT '{}'"],
    ["screen", "TEXT NOT NULL DEFAULT '{}'"],
    ["camera", "TEXT NOT NULL DEFAULT '{}'"],
    ["ocr", "TEXT NOT NULL DEFAULT '{}'"],
    ["client_id", "TEXT NOT NULL DEFAULT 'default'"], // per-tenant pricing (swapmore|default)
    ["video", "TEXT NOT NULL DEFAULT ''"], // background rotation-video capture (/api/uploads/<id>.webm)
    ["capture", "TEXT NOT NULL DEFAULT '{}'"], // capture-gate verdict: {verdict,code,reasons,attempt}
    /* Frames held between the capture gate and the final grade. The gate pass
       used to receive six photos, judge them and discard them, so the submit
       that followed re-sent the identical set — the same ten-to-twenty
       megabytes twice from a phone, under one unchanging "Checking the
       photos…". Holding them here makes the second call carry no images. */
    ["staged", "TEXT NOT NULL DEFAULT ''"],
    ["phone", "TEXT NOT NULL DEFAULT ''"],
    ["recorded_at", "TEXT NOT NULL DEFAULT ''"],
    ["timezone", "TEXT NOT NULL DEFAULT 'UTC'"],
    ["store_id", "TEXT NOT NULL DEFAULT ''"],
    ["store_name", "TEXT NOT NULL DEFAULT ''"],
    ["store_info", "TEXT NOT NULL DEFAULT '{}'"],
    ["sensor_scan", "TEXT NOT NULL DEFAULT '{}'"],
  ] as const) {
    const has = (
      db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]
    ).some((c) => c.name === col);
    if (!has) {
      try {
        db.exec(`ALTER TABLE sessions ADD COLUMN ${col} ${def};`);
      } catch {
        // Concurrent init (e.g. Next's multi-worker build all opening the same DB)
        // can race the ADD COLUMN → "duplicate column name". Harmless: it exists now.
      }
    }
  }

  return db;
}

export const db = g.__gradeiq_db ?? (g.__gradeiq_db = init());

export type SessionRow = {
  id: string;
  imei: string;
  phone: string;
  model: string;
  status: string;
  functional: string;
  cosmetic: string;
  photos: string;
  functional_grade: string;
  cosmetic_grade: string;
  overall_grade: string;
  profile: string;
  device: string;
  imei_info: string;
  phonecheck: string;
  offer: string;
  accepted: number;
  verification: string;
  assessments: string;
  parts: string;
  screen: string;
  camera: string;
  ocr: string;
  client_id: string;
  video: string;
  capture: string;
  recorded_at: string;
  timezone: string;
  store_id: string;
  store_name: string;
  store_info: string;
  sensor_scan: string;
  created_at: string;
  updated_at: string;
};

export type Session = Omit<
  SessionRow,
  | "functional"
  | "cosmetic"
  | "photos"
  | "profile"
  | "device"
  | "imei_info"
  | "phonecheck"
  | "offer"
  | "verification"
  | "assessments"
  | "parts"
  | "screen"
  | "camera"
  | "ocr"
  | "capture"
  | "store_info"
  | "sensor_scan"
> & {
  functional: Record<string, "pass" | "fail" | "skip">;
  cosmetic: Record<string, any>;
  photos: string[];
  profile: Record<string, any>;
  device: Record<string, any>;
  imei_info: Record<string, any>;
  phonecheck: Record<string, any>;
  offer: Record<string, any>;
  verification: Record<string, any>;
  assessments: any[];
  parts: Record<string, any>;
  screen: Record<string, any>;
  camera: Record<string, any>;
  ocr: Record<string, any>;
  capture: Record<string, any>;
  store_info: Record<string, any>;
  sensor_scan: Record<string, any>;
};

export function hydrate(row: SessionRow): Session {
  return {
    ...row,
    phone: row.phone ?? "",
    recorded_at: row.recorded_at || row.created_at || "",
    timezone: row.timezone || "UTC",
    store_id: row.store_id ?? "",
    store_name: row.store_name ?? "",
    functional: safeJson(row.functional, {}),
    cosmetic: safeJson(row.cosmetic, {}),
    photos: safeJson(row.photos, []),
    profile: safeJson(row.profile ?? "{}", {}),
    device: safeJson(row.device ?? "{}", {}),
    imei_info: safeJson(row.imei_info ?? "{}", {}),
    phonecheck: safeJson(row.phonecheck ?? "{}", {}),
    offer: safeJson(row.offer ?? "{}", {}),
    verification: safeJson(row.verification ?? "{}", {}),
    assessments: safeJson(row.assessments ?? "[]", []),
    parts: safeJson(row.parts ?? "{}", {}),
    screen: safeJson(row.screen ?? "{}", {}),
    camera: safeJson(row.camera ?? "{}", {}),
    ocr: safeJson(row.ocr ?? "{}", {}),
    capture: safeJson(row.capture ?? "{}", {}),
    store_info: safeJson(row.store_info ?? "{}", {}),
    sensor_scan: safeJson(row.sensor_scan ?? "{}", {}),
  };
}

function safeJson<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export function getSession(id: string): Session | null {
  const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as
    | SessionRow
    | undefined;
  return row ? hydrate(row) : null;
}

/**
 * The session columns `updateScreen` may write next to `screen`. Code passes
 * the names, never a request, but a typo must fail loudly rather than become
 * SQL — so anything not listed here throws.
 */
const SCREEN_WRITE_COLUMNS = new Set([
  "cosmetic",
  "cosmetic_grade",
  "photos",
  "assessments",
  "model",
  "capture",
]);

/**
 * Read-modify-write of the `screen` blob with nothing able to land in between
 * (SUP-263; the helper SUP-149 asks for).
 *
 * `screen` is shared: the camera writes `handoffDone` and `pattern`, the phone
 * writes its `shown`/`shownAt` echoes, /cosmetic writes `capture`,
 * `cosmeticDone` and `angleLabels`, /display writes `displayCheck`. A route that
 * read the session, awaited something slow (a body upload, the capture gate, an
 * 8-30 s vision call) and then wrote back a spread of THAT copy erased whatever
 * the others wrote in the meantime — which is how every SwapUp session with a
 * sweep lost `handoffDone` to the background grade.
 *
 * Here the read and the write happen in one synchronous better-sqlite3
 * transaction (BEGIN IMMEDIATE, so another process cannot write between them
 * either). `change` gets the screen as it is NOW and returns the next one; it
 * must be synchronous — there is no `await` anywhere inside. `columns` are set
 * in the same UPDATE (cosmetic, cosmetic_grade, photos, assessments, model,
 * capture), already serialised as they are stored.
 *
 * `columns` may also be a function of the row as it is NOW — `{ model }` —
 * for a column that must not be written back from a stale copy: /cosmetic
 * fills the model from the vision pass only when it is still empty or
 * unknown, and /ocr may have named the phone during the grade.
 *
 * Returns the screen written, or null when the session does not exist.
 */
export type ScreenWriteColumns = Record<string, string | number | null>;

function checkScreenColumns(names: string[]): void {
  for (const c of names) {
    if (!SCREEN_WRITE_COLUMNS.has(c)) throw new Error(`updateScreen: column "${c}" is not writable here`);
  }
}

export function updateScreen(
  id: string,
  change: (current: Record<string, any>) => Record<string, any>,
  columns: ScreenWriteColumns | ((row: { model: string | null }) => ScreenWriteColumns) = {}
): Record<string, any> | null {
  // A fixed set is checked before anything is read; one worked out from the
  // row is checked inside, where a throw rolls the transaction back.
  if (typeof columns !== "function") checkScreenColumns(Object.keys(columns));
  const write = db.transaction((): Record<string, any> | null => {
    const row = db.prepare("SELECT screen, model FROM sessions WHERE id = ?").get(id) as
      | { screen: string | null; model: string | null }
      | undefined;
    if (!row) return null;
    const cols = typeof columns === "function" ? columns({ model: row.model ?? null }) : columns;
    const names = Object.keys(cols);
    checkScreenColumns(names);
    const current = safeJson<Record<string, any> | null>(row.screen ?? "{}", {}) || {};
    const next = change({ ...current });
    if (!next || typeof next !== "object" || typeof (next as any).then === "function") {
      throw new Error("updateScreen: change() must synchronously return the next screen object");
    }
    const sets = [...names.map((c) => `${c} = ?`), "screen = ?", "updated_at = datetime('now')"].join(", ");
    db.prepare(`UPDATE sessions SET ${sets} WHERE id = ?`).run(
      ...names.map((c) => cols[c]),
      JSON.stringify(next),
      id
    );
    return next;
  });
  return write.immediate();
}

// Most-recent sessions for the enterprise desk-tester dashboard.
export function recentSessions(limit = 25): Session[] {
  const rows = db
    .prepare("SELECT * FROM sessions ORDER BY created_at DESC LIMIT ?")
    .all(limit) as SessionRow[];
  return rows.map(hydrate);
}

// Collision-resistant enough for a short token; avoids ambiguous chars. Still
// used for retail purchase ids (p_<token>) and other short codes.
export function newToken(): string {
  const alphabet = "23456789abcdefghjkmnpqrstuvwxyz";
  let s = "";
  for (let i = 0; i < 6; i++)
    s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

// Session ids are standard UUIDs (a stable, collision-free identifier that
// integrating clients — e.g. the CounterIQ retail portal — can store and echo
// back). Used in the QR handoff + report URLs; the short newToken() is kept for
// purchase ids and other human-facing codes.
export function newSessionId(): string {
  return randomUUID();
}
