// SUP-80 — the uploads retention job: dry run by default, and it never removes
// what an accepted or paid session (or anything still in use) relies on.
//
// Builds a real GradeIQ database (lib/db.ts) and a real uploads directory in a
// throwaway working directory, then runs the script as the owner would on the
// VM: once as a dry run, once with --apply.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "uploads-retention.mjs");
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "giq-retention-")));

let pass = 0;
const t = async (name, fn) => {
  try {
    await fn();
    console.log("  ok  ", name);
    pass++;
  } catch (e) {
    console.log("  FAIL", name, "\n       ", e.stack || e.message);
    process.exitCode = 1;
  }
};

const { db, newSessionId } = await import("../lib/db.ts");
const { planRetention, finalReason, uploadRefs } = await import("./uploads-retention.mjs");
db.exec(`CREATE TABLE IF NOT EXISTS purchases (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, created_by TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'intake', customer TEXT NOT NULL DEFAULT '{}', kyc TEXT NOT NULL DEFAULT '{}',
  session_id TEXT NOT NULL DEFAULT '', offer TEXT NOT NULL DEFAULT '{}', clearance TEXT NOT NULL DEFAULT '{}',
  payout TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

const DAY = 86_400_000;
const UPLOADS = path.join(process.cwd(), "data", "uploads");

/** A session last updated `updatedDaysAgo` ago. */
function session({ client = "swapmore", accepted = 0, verification = {}, updatedDaysAgo = 300, camera = {} } = {}) {
  const id = newSessionId();
  db.prepare(
    `INSERT INTO sessions (id, client_id, accepted, verification, camera, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now', ?))`
  ).run(id, client, accepted, JSON.stringify(verification), JSON.stringify(camera), `-${updatedDaysAgo} days`);
  return id;
}
/** An uploads file last written `daysAgo` ago. */
function file(name, daysAgo, bytes = 1000) {
  const p = path.join(UPLOADS, name);
  fs.writeFileSync(p, Buffer.alloc(bytes, 1));
  const at = new Date(Date.now() - daysAgo * DAY);
  fs.utimesSync(p, at, at);
  return name;
}
const exists = (name) => fs.existsSync(path.join(UPLOADS, name));
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: process.cwd(), encoding: "utf8" });

// ── the estate ──────────────────────────────────────────────────────────────
const open = session(); // never accepted, untouched for 300 days
const openPhoto = file(`${open}-1700000000000-0.jpg`, 250);
const openVideo = file(`${open}-rotation.webm`, 250, 50_000);
const openFresh = file(`${open}-1790000000000-1.jpg`, 10); // written recently

const camShot = `cam-${newSessionId()}.jpg`;
const accepted = session({ accepted: 1, camera: { frames: [{ url: `/api/uploads/${camShot}` }] } });
file(camShot, 400); // only REFERENCED (camera frames are not named for the session)
const acceptedPhoto = file(`${accepted}-1700000000000-0.jpg`, 400);

const paidOut = session({ verification: { payout: { passed: true } } });
const paidOutPhoto = file(`${paidOut}-disp-1700000000000-0.jpg`, 400);

const purchased = session();
db.prepare("INSERT INTO purchases (id, client_id, status, session_id) VALUES (?, ?, ?, ?)").run("p1", "inzman", "paid", purchased);
const purchasedPhoto = file(`${purchased}-ocr-1700000000000-0.jpg`, 400);

const intake = session();
db.prepare("INSERT INTO purchases (id, client_id, status, session_id) VALUES (?, ?, ?, ?)").run("p2", "inzman", "intake", intake);
const intakePhoto = file(`${intake}-1700000000000-0.jpg`, 400);

const busy = session({ updatedDaysAgo: 3 }); // re-graded last week
const busyPhoto = file(`${busy}-1700000000000-0.jpg`, 400);

const swapup = session({ client: "swapmore-in" });
const swapupPhoto = file(`${swapup}-1700000000000-0.jpg`, 400);

const kycShot = file(`lens-${newSessionId()}.jpg`, 400);
db.prepare("INSERT INTO purchases (id, client_id, status, session_id, kyc) VALUES (?, ?, ?, ?, ?)").run(
  "p3", "inzman", "intake", "", JSON.stringify({ photo: `/api/uploads/${kycShot}` })
);

const orphan = file(`cam-${newSessionId()}.jpg`, 400); // its session is gone
const orphanFresh = file(`lens-${newSessionId()}.jpg`, 5);

const doomed = [openPhoto, openVideo, intakePhoto, swapupPhoto, orphan].sort();
const all = fs.readdirSync(UPLOADS).sort();

console.log("uploads retention (SUP-80)");

