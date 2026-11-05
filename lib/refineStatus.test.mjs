// SUP-63 — a grade stuck on `refining` reads as "did not finish", not a spinner.
//
// The capture stores `cosmetic.refining = true` and finishes the grade in a
// detached task. When the process dies under that task nothing clears the
// flag, and the report showed "Full inspection still running" for ever. These
// tests pin:
//   • the limit is derived from the vision settings: the Pro call timeout, its
//     one retry after the longest pause, and a margin, and it follows
//     `vision_timeout_ms`;
//   • the threshold itself: younger than or equal to the limit is running,
//     older is unfinished; a record without `_submitId` falls back to
//     `updated_at` and errs towards "running";
//   • GET /api/sessions/[id] and the staff detail say `refine.state`, and a read
//     changes NO rows (the stored flag stays exactly as it was);
//   • the way out is the existing staff re-grade: anonymous is still refused,
//     staff clears the flag.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

// db.ts opens <cwd>/data/gradeiq.db — never a real database.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "giq-refine-")));
for (const k of Object.keys(process.env)) {
  if (/^(GEMINI_|GOOGLE_API_KEY|OPENAI_|MOONSHOT_|KIMI_|VISION_|PRO_ONLY|GRADEIQ_|GIQ_AUTH_MODE|KEYCLOAK_|PORTAL_PW_|ENT_|PHONECHECK_|IMEI_API_|NEXT_PUBLIC_BASE_PATH|PUBLIC_ORIGIN)/.test(k)) delete process.env[k];
}
if (process.env.NODE_ENV === "development") delete process.env.NODE_ENV;
process.env.GIQ_AUTH_MODE = "legacy";
process.env.GEMINI_API_KEY = "test-key";
const ADMIN_PW = `t-${Math.random().toString(36).slice(2)}`;
process.env.PORTAL_PW_ADMIN = ADMIN_PW;

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

// Every Gemini model answers a clean inspection; anything else is unexpected.
let visionCalls = 0;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (/generativelanguage\.googleapis\.com/.test(u)) {
    visionCalls++;
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ components: {} }) }] } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  throw new Error(`unexpected fetch ${u}`);
};

globalThis.AsyncLocalStorage ??= (await import("node:async_hooks")).AsyncLocalStorage;
const require = createRequire(import.meta.url);
const { workAsyncStorage } = require("next/dist/server/app-render/work-async-storage.external.js");
const { workUnitAsyncStorage } = require("next/dist/server/app-render/work-unit-async-storage.external.js");
const { RequestCookies } = require("next/dist/server/web/spec-extension/cookies.js");
const { NextRequest } = await import("next/server.js");

const { refineLimitMs, refineStatus, refineField, parseDbTime, REFINE_MARGIN_MS } = await import("./refineStatus.ts");
const { refineUnfinishedAfterMs } = await import("./visionProvider.ts");
const { setSetting } = await import("./settings.ts");
const { db, getSession } = await import("./db.ts");
const { checkLogin } = await import("./portalAuth.ts");
const contract = await import("../contracts/grade-result.ts");
const sessionRoute = await import("../app/api/sessions/[id]/route.ts");
const portalRoute = await import("../app/api/portal/sessions/[id]/route.ts");
const reprocessRoute = await import("../app/api/sessions/[id]/reprocess/route.ts");

const BASE = "http://localhost:3700";
const PRO_DEFAULT = 150_000;
const PAUSE_MAX = 1_200;

function inRequest(cookie, fn) {
  const cookies = new RequestCookies(new Headers(cookie ? { cookie } : {}));
  return workAsyncStorage.run({ route: "/api/test", forceStatic: false, dynamicShouldError: false }, () =>
    workUnitAsyncStorage.run({ type: "request", phase: "render", cookies }, fn)
  );
}
const adminCookie = () => {
  const hit = checkLogin("admin", ADMIN_PW);
  assert.ok(hit, "legacy sign-in for admin");
  return `giq_portal=${hit.token}`;
};
const params = (id) => ({ params: Promise.resolve({ id }) });

