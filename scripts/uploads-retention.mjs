#!/usr/bin/env node
// Uploads retention (SUP-80) — DRY RUN unless --apply. NOT scheduled anywhere.
//
// data/uploads holds every photo, screen capture, Settings screenshot, camera
// still, lens shot and rotation video any session ever sent, and nothing ever
// removed them (only the console's "start fresh" wipe). This script says what a
// retention rule would remove, and removes it only when asked.
//
// A file is removed only when ALL of these hold:
//   1. it was last written more than --days ago (default 180,
//      GRADEIQ_UPLOAD_RETENTION_DAYS);
//   2. no FINAL session owns it — accepted (`accepted = 1`), payout passed
//      (`verification.payout.passed`), or a retail purchase on it accepted,
//      cleared, paying or paid (the same rule as lib/sessionWriteRules.ts
//      lockReason);
//   3. no session that owns it was updated after the cutoff (a session someone
//      is still working on keeps its evidence, however old the file);
//   4. no session in a kept tenant owns it (--keep-client, comma list, or
//      GRADEIQ_UPLOAD_RETENTION_KEEP_CLIENTS);
//   5. no purchase record mentions it.
// A session OWNS a file when any of its columns mentions /api/uploads/<file>,
// or the file name starts with the session id (cosmetic, display, Settings and
// rotation-video files are named that way). A file no session owns (a session
// since deleted, an upload whose session never saved it) goes by age alone.
//
// READ BEFORE RUNNING --apply. GradeIQ only knows the outcomes it records.
// SwapUp never calls /accept and CounterIQ keeps its purchases in its own
// database, so their sessions never read as final here — a trade they paid out
// would lose its photos at 180 days. Until they report back, protect them:
// --keep-client swapmore-in (SwapUp) and the CounterIQ tenants. Removing a file
// leaves the session's reference in place: the report shows a missing picture.
//
// Usage (from the app directory — on the VM, ~/gradeiq):
//   node scripts/uploads-retention.mjs                       dry run, totals only
//   node scripts/uploads-retention.mjs --list                dry run, every file it would remove
//   node scripts/uploads-retention.mjs --days 365 --keep-client swapmore-in,inzman
//   node scripts/uploads-retention.mjs --apply               remove them
//   --data <dir>   the data directory (default ./data: gradeiq.db + uploads/)
//
// The database is opened READ-ONLY: the script never writes to it, and a dry
// run writes nothing anywhere. It refuses to run without the database, because
// with no sessions to read every file would look unowned.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_RETENTION_DAYS = 180;
const DAY_MS = 86_400_000;
/** The purchase states that make a session final (lib/sessionWriteRules.ts COMMITTED_PURCHASE). */
const COMMITTED_PURCHASE = ["accepted", "cleared", "paying", "paid"];
const UPLOAD_REF = /\/api\/uploads\/([A-Za-z0-9._-]+)/g;
const SESSION_PREFIX = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-/i;

/** Every uploads file name mentioned in a piece of text. */
export function uploadRefs(text) {
  const out = new Set();
  for (const m of String(text ?? "").matchAll(UPLOAD_REF)) out.add(m[1]);
  return out;
}

/** SQLite datetime('now') text ("2026-10-22 16:04:32", UTC) → ms, or NaN. */
export function sqliteTime(v) {
  const s = String(v ?? "").trim();
  if (!s) return NaN;
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s.replace(" ", "T") : `${s.replace(" ", "T")}Z`);
}

/** Why a session is final, or null — mirrors lib/sessionWriteRules.ts lockReason. */
export function finalReason(s) {
  if (Number(s.accepted) === 1 || s.accepted === true) return "accepted";
  let v = s.verification;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v || "{}");
    } catch {
      v = {};
    }
  }
  if (v?.payout?.passed === true) return "payout";
  for (const st of s.purchaseStatuses ?? []) if (COMMITTED_PURCHASE.includes(st)) return `purchase-${st}`;
  return null;
}

