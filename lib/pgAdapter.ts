import { Worker, MessageChannel, receiveMessageOnPort } from "node:worker_threads";

/**
 * Resolve the configured PostgreSQL connection string, if any.
 * Checks DATABASE_URL, POSTGRES_URL, and PG_CONNECTION_STRING.
 */
export function getPostgresUrl(): string {
  return (
    process.env.DATABASE_URL?.trim() ||
    process.env.POSTGRES_URL?.trim() ||
    process.env.PG_CONNECTION_STRING?.trim() ||
    ""
  );
}

/**
 * Translate SQLite SQL dialect constructs used in GradeIQ to PostgreSQL SQL:
 *  - `PRAGMA table_info(tbl)` -> `information_schema.columns` query returning `{ name }`
 *  - `INTEGER PRIMARY KEY AUTOINCREMENT` -> `BIGSERIAL PRIMARY KEY`
 *  - `DEFAULT (datetime('now'))` / `datetime('now')` -> UTC `YYYY-MM-DD HH24:MI:SS` string
 *  - `INSERT OR IGNORE INTO tbl ...` -> `INSERT INTO tbl ... ON CONFLICT DO NOTHING`
 *  - `MAX(0, ...)` scalar 2-arg call in ON CONFLICT -> `GREATEST(0, ...)`
 *  - `json_extract(col, '$.field')` -> `(col::jsonb)->>'field'`
 *  - `json_array_length(col)` -> `CASE WHEN jsonb_typeof(col::jsonb) = 'array' THEN jsonb_array_length(col::jsonb) ELSE NULL END`
 *  - `?` positional placeholders (outside quotes/comments) -> `$1, $2, ...`
 */