console.log("refine status — the limit");

await t("the limit is the Pro timeout, its one retry after the longest pause, and the margin", () => {
  assert.equal(REFINE_MARGIN_MS, 120_000);
  assert.equal(refineLimitMs(PRO_DEFAULT, PAUSE_MAX), 2 * 150_000 + 1_200 + 120_000);
  assert.equal(refineLimitMs(PRO_DEFAULT, PAUSE_MAX, 0), 301_200);
  // Nonsense inputs count as zero rather than producing NaN.
  assert.equal(refineLimitMs(NaN, -5, 1000), 1000);
});

await t("…taken from lib/visionProvider.ts: defaults give about 7 minutes", () => {
  assert.equal(refineUnfinishedAfterMs(), 421_200);
});

await t("…and it follows vision_timeout_ms (env or setting), so a longer call budget waits longer", () => {
  process.env.VISION_TIMEOUT_MS = "30000";
  try {
    assert.equal(refineUnfinishedAfterMs(), 2 * 30_000 + PAUSE_MAX + REFINE_MARGIN_MS);
  } finally {
    delete process.env.VISION_TIMEOUT_MS;
  }
  setSetting("vision_timeout_ms", "200000");
  try {
    assert.equal(refineUnfinishedAfterMs(), 2 * 200_000 + PAUSE_MAX + REFINE_MARGIN_MS);
  } finally {
    setSetting("vision_timeout_ms", "");
  }
  assert.equal(refineUnfinishedAfterMs(), 421_200);
});

console.log("refine status — the threshold");

const LIMIT = 421_200;
const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const at = (cosmetic, extra = {}) => refineStatus(cosmetic, { now: NOW, limitMs: LIMIT, ...extra }).state;

await t("not refining is none, whatever its age", () => {
  assert.equal(at({ grade: "A", _submitId: NOW - 10 * LIMIT }), "none");
  assert.equal(at({ refining: false, refineError: "unavailable", _submitId: NOW - 10 * LIMIT }), "none");
  assert.equal(at(null), "none");
  assert.equal(at({}), "none");
  assert.equal(at({ refining: "true", _submitId: NOW - 10 * LIMIT }), "none", "only a real true counts");
});

await t("refining: running up to and including the limit, unfinished one millisecond past it", () => {
  assert.equal(at({ refining: true, _submitId: NOW - 1_000 }), "running");
  assert.equal(at({ refining: true, _submitId: NOW - (LIMIT - 1) }), "running");
  assert.equal(at({ refining: true, _submitId: NOW - LIMIT }), "running");
  assert.equal(at({ refining: true, _submitId: NOW - (LIMIT + 1) }), "unfinished");
  assert.equal(at({ refining: true, findings: [], _submitId: NOW - 6 * 3600_000 }), "unfinished");
});

await t("a start in the future (clock skew) is running, never unfinished", () => {
  assert.equal(at({ refining: true, _submitId: NOW + 60_000 }), "running");
});

await t("no _submitId: falls back to updated_at (SQLite UTC text or ISO)", () => {
  const old = new Date(NOW - LIMIT - 60_000).toISOString(); // 2026-10-22T11:51:58.800Z
  const sqlite = old.slice(0, 19).replace("T", " ");
  assert.equal(parseDbTime(sqlite), Date.parse(old.slice(0, 19) + "Z"));
  assert.equal(at({ refining: true }, { updatedAt: sqlite }), "unfinished");
  assert.equal(at({ refining: true }, { updatedAt: old }), "unfinished");
  const fresh = new Date(NOW - 30_000).toISOString().slice(0, 19).replace("T", " ");
  assert.equal(at({ refining: true }, { updatedAt: fresh }), "running");
});