/**
 * Decide, file by file. Pure — no disk, no database.
 *
 * files:     [{ name, size, mtimeMs }]
 * sessions:  [{ id, client_id, accepted, verification, updated_at, purchaseStatuses: [], refs: Set<name> }]
 * purchaseRefs: Set<name> mentioned by any purchase row
 * → { cutoff, remove: [file], keep: [{ ...file, reason }] }
 */
export function planRetention({ files, sessions, purchaseRefs = new Set(), now = Date.now(), days = DEFAULT_RETENTION_DAYS, keepClients = [] }) {
  if (!Number.isFinite(days) || days < 1) throw new Error(`retention age must be at least 1 day (got ${days})`);
  const cutoff = now - days * DAY_MS;
  const keep = new Set(keepClients.map((c) => String(c).toLowerCase().trim()).filter(Boolean));
  const byId = new Map(sessions.map((s) => [String(s.id).toLowerCase(), s]));
  const ownersOf = new Map();
  for (const s of sessions) {
    for (const name of s.refs ?? []) {
      if (!ownersOf.has(name)) ownersOf.set(name, []);
      ownersOf.get(name).push(s);
    }
  }

  const remove = [];
  const kept = [];
  for (const f of files) {
    const owners = [...(ownersOf.get(f.name) ?? [])];
    // Named for a session: a UUID id, or an early short one ("k3f9q2-…").
    const prefix = (SESSION_PREFIX.exec(f.name)?.[1] ?? f.name.split("-")[0]).toLowerCase();
    const named = prefix ? byId.get(prefix) : undefined;
    if (named && !owners.includes(named)) owners.push(named);

    let reason = null;
    if (!(f.mtimeMs < cutoff)) reason = "newer than the cutoff";
    else if (purchaseRefs.has(f.name)) reason = "mentioned by a purchase";
    else if (owners.some((s) => finalReason(s))) reason = "accepted or paid session";
    else if (owners.some((s) => keep.has(String(s.client_id ?? "").toLowerCase()))) reason = "kept tenant";
    else if (owners.some((s) => !(sqliteTime(s.updated_at) < cutoff))) reason = "session updated since the cutoff";

    if (reason) kept.push({ ...f, reason });
    else remove.push({ ...f, owned: owners.length > 0 });
  }
  return { cutoff, remove, keep: kept };
}

/** Read the uploads directory and the database (read-only). */
export async function loadState(dataDir) {
  const dbFile = path.join(dataDir, "gradeiq.db");
  const uploadsDir = path.join(dataDir, "uploads");
  if (!fs.existsSync(dbFile)) throw new Error(`no database at ${dbFile} — refusing to run (every file would look unowned)`);
  if (!fs.existsSync(uploadsDir)) throw new Error(`no uploads directory at ${uploadsDir}`);

  const files = [];
  for (const e of fs.readdirSync(uploadsDir, { withFileTypes: true })) {
    if (!e.isFile()) continue; // never follow links or descend into directories
    const st = fs.statSync(path.join(uploadsDir, e.name));
    files.push({ name: e.name, size: st.size, mtimeMs: st.mtimeMs });
  }

  const { default: Database } = await import("better-sqlite3");
  const db = new Database(dbFile, { readonly: true, fileMustExist: true });
  try {
    const hasTable = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    if (!hasTable("sessions")) throw new Error(`${dbFile} has no sessions table — refusing to run`);
    const purchaseStatuses = new Map();
    const purchaseRefs = new Set();
    if (hasTable("purchases")) {
      for (const p of db.prepare("SELECT * FROM purchases").iterate()) {
        const sid = String(p.session_id ?? "").toLowerCase();
        if (sid) {
          if (!purchaseStatuses.has(sid)) purchaseStatuses.set(sid, []);
          purchaseStatuses.get(sid).push(String(p.status ?? ""));
        }
        for (const n of uploadRefs(JSON.stringify(p))) purchaseRefs.add(n);
      }
    }
    // Every column but `staged`: it holds the photos themselves as data URLs
    // (megabytes a row) between the capture gate and the grade, never a path.
    const cols = db
      .prepare("PRAGMA table_info(sessions)")
      .all()
      .map((c) => c.name)
      .filter((n) => n !== "staged")
      .map((n) => `"${String(n).replace(/"/g, '""')}"`);
    const sessions = [];
    for (const r of db.prepare(`SELECT ${cols.join(", ")} FROM sessions`).iterate()) {
      const id = String(r.id);
      sessions.push({
        id,
        client_id: r.client_id ?? "default",
        accepted: r.accepted ?? 0,
        verification: r.verification ?? "{}",
        updated_at: r.updated_at ?? r.created_at ?? "",
        purchaseStatuses: purchaseStatuses.get(id.toLowerCase()) ?? [],
        refs: uploadRefs(JSON.stringify(r)),
      });
    }
    return { uploadsDir, files, sessions, purchaseRefs };
  } finally {
    db.close();
  }
}

