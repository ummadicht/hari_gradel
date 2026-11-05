-- =============================================================================
-- GradeIQ — PostgreSQL Schema (Migrated from SQLite `data/gradeiq.db`)
-- Total Tables: 15
-- =============================================================================
-- Notes on SQLite -> PostgreSQL compatibility:
-- 1. `INTEGER PRIMARY KEY AUTOINCREMENT` -> `BIGSERIAL PRIMARY KEY`
-- 2. `datetime('now')` (UTC "YYYY-MM-DD HH:MM:SS" text in SQLite) ->
--    `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')` so existing
--    string comparisons and `.slice(0, 16)` date formatting work identically.
-- 3. JSON columns are kept as `TEXT` (with valid JSON defaults `'{}'` / `'[]'`)
--    so `hydrate()` (`JSON.parse`) and `JSON.stringify` writes work without
--    double-encoding issues, while still supporting `(col::jsonb)` in queries.
-- =============================================================================

BEGIN;

-- 1. sessions (lib/db.ts)
CREATE TABLE IF NOT EXISTS sessions (
  id               TEXT PRIMARY KEY,
  imei             TEXT NOT NULL DEFAULT '',
  model            TEXT NOT NULL DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'open',
  functional       TEXT NOT NULL DEFAULT '{}',
  cosmetic         TEXT NOT NULL DEFAULT '{}',
  photos           TEXT NOT NULL DEFAULT '[]',
  functional_grade TEXT NOT NULL DEFAULT '',
  cosmetic_grade   TEXT NOT NULL DEFAULT '',
  overall_grade    TEXT NOT NULL DEFAULT '',
  profile          TEXT NOT NULL DEFAULT '{}',
  device           TEXT NOT NULL DEFAULT '{}',
  imei_info        TEXT NOT NULL DEFAULT '{}',
  phonecheck       TEXT NOT NULL DEFAULT '{}',
  offer            TEXT NOT NULL DEFAULT '{}',
  accepted         INTEGER NOT NULL DEFAULT 0,
  verification     TEXT NOT NULL DEFAULT '{}',
  assessments      TEXT NOT NULL DEFAULT '[]',
  parts            TEXT NOT NULL DEFAULT '{}',
  screen           TEXT NOT NULL DEFAULT '{}',
  camera           TEXT NOT NULL DEFAULT '{}',
  ocr              TEXT NOT NULL DEFAULT '{}',
  client_id        TEXT NOT NULL DEFAULT 'default',
  video            TEXT NOT NULL DEFAULT '',
  capture          TEXT NOT NULL DEFAULT '{}',
  staged           TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  updated_at       TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE INDEX IF NOT EXISTS idx_sessions_client_created ON sessions(client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_created ON sessions(created_at DESC);

-- 2. settings (lib/db.ts)
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 3. session_events (lib/db.ts)
CREATE TABLE IF NOT EXISTS session_events (
  id         BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  step       TEXT NOT NULL,
  event      TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '{}',
  at         TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE INDEX IF NOT EXISTS idx_events_session ON session_events(session_id, id);
CREATE INDEX IF NOT EXISTS idx_events_at ON session_events(at);

-- 4. grading_runs (lib/db.ts)
CREATE TABLE IF NOT EXISTS grading_runs (
  id         BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  grade      TEXT NOT NULL DEFAULT '',
  tier       TEXT NOT NULL DEFAULT '',
  model      TEXT NOT NULL DEFAULT '',
  escalated  INTEGER NOT NULL DEFAULT 0,
  score      DOUBLE PRECISION,
  findings   INTEGER NOT NULL DEFAULT 0,
  coverage   DOUBLE PRECISION,
  review     INTEGER NOT NULL DEFAULT 0,
  trigger    TEXT NOT NULL DEFAULT 'capture',
  actor      TEXT NOT NULL DEFAULT '',
  photos     INTEGER NOT NULL DEFAULT 0,
  snapshot   TEXT NOT NULL DEFAULT '{}',
  at         TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE INDEX IF NOT EXISTS idx_runs_session ON grading_runs(session_id, id);

-- 5. api_keys (lib/db.ts)
CREATE TABLE IF NOT EXISTS api_keys (
  id           BIGSERIAL PRIMARY KEY,
  client_id    TEXT NOT NULL,
  label        TEXT NOT NULL DEFAULT '',
  prefix       TEXT NOT NULL,
  hash         TEXT NOT NULL,
  scopes       TEXT NOT NULL DEFAULT 'read',
  created_by   TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  last_used_at TEXT,
  revoked_at   TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_apikeys_hash ON api_keys(hash);
CREATE INDEX IF NOT EXISTS idx_apikeys_client ON api_keys(client_id);

-- 6. imei_lookups (lib/db.ts & lib/imeiCache.ts)
CREATE TABLE IF NOT EXISTS imei_lookups (
  imei       TEXT PRIMARY KEY,
  info       TEXT NOT NULL,
  phonecheck TEXT NOT NULL DEFAULT '{}',
  at         TEXT NOT NULL
);

-- 7. paid_lookups (lib/db.ts & lib/lookupBudget.ts)
CREATE TABLE IF NOT EXISTS paid_lookups (
  day     TEXT NOT NULL,
  ip      TEXT NOT NULL,
  caller  TEXT NOT NULL,
  outcome TEXT NOT NULL,
  n       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, ip, caller, outcome)
);

-- 8. call_budget (lib/db.ts & lib/lookupBudget.ts)
CREATE TABLE IF NOT EXISTS call_budget (
  budget  TEXT NOT NULL,
  win     TEXT NOT NULL,
  scope   TEXT NOT NULL,
  k       TEXT NOT NULL,
  outcome TEXT NOT NULL,
  n       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (budget, win, scope, k, outcome)
);

-- 9. portal_users (lib/portalAuth.ts)
CREATE TABLE IF NOT EXISTS portal_users (
  username   TEXT PRIMARY KEY,
  role       TEXT NOT NULL DEFAULT 'client',
  client_id  TEXT,
  pw_sha256  TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

-- 10. oidc_sessions (lib/oidc-session.ts)
CREATE TABLE IF NOT EXISTS oidc_sessions (
  sid        TEXT PRIMARY KEY,
  sub        TEXT,
  email      TEXT,
  name       TEXT,
  role       TEXT,
  client_id  TEXT,
  id_token   TEXT,
  created_at BIGINT
);

-- 11. auth_state (lib/oidc-session.ts)
CREATE TABLE IF NOT EXISTS auth_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  at    BIGINT NOT NULL
);

-- 12. compliance_events (lib/compliance.ts)
CREATE TABLE IF NOT EXISTS compliance_events (
  id         BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  client_id  TEXT NOT NULL DEFAULT '',
  kind       TEXT NOT NULL,
  severity   TEXT NOT NULL DEFAULT 'record',
  expected   TEXT NOT NULL DEFAULT '',
  observed   TEXT NOT NULL DEFAULT '',
  source     TEXT NOT NULL DEFAULT '',
  detail     TEXT NOT NULL DEFAULT '{}',
  actor      TEXT NOT NULL DEFAULT '',
  at         TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE INDEX IF NOT EXISTS idx_comp_session ON compliance_events(session_id, id);
CREATE INDEX IF NOT EXISTS idx_comp_kind    ON compliance_events(kind, at);
CREATE INDEX IF NOT EXISTS idx_comp_client  ON compliance_events(client_id, at);

-- 13. capture_telemetry (lib/captureTelemetry.ts)
CREATE TABLE IF NOT EXISTS capture_telemetry (
  id                       BIGSERIAL PRIMARY KEY,
  event_id                 TEXT NOT NULL UNIQUE,
  session_id               TEXT NOT NULL,
  client_id                TEXT NOT NULL DEFAULT '',
  surface                  TEXT NOT NULL DEFAULT '',
  step_id                  TEXT NOT NULL DEFAULT '',
  step_label               TEXT NOT NULL DEFAULT '',
  photo_index              INTEGER NOT NULL DEFAULT -1,
  attempt                  INTEGER NOT NULL DEFAULT 1,
  outcome                  TEXT NOT NULL DEFAULT 'captured',
  measurements             TEXT NOT NULL DEFAULT '{}',
  actual_verdict           TEXT NOT NULL DEFAULT '{}',
  experimental_instruction TEXT NOT NULL DEFAULT '',
  guidance                 TEXT NOT NULL DEFAULT '{}',
  measurement_profile      TEXT NOT NULL DEFAULT '',
  acceptance_profile       TEXT NOT NULL DEFAULT '',
  at                       TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE INDEX IF NOT EXISTS idx_captel_session ON capture_telemetry(session_id, id);
CREATE INDEX IF NOT EXISTS idx_captel_client  ON capture_telemetry(client_id, at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_captel_eventid ON capture_telemetry(event_id);
CREATE INDEX IF NOT EXISTS idx_captel_step    ON capture_telemetry(session_id, step_id);

-- 14. purchases (lib/purchase.ts)
CREATE TABLE IF NOT EXISTS purchases (
  id         TEXT PRIMARY KEY,
  client_id  TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'intake',
  customer   TEXT NOT NULL DEFAULT '{}',
  kyc        TEXT NOT NULL DEFAULT '{}',
  session_id TEXT NOT NULL DEFAULT '',
  offer      TEXT NOT NULL DEFAULT '{}',
  clearance  TEXT NOT NULL DEFAULT '{}',
  payout     TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  updated_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE INDEX IF NOT EXISTS idx_purchases_client  ON purchases(client_id, created_at);
CREATE INDEX IF NOT EXISTS idx_purchases_session ON purchases(session_id);

-- 15. credit_ledger (lib/purchase.ts)
CREATE TABLE IF NOT EXISTS credit_ledger (
  id            BIGSERIAL PRIMARY KEY,
  client_id     TEXT NOT NULL,
  delta         INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  ref           TEXT NOT NULL DEFAULT '',
  note          TEXT NOT NULL DEFAULT '',
  at            TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE INDEX IF NOT EXISTS idx_ledger_client ON credit_ledger(client_id, id);

COMMIT;