await t("…and _submitId wins over updated_at (a later unrelated write must not hide a stuck grade)", () => {
  const justNow = new Date(NOW - 5_000).toISOString().slice(0, 19).replace("T", " ");
  assert.equal(at({ refining: true, _submitId: NOW - LIMIT - 1 }, { updatedAt: justNow }), "unfinished");
});

await t("no usable time at all is running (the record's own claim), not a guess", () => {
  assert.equal(at({ refining: true }), "running");
  assert.equal(at({ refining: true, _submitId: 42 }, { updatedAt: "not a date" }), "running");
  assert.equal(parseDbTime(""), null);
  assert.equal(parseDbTime(undefined), null);
});

await t("refineField reports the state, the ISO start and the limit in seconds", () => {
  const st = refineStatus({ refining: true, _submitId: NOW - LIMIT - 1 }, { now: NOW, limitMs: LIMIT });
  assert.deepEqual(refineField(st), {
    state: "unfinished",
    startedAt: new Date(NOW - LIMIT - 1).toISOString(),
    unfinishedAfterSeconds: 421,
  });
  assert.deepEqual(refineField(refineStatus({}, { now: NOW, limitMs: LIMIT })), {
    state: "none",
    startedAt: null,
    unfinishedAfterSeconds: 421,
  });
});

console.log("refine status — reads change no rows");

// A real (tiny) photo on disk, so the staff re-grade has something to read.
const sharp = (await import("sharp")).default;
fs.mkdirSync(path.join(process.cwd(), "data", "uploads"), { recursive: true });
const jpeg = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 90, g: 90, b: 90 } } }).jpeg().toBuffer();
fs.writeFileSync(path.join(process.cwd(), "data", "uploads", "stuck-1.jpg"), jpeg);

function seed(id, cosmetic, updatedAt) {
  db.prepare(
    `INSERT INTO sessions (id, client_id, model, status, cosmetic, photos, updated_at)
     VALUES (?, 'default', 'iPhone 13', 'open', ?, ?, ?)`
  ).run(id, JSON.stringify(cosmetic), JSON.stringify(["/api/uploads/stuck-1.jpg"]), updatedAt);
}
const rowOf = (id) => db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
const changes = () => db.prepare("SELECT total_changes() AS n").get().n;
const sqliteNow = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

const realNow = Date.now();
// Died 20 minutes ago: the background upload's placeholder, exactly as the
// cosmetic route stores it.
seed("stuck", { refining: true, findings: [], _submitId: realNow - 20 * 60_000 }, sqliteNow(realNow - 20 * 60_000));
// Submitted 10 seconds ago: still legitimately running.
seed("busy", { refining: true, findings: [], _submitId: realNow - 10_000 }, sqliteNow(realNow - 10_000));
// A Flash grade whose Pro refinement died: the grade stands, the flag is stale.
seed("flash-stuck", { grade: "A", tierUsed: "flash", refining: true, findings: [], _submitId: realNow - 60 * 60_000 }, sqliteNow(realNow - 60 * 60_000));

await t("GET /api/sessions/[id]: refine.state unfinished for a dead grade, running for a live one", async () => {
  const stuck = await (await sessionRoute.GET(new Request(`${BASE}/api/sessions/stuck`), params("stuck"))).json();
  assert.equal(stuck.refine.state, "unfinished");
  assert.equal(stuck.refine.unfinishedAfterSeconds, 421);
  assert.equal(stuck.refine.startedAt, new Date(realNow - 20 * 60_000).toISOString());
  const busy = await (await sessionRoute.GET(new Request(`${BASE}/api/sessions/busy`), params("busy"))).json();
  assert.equal(busy.refine.state, "running");
  const flash = await (await sessionRoute.GET(new Request(`${BASE}/api/sessions/flash-stuck`), params("flash-stuck"))).json();
  assert.equal(flash.refine.state, "unfinished");
});