function parseArgs(argv, env) {
  const o = {
    apply: false,
    list: false,
    days: Number(env.GRADEIQ_UPLOAD_RETENTION_DAYS || DEFAULT_RETENTION_DAYS),
    keepClients: String(env.GRADEIQ_UPLOAD_RETENTION_KEEP_CLIENTS || "").split(","),
    data: path.join(process.cwd(), "data"),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    const value = () => (inline !== undefined ? inline : argv[++i]);
    if (flag === "--apply") o.apply = true;
    else if (flag === "--list") o.list = true;
    else if (flag === "--days") o.days = Number(value());
    else if (flag === "--keep-client") o.keepClients.push(...String(value() ?? "").split(","));
    else if (flag === "--data") o.data = path.resolve(String(value() ?? ""));
    else if (flag === "--help" || flag === "-h") o.help = true;
    else throw new Error(`unknown option ${a} (see the top of scripts/uploads-retention.mjs)`);
  }
  o.keepClients = o.keepClients.map((c) => c.trim()).filter(Boolean);
  return o;
}

const human = (bytes) => {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
};
const total = (xs) => xs.reduce((a, f) => a + (f.size || 0), 0);

export async function main(argv = process.argv.slice(2), env = process.env, log = console.log) {
  const o = parseArgs(argv, env);
  if (o.help) {
    log("node scripts/uploads-retention.mjs [--days N] [--keep-client a,b] [--list] [--data DIR] [--apply]");
    return 0;
  }
  const state = await loadState(o.data);
  const plan = planRetention({ ...state, days: o.days, keepClients: o.keepClients });

  log(`uploads retention — ${o.apply ? "APPLY: files will be deleted" : "DRY RUN: nothing is deleted (pass --apply to delete)"}`);
  log(`  directory:   ${state.uploadsDir}`);
  log(`  older than:  ${o.days} days (last written before ${new Date(plan.cutoff).toISOString()})`);
  log(`  kept tenants: ${o.keepClients.length ? o.keepClients.join(", ") : "none"}`);
  log(`  files:       ${state.files.length} (${human(total(state.files))}) for ${state.sessions.length} sessions`);
  const owned = plan.remove.filter((f) => f.owned);
  log(`  ${o.apply ? "removing" : "would remove"}: ${plan.remove.length} files (${human(total(plan.remove))}) — ${owned.length} of unfinished sessions, ${plan.remove.length - owned.length} no session owns`);
  const reasons = new Map();
  for (const f of plan.keep) {
    if (!reasons.has(f.reason)) reasons.set(f.reason, []);
    reasons.get(f.reason).push(f);
  }
  for (const [reason, group] of reasons) log(`  keeping:     ${group.length} files (${human(total(group))}) — ${reason}`);
  if (o.list) for (const f of plan.remove) log(`    ${f.name}  ${human(f.size)}  ${new Date(f.mtimeMs).toISOString().slice(0, 10)}`);

  if (!o.apply) return 0;
  let removed = 0;
  let failed = 0;
  for (const f of plan.remove) {
    try {
      fs.unlinkSync(path.join(state.uploadsDir, f.name));
      removed++;
    } catch {
      failed++;
    }
  }
  log(`  removed:     ${removed} files${failed ? `, ${failed} could not be removed` : ""}`);
  return failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`uploads-retention: ${e.message}`);
      process.exit(2);
    }
  );
}