export function translateSqlToPostgres(rawSql: string): string {
  const trimmed = rawSql.trim();

  // 1. PRAGMA table_info(tableName)
  const pragmaTableInfo = /^PRAGMA\s+table_info\(\s*([a-zA-Z0-9_]+)\s*\)\s*;?$/i.exec(trimmed);
  if (pragmaTableInfo) {
    const table = pragmaTableInfo[1].toLowerCase();
    return `SELECT column_name AS name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${table}'`;
  }

  // 2. Other PRAGMA statements (e.g. PRAGMA journal_mode = WAL)
  if (/^PRAGMA\b/i.test(trimmed)) {
    return "SELECT 1";
  }

  let sql = rawSql;

  // 3. DDL conversions
  sql = sql.replace(/\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/gi, "BIGSERIAL PRIMARY KEY");
  sql = sql.replace(
    /\bDEFAULT\s*\(\s*datetime\(\s*'now'\s*\)\s*\)/gi,
    "DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')",
  );

  // 4. datetime('now') in queries
  sql = sql.replace(
    /\bdatetime\(\s*'now'\s*\)/gi,
    "to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')",
  );

  // 5. INSERT OR IGNORE INTO ... -> INSERT INTO ... ON CONFLICT DO NOTHING
  if (/\bINSERT\s+OR\s+IGNORE\s+INTO\b/i.test(sql)) {
    sql = sql.replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi, "INSERT INTO");
    sql = sql.replace(/;?\s*$/, " ON CONFLICT DO NOTHING");
  }

  // 6. Scalar MAX(0, expr) in DO UPDATE SET
  sql = sql.replace(/\bMAX\(\s*0\s*,/gi, "GREATEST(0,");

  // 7. json_array_length(json_extract(col, '$.field')) & json_array_length(col) & json_extract(col, '$.field')
  sql = sql.replace(
    /\bjson_array_length\(\s*json_extract\(\s*([a-zA-Z0-9_]+)\s*,\s*'\$\.([a-zA-Z0-9_]+)'\s*\)\s*\)/gi,
    "CASE WHEN jsonb_typeof(($1::jsonb)->'$2') = 'array' THEN jsonb_array_length(($1::jsonb)->'$2') ELSE NULL END",
  );
  sql = sql.replace(
    /\bjson_array_length\(\s*([a-zA-Z0-9_]+)\s*\)/gi,
    "CASE WHEN jsonb_typeof($1::jsonb) = 'array' THEN jsonb_array_length($1::jsonb) ELSE NULL END",
  );
  sql = sql.replace(
    /\bjson_extract\(\s*([a-zA-Z0-9_]+)\s*,\s*'\$\.([a-zA-Z0-9_]+)'\s*\)/gi,
    "(($1::jsonb)->>'$2')",
  );

  // 8. Replace `?` placeholders with `$1, $2, ...` while ignoring string literals, identifiers, and comments.
  let out = "";
  let paramIndex = 0;
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i];

    // Single-line comment `-- ...`
    if (ch === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i + 2);
      if (end === -1) {
        out += sql.slice(i);
        break;
      }
      out += sql.slice(i, end + 1);
      i = end + 1;
      continue;
    }

    // Block comment `/* ... */`
    if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) {
        out += sql.slice(i);
        break;
      }
      out += sql.slice(i, end + 2);
      i = end + 2;
      continue;
    }

    // Single-quoted string `'...'` (with `''` escape)
    if (ch === "'") {
      out += ch;
      i++;
      while (i < n) {
        out += sql[i];
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            out += sql[i + 1];
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // Double-quoted identifier `"..."`
    if (ch === '"') {
      out += ch;
      i++;
      while (i < n) {
        out += sql[i];
        if (sql[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (ch === "?") {
      paramIndex++;
      out += `$${paramIndex}`;
      i++;
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

const WORKER_SCRIPT = `
const { parentPort } = require("node:worker_threads");
const { Pool, types } = require("pg");

// Parse BIGINT (OID 20) and NUMERIC (OID 1700) as JS numbers so COUNT(*), SUM(),
// and BIGSERIAL ids match better-sqlite3's number return types.
types.setTypeParser(20, (val) => (val === null ? null : Number(val)));
types.setTypeParser(1700, (val) => (val === null ? null : Number(val)));

const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.PG_CONNECTION_STRING;
const sslEnv = (process.env.POSTGRES_SSL || "").toLowerCase();
const useSsl =
  sslEnv === "true" ||
  sslEnv === "1" ||
  sslEnv === "require" ||
  (!sslEnv && /sslmode=(require|verify-full|verify-ca)/i.test(connectionString || ""));

const pool = new Pool({
  connectionString,
  ...(useSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  max: 10,
  idleTimeoutMillis: 30000,
});

let txClient = null;
let txDepth = 0;

parentPort.on("message", async (msg) => {
  const { kind, sql, params, lockBuf, port } = msg;
  const lock = new Int32Array(lockBuf);
  try {
    if (kind === "begin") {
      if (txDepth === 0) {
        txClient = await pool.connect();
        await txClient.query("BEGIN");
      } else {
        await txClient.query(\`SAVEPOINT sp_\${txDepth}\`);
      }
      txDepth++;
      port.postMessage({ ok: true });
    } else if (kind === "commit") {
      if (txDepth > 0) {
        txDepth--;
        if (txDepth === 0 && txClient) {
          try {
            await txClient.query("COMMIT");
          } finally {
            txClient.release();
            txClient = null;
          }
        } else if (txClient) {
          await txClient.query(\`RELEASE SAVEPOINT sp_\${txDepth}\`);
        }
      }
      port.postMessage({ ok: true });
    } else if (kind === "rollback") {
      if (txDepth > 0) {
        txDepth--;
        if (txDepth === 0 && txClient) {
          try {
            await txClient.query("ROLLBACK");
          } finally {
            txClient.release();
            txClient = null;
          }
        } else if (txClient) {
          await txClient.query(\`ROLLBACK TO SAVEPOINT sp_\${txDepth}\`);
        }
      }
      port.postMessage({ ok: true });
    } else if (kind === "exec") {
      const runner = txClient || pool;
      await runner.query(sql);
      port.postMessage({ ok: true });
    } else {
      const runner = txClient || pool;
      const res = await runner.query(sql, params);
      port.postMessage({
        ok: true,
        rows: res.rows || [],
        rowCount: typeof res.rowCount === "number" ? res.rowCount : 0,
      });
    }
  } catch (err) {
    port.postMessage({
      ok: false,
      error: err && err.message ? err.message : String(err),
      code: err && err.code ? err.code : undefined,
    });
  } finally {
    Atomics.store(lock, 0, 1);
    Atomics.notify(lock, 0, 1);
    port.close();
  }
});
`;

type WorkerResponse = {
  ok: boolean;
  rows?: any[];
  rowCount?: number;
  error?: string;
  code?: string;
};

function flattenParams(args: any[]): any[] {
  if (args.length === 1 && Array.isArray(args[0])) {
    return args[0];
  }
  return args;
}

export function createPostgresDb(connectionString: string): any {
  const worker = new Worker(WORKER_SCRIPT, {
    eval: true,
    execArgv: [],
    env: {
      ...process.env,
      DATABASE_URL: connectionString,
    },
  });
  worker.unref();

  function callWorker(payload: { kind: string; sql?: string; params?: any[] }): WorkerResponse {
    const lockBuf = new SharedArrayBuffer(4);
    const lock = new Int32Array(lockBuf);
    const { port1, port2 } = new MessageChannel();

    worker.postMessage({ ...payload, lockBuf, port: port2 }, [port2]);
    Atomics.wait(lock, 0, 0);

    const msg = receiveMessageOnPort(port1)?.message as WorkerResponse | undefined;
    port1.close();

    if (!msg) {
      throw new Error("PostgreSQL worker did not return a response");
    }
    if (!msg.ok) {
      const err = new Error(msg.error || "PostgreSQL query failed") as Error & { code?: string };
      if (msg.code) err.code = msg.code;
      throw err;
    }
    return msg;
  }

  const adapter = {
    pragma(sql: string) {
      const pgSql = translateSqlToPostgres(`PRAGMA ${sql}`);
      if (pgSql === "SELECT 1") return [];
      return callWorker({ kind: "query", sql: pgSql, params: [] }).rows ?? [];
    },

    exec(sql: string) {
      const pgSql = translateSqlToPostgres(sql);
      callWorker({ kind: "exec", sql: pgSql });
      return adapter;
    },

    prepare(sql: string) {
      const pgSql = translateSqlToPostgres(sql);
      return {
        get(...args: any[]) {
          const params = flattenParams(args);
          const res = callWorker({ kind: "query", sql: pgSql, params });
          return res.rows && res.rows.length > 0 ? res.rows[0] : undefined;
        },
        all(...args: any[]) {
          const params = flattenParams(args);
          const res = callWorker({ kind: "query", sql: pgSql, params });
          return res.rows ?? [];
        },
        run(...args: any[]) {
          const params = flattenParams(args);
          const res = callWorker({ kind: "query", sql: pgSql, params });
          return {
            changes: res.rowCount ?? 0,
            lastInsertRowid: 0,
          };
        },
      };
    },

    transaction<T extends (...args: any[]) => any>(fn: T) {
      const runTx = (...args: Parameters<T>): ReturnType<T> => {
        callWorker({ kind: "begin" });
        try {
          const result = fn(...args);
          callWorker({ kind: "commit" });
          return result;
        } catch (err) {
          try {
            callWorker({ kind: "rollback" });
          } catch {
            /* ignore rollback error so original error surfaces */
          }
          throw err;
        }
      };
      runTx.default = runTx;
      runTx.deferred = runTx;
      runTx.immediate = runTx;
      runTx.exclusive = runTx;
      return runTx;
    },
  };

  return adapter;
}
