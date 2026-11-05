#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import pg from "pg";

const { Pool } = pg;

const connectionString =
  process.env.DATABASE_URL?.trim() ||
  process.env.POSTGRES_URL?.trim() ||
  process.env.PG_CONNECTION_STRING?.trim();

if (!connectionString) {
  console.error(
    "Error: Set DATABASE_URL (or POSTGRES_URL / PG_CONNECTION_STRING) before running migration.",
  );
  process.exit(1);
}

const sslEnv = (process.env.POSTGRES_SSL || "").toLowerCase();
const useSsl =
  sslEnv === "true" ||
  sslEnv === "1" ||
  sslEnv === "require" ||
  (!sslEnv && /sslmode=(require|verify-full|verify-ca)/i.test(connectionString));

const pool = new Pool({
  connectionString,
  ...(useSsl ? { ssl: { rejectUnauthorized: false } } : {}),
});

const TABLES = [
  "sessions",
  "settings",
  "session_events",
  "grading_runs",
  "api_keys",
  "imei_lookups",
  "paid_lookups",
  "call_budget",
  "portal_users",
  "oidc_sessions",
  "auth_state",
  "compliance_events",
  "capture_telemetry",
  "purchases",
  "credit_ledger",
];

const SERIAL_TABLES = [
  "session_events",
  "grading_runs",
  "api_keys",
  "compliance_events",
  "capture_telemetry",
  "credit_ledger",
];

async function main() {
  const schemaPath = path.join(process.cwd(), "schema.postgres.sql");
  const schemaSql = fs.readFileSync(schemaPath, "utf8");

  console.log("1. Applying schema.postgres.sql to remote PostgreSQL...");
  await pool.query(schemaSql);
  console.log("   Schema applied.");

  const sqlitePath = path.join(process.cwd(), "data", "gradeiq.db");
  if (!fs.existsSync(sqlitePath)) {
    console.log("2. No local data/gradeiq.db found — remote schema is ready.");
    await pool.end();
    return;
  }

  console.log(`2. Migrating rows from ${sqlitePath}...`);
  const sqlite = new Database(sqlitePath, { readonly: true });
  const existingTables = new Set(
    sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name),
  );

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const table of TABLES) {
      if (!existingTables.has(table)) continue;
      const rows = sqlite.prepare(`SELECT * FROM "${table}"`).all();
      if (!rows.length) {
        console.log(`   - ${table}: 0 rows`);
        continue;
      }

      const cols = Object.keys(rows[0]);
      const colList = cols.map((c) => `"${c}"`).join(", ");
      const placeholders = cols.map((_, idx) => `$${idx + 1}`).join(", ");
      const insertSql = `INSERT INTO "${table}" (${colList}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;

      let inserted = 0;
      for (const row of rows) {
        const vals = cols.map((c) => row[c]);
        const res = await client.query(insertSql, vals);
        inserted += res.rowCount ?? 0;
      }
      console.log(`   - ${table}: migrated ${inserted}/${rows.length} rows`);
    }

    for (const table of SERIAL_TABLES) {
      await client.query(
        `SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM "${table}"), 1), (SELECT COUNT(*) > 0 FROM "${table}"))`,
      );
    }

    await client.query("COMMIT");
    console.log("3. Migration completed successfully.");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    sqlite.close();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