await t("…the stored cosmetic goes out unchanged (SwapUp keeps reading a stale flag as not final)", async () => {
  const body = await (await sessionRoute.GET(new Request(`${BASE}/api/sessions/flash-stuck`), params("flash-stuck"))).json();
  assert.deepEqual(body.cosmetic, getSession("flash-stuck").cosmetic);
  assert.equal(body.cosmetic.refining, true);
  assert.deepEqual(contract.gradeResultProblems(body), []);
});

await t("…and reading changes NO rows: same row bytes, no database change counted", async () => {
  for (const id of ["stuck", "busy", "flash-stuck"]) {
    const before = rowOf(id);
    const n = changes();
    for (let i = 0; i < 3; i++) await sessionRoute.GET(new Request(`${BASE}/api/sessions/${id}`), params(id));
    assert.equal(changes(), n, `${id}: a write happened during a read`);
    assert.deepEqual(rowOf(id), before, id);
  }
});

await t("the staff session detail says the same, and is just as read-only", async () => {
  const cookie = adminCookie();
  const before = rowOf("stuck");
  const n = changes();
  const r = await inRequest(cookie, () =>
    portalRoute.GET(new NextRequest(`${BASE}/api/portal/sessions/stuck`), params("stuck"))
  );
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.vision.refine.state, "unfinished");
  assert.equal(changes(), n);
  assert.deepEqual(rowOf("stuck"), before);
  const busy = await (await inRequest(cookie, () =>
    portalRoute.GET(new NextRequest(`${BASE}/api/portal/sessions/busy`), params("busy"))
  )).json();
  assert.equal(busy.vision.refine.state, "running");
});

await t("the grade-result checker holds `refine` to its shape when present", () => {
  const good = { id: "x", client_id: "c", imei: "", model: "", status: "open", cosmetic_grade: "", functional_grade: "", overall_grade: "", functional: {}, photos: [], cosmetic: {}, screen: {}, capture: {}, identity: { verdict: "unverified", flags: [], modelLevel: false, imei: { brand: "", model: "" }, connected: null }, trust: 70 };
  assert.deepEqual(contract.gradeResultProblems(good), [], "absent is fine (older server)");
  assert.deepEqual(contract.gradeResultProblems({ ...good, refine: { state: "none", startedAt: null, unfinishedAfterSeconds: 421 } }), []);
  assert.deepEqual(contract.gradeResultProblems({ ...good, refine: { state: "stuck", startedAt: null, unfinishedAfterSeconds: 421 } }), ["refine.state: stuck"]);
  assert.deepEqual(contract.gradeResultProblems({ ...good, refine: "unfinished" }), ["refine: not an object"]);
});

console.log("refine status — the way out is the staff re-grade");

await t("an anonymous re-grade is still refused (401) and the stuck record is untouched", async () => {
  const before = rowOf("stuck");
  const calls = visionCalls;
  const r = await inRequest("", () =>
    reprocessRoute.POST(new NextRequest(`${BASE}/api/sessions/stuck/reprocess`, { method: "POST", body: "{}" }), params("stuck"))
  );
  assert.equal(r.status, 401);
  assert.deepEqual(rowOf("stuck"), before);
  assert.equal(visionCalls, calls, "no model was called");
});

await t("staff re-grade settles it: the flag is gone and the session reads as none", async () => {
  const r = await inRequest(adminCookie(), () =>
    reprocessRoute.POST(
      new NextRequest(`${BASE}/api/sessions/stuck/reprocess`, { method: "POST", body: JSON.stringify({ tier: "pro" }) }),
      params("stuck")
    )
  );
  const d = await r.json();
  assert.equal(r.status, 200, JSON.stringify(d));
  assert.ok(visionCalls > 0);
  const s = getSession("stuck");
  assert.notEqual(s.cosmetic.refining, true);
  const body = await (await sessionRoute.GET(new Request(`${BASE}/api/sessions/stuck`), params("stuck"))).json();
  assert.equal(body.refine.state, "none");
});

console.log(pass + " assertions passed\n");