await t("finalReason mirrors lockReason (accepted · payout · committed purchase)", () => {
  assert.equal(finalReason({ accepted: 1 }), "accepted");
  assert.equal(finalReason({ verification: '{"payout":{"passed":true}}' }), "payout");
  assert.equal(finalReason({ verification: { payout: { passed: false } } }), null);
  assert.equal(finalReason({ purchaseStatuses: ["intake", "paying"] }), "purchase-paying");
  assert.equal(finalReason({ purchaseStatuses: ["intake", "rejected"] }), null);
  assert.deepEqual([...uploadRefs('{"a":"/api/uploads/x-1.jpg","b":["/api/uploads/cam-2.png"]}')], ["x-1.jpg", "cam-2.png"]);
});

await t("plan: age alone is never enough when a final session owns the file", () => {
  const now = Date.now();
  const uuid = "0f8d2a4e-6b1c-4d3e-9a7b-2c5e8f1a0b3d";
  const files = [
    { name: `${uuid}-1-0.jpg`, size: 1, mtimeMs: now - 999 * DAY }, // named for it
    { name: "cam-a.jpg", size: 1, mtimeMs: now - 999 * DAY }, // referenced by it
    { name: "k3f9q2-rotation.webm", size: 1, mtimeMs: now - 999 * DAY }, // an early short id
    { name: "cam-b.jpg", size: 1, mtimeMs: now - 999 * DAY }, // nobody's
  ];
  const sessions = [
    { id: uuid, accepted: 1, updated_at: "2020-01-01 00:00:00", refs: new Set(["cam-a.jpg"]) },
    { id: "k3f9q2", accepted: 1, updated_at: "2020-01-01 00:00:00", refs: new Set() },
  ];
  const p = planRetention({ files, sessions, now, days: 180 });
  assert.deepEqual(p.remove.map((f) => f.name), ["cam-b.jpg"]);
  assert.deepEqual(p.keep.map((f) => f.reason), Array(3).fill("accepted or paid session"));
  assert.throws(() => planRetention({ files, sessions, now, days: 0 }), /at least 1 day/);
});

await t("dry run (the default): reports, deletes nothing, writes nothing", () => {
  const dbStat = fs.statSync(path.join(process.cwd(), "data", "gradeiq.db"));
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /DRY RUN: nothing is deleted/);
  assert.match(r.stdout, /older than:\s+180 days/);
  assert.match(r.stdout, new RegExp(`would remove: ${doomed.length} files`));
  assert.match(r.stdout, /accepted or paid session/);
  assert.match(r.stdout, /session updated since the cutoff/);
  assert.match(r.stdout, /mentioned by a purchase/);
  assert.match(r.stdout, /newer than the cutoff/);
  assert.deepEqual(fs.readdirSync(UPLOADS).sort(), all, "every file still there");
  assert.equal(fs.statSync(path.join(process.cwd(), "data", "gradeiq.db")).mtimeMs, dbStat.mtimeMs, "database untouched");
});

await t("--list names exactly the files it would remove", () => {
  const r = run("--list");
  assert.equal(r.status, 0, r.stderr);
  const listed = r.stdout
    .split("\n")
    .filter((l) => /^ {4}\S/.test(l))
    .map((l) => l.trim().split(/\s+/)[0])
    .sort();
  assert.deepEqual(listed, doomed);
});

await t("--keep-client protects a tenant whose outcomes GradeIQ never sees (SwapUp)", () => {
  const r = run("--list", "--keep-client", "swapmore-in");
  assert.match(r.stdout, /kept tenant/);
  assert.ok(!r.stdout.includes(swapupPhoto));
  const env = spawnSync(process.execPath, [SCRIPT, "--list"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, GRADEIQ_UPLOAD_RETENTION_KEEP_CLIENTS: "swapmore-in" },
  });
  assert.ok(!env.stdout.includes(swapupPhoto));
});

await t("--days moves the cutoff", () => {
  const r = run("--list", "--days", "500");
  assert.match(r.stdout, /would remove: 0 files/);
});

await t("--apply removes exactly those files and keeps everything protected", () => {
  const rows = db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n;
  const r = run("--apply");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /APPLY: files will be deleted/);
  assert.match(r.stdout, new RegExp(`removed:\\s+${doomed.length} files`));
  for (const f of doomed) assert.ok(!exists(f), `${f} removed`);
  for (const f of [openFresh, camShot, acceptedPhoto, paidOutPhoto, purchasedPhoto, busyPhoto, kycShot, orphanFresh]) {
    assert.ok(exists(f), `${f} kept`);
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n, rows, "no session row touched");
});

await t("refuses to run without the database (every file would look unowned)", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "giq-retention-empty-"));
  fs.mkdirSync(path.join(empty, "uploads"));
  fs.writeFileSync(path.join(empty, "uploads", "x.jpg"), "x");
  const r = run("--apply", "--data", empty);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no database/);
  assert.ok(fs.existsSync(path.join(empty, "uploads", "x.jpg")));
});

await t("an unknown option is an error, not a silent default", () => {
  const r = run("--aply");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown option --aply/);
});

console.log(`${pass} passed`);
