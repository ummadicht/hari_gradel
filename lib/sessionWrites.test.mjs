// SUP-66 — who may rewrite a grade through the anonymous session routes.
//
// /grade-manual and /functional are reached with nothing but the session id,
// which the seller holds. These tests pin the rules in lib/sessionWriteRules.ts
// THROUGH THE PRODUCTION ROUTE HANDLERS:
//   • a seller's pick is provisional and cannot replace an AI or staff grade;
//   • a recorded fail cannot be cleared without staff (fail→pass, fail→skip,
//     dropped by a non-merge write, a failed lens), and nothing changes once
//     the offer was accepted / the purchase committed;
//   • the refusal is PER RESULT: the kept result stays, the rest of the write
//     saves (a self-test re-run is not thrown away for one test);
//   • a lens staff or the photo check decided, or one the browser cannot test,
//     is not passed by a browser stamp; no lens is dropped; the camera result
//     cannot outrun the lens record;
//   • a seller's provisional pick is priced at the lowest grade;
//   • the phone's first self-test, new results and worse results still save;
//   • staff — a real portal cookie (legacy) or Keycloak session (oidc) — may
//     override, and every override and refusal lands in the event trail.
//
// Staff is not faked: each call runs inside a Next request scope carrying the
// cookie a browser would send, so portalUser() resolves it exactly as in prod.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

// db.ts opens <cwd>/data/gradeiq.db — never a real database.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "giq-session-writes-")));
for (const k of Object.keys(process.env)) {
  if (/^(PHONECHECK_|IMEI_API_|GEMINI_|GOOGLE_API_KEY|GRADEIQ_SERVER_KEY|GIQ_AUTH_MODE|KEYCLOAK_|PORTAL_PW_|ENT_)/.test(k)) delete process.env[k];
}
if (process.env.NODE_ENV === "development") delete process.env.NODE_ENV;
process.env.GIQ_AUTH_MODE = "legacy";
// Operator-set passwords (generated per run), so nothing leans on a default.
const ADMIN_PW = `t-${Math.random().toString(36).slice(2)}`;
const DENOVO_PW = `t-${Math.random().toString(36).slice(2)}`;
process.env.PORTAL_PW_ADMIN = ADMIN_PW;
process.env.PORTAL_PW_DENOVO = DENOVO_PW;

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

// No network: nothing here may reach Phonecheck or a vision model.
globalThis.fetch = async (url) => {
  throw new Error(`unexpected fetch ${url}`);
};

// Next's server runtime installs this global before any request store exists;
// without it the stores are inert fakes whose run() throws.
globalThis.AsyncLocalStorage ??= (await import("node:async_hooks")).AsyncLocalStorage;
const require = createRequire(import.meta.url);
const { workAsyncStorage } = require("next/dist/server/app-render/work-async-storage.external.js");
const { workUnitAsyncStorage } = require("next/dist/server/app-render/work-unit-async-storage.external.js");
const { RequestCookies } = require("next/dist/server/web/spec-extension/cookies.js");

const sessionsRoute = await import("../app/api/sessions/route.ts");
const functionalRoute = await import("../app/api/sessions/[id]/functional/route.ts");
const gradeRoute = await import("../app/api/sessions/[id]/grade-manual/route.ts");
const offerRoute = await import("../app/api/sessions/[id]/offer/route.ts");
const { db, getSession } = await import("./db.ts");
const { eventsFor } = await import("./events.ts");
const { checkLogin } = await import("./portalAuth.ts");
const { insertSession, newSid } = await import("./oidc-session.ts");
const { buildPassport } = await import("./passport.ts");
// The purchases table as lib/purchase.ts creates it (status + session link are
// all the lock reads). Importing purchase.ts itself drags in the JSON price seed.
db.exec(`CREATE TABLE IF NOT EXISTS purchases (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, created_by TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'intake', customer TEXT NOT NULL DEFAULT '{}', kyc TEXT NOT NULL DEFAULT '{}',
  session_id TEXT NOT NULL DEFAULT '', offer TEXT NOT NULL DEFAULT '{}', clearance TEXT NOT NULL DEFAULT '{}',
  payout TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

const BASE = "http://localhost:3700";

/** Run a handler the way Next does: inside a request scope with this cookie header. */
function inRequest(cookie, fn) {
  const cookies = new RequestCookies(new Headers(cookie ? { cookie } : {}));
  return workAsyncStorage.run({ route: "/api/test", forceStatic: false, dynamicShouldError: false }, () =>
    workUnitAsyncStorage.run({ type: "request", phase: "render", cookies }, fn)
  );
}

const legacyCookie = (user, pw) => {
  const hit = checkLogin(user, pw);
  assert.ok(hit, `legacy sign-in for ${user}`);
  return `giq_portal=${hit.token}`;
};

async function newSession(client = "swapmore-in") {
  const r = await inRequest("", () =>
    sessionsRoute.POST(
      new Request(`${BASE}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client, channel: "retail", segment: "c2b", model: "iPhone 13" }),
      })
    )
  );
  assert.equal(r.status, 200);
  return (await r.json()).id;
}

function post(route, id, sub, body, { cookie = "", headers = {} } = {}) {
  return inRequest(cookie, () =>
    route.POST(
      new Request(`${BASE}/api/sessions/${id}/${sub}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) }
    )
  );
}
const functional = (id, body, opts) => post(functionalRoute, id, "functional", body, opts);
const gradeManual = (id, grade, opts) => post(gradeRoute, id, "grade-manual", { grade }, opts);
const offerFor = async (id) => (await (await post(offerRoute, id, "offer", {})).json()).offer;
/** Put a camera record on the session as the server routes leave it. */
const setCamera = (id, lenses, fn = { camera: "skip" }) =>
  db.prepare("UPDATE sessions SET camera = ?, functional = ? WHERE id = ?").run(JSON.stringify({ lenses }), JSON.stringify(fn), id);
const lensOf = (id, lensId) => getSession(id).camera.lenses.find((l) => l.id === lensId);

/** What the vision pipeline leaves behind (cosmetic route persistCosmetic). */
function giveAiGrade(id, grade = "C") {
  db.prepare("UPDATE sessions SET cosmetic = ?, cosmetic_grade = ? WHERE id = ?").run(
    JSON.stringify({ grade, confidence: 0.55, conclusive: false, source: "gemini", tierUsed: "pro", findings: [] }),
    grade,
    id
  );
}
const events = (id, event) => eventsFor(id).filter((e) => !event || e.event === event);

console.log("grade-manual");

await t("a seller's pick on an ungraded phone saves, PROVISIONAL", async () => {
  const id = await newSession();
  const r = await gradeManual(id, "A");
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.provisional, true);
  const s = getSession(id);
  assert.equal(s.cosmetic_grade, "A");
  assert.equal(s.cosmetic.conclusive, false);
  assert.notEqual(s.cosmetic.confidence, 1);
  assert.equal(s.cosmetic.provisional, true);
  assert.equal(s.cosmetic.by, "seller");
  // The passport no longer prints VERIFIED over the seller's own word.
  assert.equal(buildPassport(s).verified, false);
  assert.equal(events(id, "manual-grade-provisional").length, 1);
});

await t("the seller may change their own provisional pick", async () => {
  const id = await newSession();
  assert.equal((await gradeManual(id, "B")).status, 200);
  assert.equal((await gradeManual(id, "A")).status, 200);
  assert.equal(getSession(id).cosmetic_grade, "A");
});

await t("a manual pick cannot replace an AI grade without staff (409)", async () => {
  const id = await newSession();
  giveAiGrade(id, "C");
  const r = await gradeManual(id, "Premium");
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /photos already produced a grade/);
  const s = getSession(id);
  assert.equal(s.cosmetic_grade, "C");
  assert.equal(s.cosmetic.source, "gemini");
  const refused = events(id, "manual-grade-refused");
  assert.equal(refused.length, 1);
  assert.equal(refused[0].detail.from, "C");
  assert.equal(refused[0].detail.fromOwner, "ai");
});

await t("a stub AI pass (no model answered, no grade) still lets the seller pick", async () => {
  const id = await newSession();
  db.prepare("UPDATE sessions SET cosmetic = ? WHERE id = ?").run(
    JSON.stringify({ grade: "", source: "stub", tierUsed: "stub" }),
    id
  );
  assert.equal((await gradeManual(id, "B")).status, 200);
});

await t("staff (legacy portal cookie) may overrule the AI grade — conclusive, logged with the name", async () => {
  const id = await newSession();
  giveAiGrade(id, "C");
  const r = await gradeManual(id, "B", { cookie: legacyCookie("admin", ADMIN_PW) });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).provisional, false);
  const s = getSession(id);
  assert.equal(s.cosmetic_grade, "B");
  assert.equal(s.cosmetic.conclusive, true);
  assert.equal(s.cosmetic.by, "staff");
  // The name is in the operator-only trail, never on the record the link serves.
  assert.ok(!JSON.stringify(s.cosmetic).includes("admin"));
  const ev = events(id, "manual-grade-staff");
  assert.equal(ev.length, 1);
  assert.equal(ev[0].detail.actor, "admin");
  assert.equal(ev[0].detail.override, true);
  assert.equal(ev[0].detail.from, "C");
});

await t("staff (Keycloak session, oidc mode) may overrule too", async () => {
  const id = await newSession();
  giveAiGrade(id, "D");
  const sid = newSid();
  insertSession({ sid, sub: "kc-1", email: "ops@example.test", name: "Ops", role: "super", clientId: null, id_token: null });
  process.env.GIQ_AUTH_MODE = "oidc";
  try {
    const r = await gradeManual(id, "C", { cookie: `giq_session=${sid}` });
    assert.equal(r.status, 200);
    assert.equal(getSession(id).cosmetic.by, "staff");
    assert.equal(events(id, "manual-grade-staff")[0].detail.actor, "ops@example.test");
    // …and in oidc mode a legacy portal cookie is nobody.
    const id2 = await newSession();
    giveAiGrade(id2, "D");
    process.env.GIQ_AUTH_MODE = "legacy";
    const cookie = legacyCookie("admin", ADMIN_PW);
    process.env.GIQ_AUTH_MODE = "oidc";
    assert.equal((await gradeManual(id2, "A", { cookie })).status, 409);
  } finally {
    process.env.GIQ_AUTH_MODE = "legacy";
  }
});

await t("a staff grade cannot be replaced by a seller (409)", async () => {
  const id = await newSession();
  assert.equal((await gradeManual(id, "C", { cookie: legacyCookie("admin", ADMIN_PW) })).status, 200);
  assert.equal((await gradeManual(id, "Premium")).status, 409);
  assert.equal(getSession(id).cosmetic_grade, "C");
});

await t("a client admin of ANOTHER tenant is not staff for this session", async () => {
  const id = await newSession("swapmore-in");
  giveAiGrade(id, "C");
  assert.equal((await gradeManual(id, "A", { cookie: legacyCookie("denovo", DENOVO_PW) })).status, 409);
  // …but is for their own tenant's sessions.
  const own = await newSession("denovo");
  giveAiGrade(own, "C");
  assert.equal((await gradeManual(own, "A", { cookie: legacyCookie("denovo", DENOVO_PW) })).status, 200);
});

await t("after acceptance a seller's pick is refused (409), staff still may", async () => {
  const id = await newSession();
  db.prepare("UPDATE sessions SET accepted = 1 WHERE id = ?").run(id);
  const r = await gradeManual(id, "A");
  assert.equal(r.status, 409);
  assert.equal((await r.json()).code, "final");
  assert.equal((await gradeManual(id, "A", { cookie: legacyCookie("admin", ADMIN_PW) })).status, 200);
});

await t("an unknown grade is 400", async () => {
  const id = await newSession();
  assert.equal((await gradeManual(id, "A+")).status, 400);
});

console.log("functional");

await t("the phone's first self-test results save (200)", async () => {
  const id = await newSession();
  const r = await functional(id, {
    functional: { touch: "pass", display: "pass", speaker: "pass", mic: "fail", camera: "skip" },
    camera: { expected: 2, verified: 1, manual: 1, failed: 0, lenses: [
      { id: "wide", name: "Wide", facing: "rear", state: "pass", by: "browser" },
      { id: "tele", name: "Telephoto", facing: "rear", state: "manual" },
    ] },
    audio: { profile: [{ hz: 400, delta: 20, heard: true }], weakBands: [] },
    merge: true,
  });
  assert.equal(r.status, 200);
  const s = getSession(id);
  assert.equal(s.functional.mic, "fail");
  assert.equal(s.functional_grade, "Faulty");
  assert.equal(s.camera.lenses.length, 2);
  assert.equal(events(id, "results-recorded")[0].detail.by, "anonymous");
});

await t("new results, skip→pass and pass→fail still save without staff", async () => {
  const id = await newSession();
  assert.equal((await functional(id, { functional: { display: "skip", touch: "pass" }, merge: true })).status, 200);
  assert.equal((await functional(id, { functional: { display: "pass" }, merge: true })).status, 200); // report manual check
  assert.equal((await functional(id, { functional: { touch: "fail", faceid: "pass" }, merge: true })).status, 200);
  assert.deepEqual(getSession(id).functional, { display: "pass", touch: "fail", faceid: "pass" });
});

await t("an invalid result is 400 and stores nothing", async () => {
  const id = await newSession();
  for (const bad of [{ mic: "ok" }, { mic: 1 }, { mic: null }, ["pass"], "pass", { "a b": "pass" }]) {
    const r = await functional(id, { functional: bad, merge: true });
    assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
  }
  assert.equal((await functional(id, { functional: { mic: "pass" }, camera: { lenses: [{ id: "w", state: "great" }] }, merge: true })).status, 400);
  assert.deepEqual(getSession(id).functional, {});
});

await t("anonymous fail→pass keeps the fail (200 + refused) — and the rest of the write saves", async () => {
  const id = await newSession();
  await functional(id, { functional: { mic: "fail", touch: "pass" }, merge: true });
  const r = await functional(id, { functional: { mic: "pass", speaker: "pass" }, merge: true });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.code, "needs-staff");
  assert.deepEqual(body.refused, ["mic: fail → pass"]);
  assert.match(body.notice, /Microphone, kept as recorded before\. Only the store can change that result\./);
  const s = getSession(id);
  assert.equal(s.functional.mic, "fail");
  assert.equal(s.functional.speaker, "pass", "the rest of the write is stored");
  assert.equal(s.functional_grade, "Faulty");
  const refused = events(id, "write-refused");
  assert.equal(refused.length, 1);
  assert.equal(refused[0].detail.status, 200);
  assert.deepEqual(refused[0].detail.changes, ["mic: fail → pass"]);
});

await t("fail→skip and a fail dropped by a non-merge write keep the fail too", async () => {
  const id = await newSession();
  await functional(id, { functional: { mic: "fail", touch: "pass" }, merge: true });
  const skip = await functional(id, { functional: { mic: "skip" }, merge: true });
  assert.equal(skip.status, 200);
  assert.deepEqual((await skip.json()).refused, ["mic: fail → skip"]);
  assert.equal(getSession(id).functional.mic, "fail");
  // A body with no `merge` REPLACES the map — leaving mic out would erase the fault.
  const replace = await functional(id, { functional: { touch: "fail", speaker: "pass" } });
  assert.equal(replace.status, 200);
  assert.deepEqual((await replace.json()).refused, ["mic: fail → removed"]);
  assert.deepEqual(getSession(id).functional, { touch: "fail", speaker: "pass", mic: "fail" });
  assert.equal((await functional(id, {})).status, 200);
  assert.deepEqual(getSession(id).functional, { touch: "fail", mic: "fail" });
  // Re-sending the fail as part of a full map is clean (SwapUp's call 3 shape).
  const full = await functional(id, { functional: { mic: "fail", touch: "fail", speaker: "pass" }, merge: true });
  assert.equal(full.status, 200);
  assert.equal((await full.json()).refused, undefined);
});

await t("a self-test RE-RUN where a failed test now passes still stores every other result and the camera detail", async () => {
  const id = await newSession();
  // First run in a noisy store: the speaker loopback failed.
  await functional(id, {
    functional: { touch: "pass", speaker: "fail", mic: "pass", camera: "skip" },
    camera: { lenses: [{ id: "wide", name: "Wide", facing: "rear", state: "pass", by: "browser" }, { id: "tele", name: "Telephoto", facing: "rear", state: "manual" }] },
    merge: true,
  });
  // The seller reloads the QR page and runs it again (DeviceTest's one merge write).
  const r = await functional(id, {
    functional: { touch: "pass", speaker: "pass", mic: "pass", vibration: "fail", camera: "skip" },
    camera: {
      lenses: [
        { id: "wide", name: "Wide", facing: "rear", state: "pass", by: "browser" },
        { id: "tele", name: "Telephoto", facing: "rear", state: "manual" },
        { id: "front", name: "Front", facing: "front", state: "pass", by: "browser" },
      ],
    },
    audio: { profile: [{ hz: 1000, delta: 25, heard: true }], weakBands: [] },
    merge: true,
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.deepEqual(body.refused, ["speaker: fail → pass"]);
  assert.match(body.notice, /^Saved — except Speaker, kept as recorded before/);
  const s = getSession(id);
  assert.equal(s.functional.speaker, "fail", "the recorded fault stays");
  assert.equal(s.functional.vibration, "fail", "the new result is stored");
  assert.equal(s.camera.lenses.length, 3, "the new camera detail is stored");
  assert.equal(s.camera.verified, 2);
  assert.equal(events(id, "results-recorded").length, 2);
});

await t("a failed lens cannot be weakened, and operator / vision stamps need staff — the lens is kept, the rest saves", async () => {
  const id = await newSession();
  const lenses = [
    { id: "wide", name: "Wide", facing: "rear", state: "fail", by: "browser" },
    { id: "tele", name: "Telephoto", facing: "rear", state: "manual" },
  ];
  await functional(id, { functional: { camera: "fail" }, camera: { lenses }, merge: true });
  const weaken = await functional(id, {
    functional: { touch: "pass" },
    camera: { lenses: [{ ...lenses[0], state: "pass" }, lenses[1]] },
    merge: true,
  });
  assert.equal(weaken.status, 200);
  assert.deepEqual((await weaken.json()).refused, ["lens wide: fail → pass"]);
  assert.equal(lensOf(id, "wide").state, "fail");
  assert.equal(getSession(id).functional.touch, "pass");
  const drop = await functional(id, { functional: {}, camera: { lenses: [lenses[1]] }, merge: true });
  assert.equal(drop.status, 200);
  assert.deepEqual((await drop.json()).refused, ["lens wide: fail → removed"]);
  assert.equal(lensOf(id, "wide").state, "fail", "a lens left out of the write is kept");
  const stamp = await functional(id, {
    functional: {},
    camera: { lenses: [lenses[0], { ...lenses[1], state: "pass", by: "operator" }] },
    merge: true,
  });
  assert.equal(stamp.status, 200);
  assert.deepEqual((await stamp.json()).refused, ["lens tele: operator stamp"]);
  const vision = await functional(id, {
    functional: {},
    camera: { lenses: [lenses[0], { ...lenses[1], state: "pass", by: "vision" }] },
    merge: true,
  });
  assert.equal(vision.status, 200);
  assert.deepEqual((await vision.json()).refused, ["lens tele: vision stamp"]);
  assert.equal(lensOf(id, "tele").state, "manual");
  assert.equal(lensOf(id, "tele").by, undefined);
  // Making the unmeasured lens WORSE is still the seller's to report.
  const worse = await functional(id, { functional: {}, camera: { lenses: [lenses[0], { ...lenses[1], state: "fail", by: "browser" }] }, merge: true });
  assert.equal(worse.status, 200);
  assert.equal((await worse.json()).refused, undefined);
  assert.equal(getSession(id).camera.failed, 2);
});

await t("a lens the photo check decided cannot be passed by a browser stamp or no stamp — and the pending count stays", async () => {
  const id = await newSession();
  // What /lens-verify leaves when the photos were too soft to judge: "unverified", stored as manual.
  setCamera(id, [
    { id: "wide", name: "Wide", facing: "rear", state: "pass", by: "browser" },
    { id: "telephoto", name: "Telephoto", facing: "rear", state: "manual", by: "vision", reason: "Too soft to judge" },
  ]);
  const before = buildPassport(getSession(id)).functional.items.find((f) => /Cameras/.test(f.name)).detail;
  assert.match(before, /1 not testable in-browser/);
  for (const by of ["browser", undefined]) {
    const r = await functional(id, { merge: true, functional: {}, camera: { lenses: [{ id: "telephoto", state: "pass", ...(by ? { by } : {}) }] } });
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json()).refused, ["lens telephoto: changes the photo check's verdict"]);
  }
  const tele = lensOf(id, "telephoto");
  assert.equal(tele.state, "manual");
  assert.equal(tele.by, "vision");
  assert.equal(tele.reason, "Too soft to judge", "the stored entry is kept whole");
  assert.equal(lensOf(id, "wide").state, "pass", "the lens the write left out is kept");
  assert.equal(buildPassport(getSession(id)).functional.items.find((f) => /Cameras/.test(f.name)).detail, before);
  // A vision PASS cannot be made vaguer either — only worse.
  setCamera(id, [{ id: "telephoto", name: "Telephoto", facing: "rear", state: "pass", by: "vision" }], { camera: "pass" });
  assert.deepEqual((await (await functional(id, { merge: true, functional: {}, camera: { lenses: [{ id: "telephoto", state: "manual" }] } })).json()).refused, [
    "lens telephoto: changes the photo check's verdict",
  ]);
  const worse = await functional(id, { merge: true, functional: {}, camera: { lenses: [{ id: "telephoto", state: "fail", by: "browser" }] } });
  assert.equal((await worse.json()).refused, undefined);
  assert.equal(lensOf(id, "telephoto").state, "fail");
});

await t("a lens the browser could not open (manual, no stamp) cannot become a pass — one it measured before can", async () => {
  const id = await newSession();
  setCamera(id, [
    { id: "wide", name: "Wide", facing: "rear", state: "pass", by: "browser" },
    { id: "ultra", name: "Ultra wide", facing: "rear", state: "manual" },
    { id: "front", name: "Front", facing: "front", state: "manual", by: "browser" },
  ]);
  const r = await functional(id, {
    merge: true,
    functional: {},
    camera: {
      lenses: [
        { id: "wide", state: "pass", by: "browser" },
        { id: "ultra", state: "pass", by: "browser" },
        { id: "front", state: "pass", by: "browser" },
      ],
    },
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.deepEqual(body.refused, ["lens ultra: manual → pass (the browser cannot test this lens)"]);
  assert.match(body.notice, /Ultra wide lens/);
  assert.equal(lensOf(id, "ultra").state, "manual");
  assert.equal(lensOf(id, "front").state, "pass", "the browser measured this one before");
  assert.equal(getSession(id).camera.manual, 1);
});

await t("a pending lens cannot be dropped, and the camera result cannot outrun the lens record", async () => {
  const id = await newSession();
  setCamera(id, [
    { id: "wide", name: "Wide", facing: "rear", state: "pass", by: "browser" },
    { id: "tele", name: "Telephoto", facing: "rear", state: "manual" },
  ]);
  const drop = await functional(id, { merge: true, functional: {}, camera: { lenses: [{ id: "wide", state: "pass", by: "browser" }] } });
  assert.deepEqual((await drop.json()).refused, ["lens tele: manual → removed"]);
  assert.equal(getSession(id).camera.lenses.length, 2);
  assert.equal(getSession(id).camera.manual, 1);
  // The report's "Working" on the Cameras row: refused while a lens is unchecked.
  const cam = await functional(id, { merge: true, functional: { camera: "pass", touch: "pass" } });
  assert.equal(cam.status, 200);
  assert.deepEqual((await cam.json()).refused, ["camera: pass → skip (lenses not all verified)"]);
  assert.equal(getSession(id).functional.camera, "skip");
  assert.equal(getSession(id).functional.touch, "pass");
  // Once staff checked the lens by hand, the camera may read as working.
  const lenses = getSession(id).camera.lenses.map((l) => (l.id === "tele" ? { ...l, state: "pass", by: "operator" } : l));
  assert.equal((await functional(id, { merge: true, functional: {}, camera: { lenses } }, { cookie: legacyCookie("admin", ADMIN_PW) })).status, 200);
  const ok = await functional(id, { merge: true, functional: { camera: "pass" } });
  assert.equal((await ok.json()).refused, undefined);
  assert.equal(getSession(id).functional.camera, "pass");
});

await t("the camera record MERGES, and server-owned keys are never set through /functional", async () => {
  const id = await newSession();
  const assessment = { lenses: [{ id: "wide", verdict: "faulty", findings: [] }] };
  db.prepare("UPDATE sessions SET camera = ? WHERE id = ?").run(
    JSON.stringify({ frames: [{ lensId: "wide", url: "/api/uploads/cam-x.jpg" }], assessment }),
    id
  );
  const r = await functional(id, {
    functional: { camera: "pass" },
    camera: { lenses: [{ id: "wide", state: "pass", by: "browser" }], assessment: { lenses: [] }, frames: [] },
    merge: true,
  });
  assert.equal(r.status, 200);
  const cam = getSession(id).camera;
  assert.deepEqual(cam.assessment, assessment, "the faulty-lens assessment survives");
  assert.equal(cam.frames.length, 1, "frames written by /camera-frames survive");
  assert.equal(cam.lenses.length, 1);
  assert.deepEqual(events(id, "results-recorded")[0].detail.ignored, ["camera.assessment", "camera.frames"]);
  // Not by staff either: the report re-sends the copy it rendered, which may be stale.
  const staff = await functional(
    id,
    { functional: {}, camera: { lenses: [{ id: "wide", state: "pass", by: "browser" }], assessment: { lenses: [] } }, merge: true },
    { cookie: legacyCookie("admin", ADMIN_PW) }
  );
  assert.equal(staff.status, 200);
  assert.deepEqual(getSession(id).camera.assessment, assessment);
});

await t("staff may clear a fault and stamp a lens — logged as an override with the name", async () => {
  const id = await newSession();
  await functional(id, {
    functional: { mic: "fail", camera: "skip" },
    camera: { lenses: [{ id: "tele", name: "Telephoto", facing: "rear", state: "manual" }] },
    merge: true,
  });
  const cookie = legacyCookie("admin", ADMIN_PW);
  const r = await functional(
    id,
    { functional: { mic: "pass", camera: "pass" }, camera: { lenses: [{ id: "tele", name: "Telephoto", facing: "rear", state: "pass", by: "operator" }] }, merge: true },
    { cookie }
  );
  assert.equal(r.status, 200);
  const s = getSession(id);
  assert.equal(s.functional.mic, "pass");
  assert.equal(s.functional_grade, "Working");
  assert.equal(s.camera.lenses[0].by, "operator");
  const ov = events(id, "staff-override");
  assert.equal(ov.length, 1);
  assert.equal(ov[0].detail.actor, "admin");
  assert.deepEqual(ov[0].detail.changes, ["mic: fail → pass", "lens tele: operator stamp"]);
  // …and once staff decided a lens, the seller cannot un-decide it.
  const back = await functional(id, { functional: {}, camera: { lenses: [{ id: "tele", state: "manual" }] }, merge: true });
  assert.equal(back.status, 200);
  assert.deepEqual((await back.json()).refused, ["lens tele: changes a staff decision"]);
  assert.equal(lensOf(id, "tele").by, "operator");
  assert.equal(lensOf(id, "tele").state, "pass");
});

await t("any write after acceptance is 409 without staff; staff may, and it is logged", async () => {
  const id = await newSession();
  await functional(id, { functional: { mic: "pass" }, merge: true });
  db.prepare("UPDATE sessions SET accepted = 1 WHERE id = ?").run(id);
  const r = await functional(id, { functional: { touch: "pass" }, merge: true });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).code, "final");
  assert.deepEqual(getSession(id).functional, { mic: "pass" });
  const ok = await functional(id, { functional: { touch: "pass" }, merge: true }, { cookie: legacyCookie("admin", ADMIN_PW) });
  assert.equal(ok.status, 200);
  assert.deepEqual(events(id, "staff-override")[0].detail.changes, ["final (accepted)"]);
});

await t("a passed payout gate or a committed retail purchase locks the session too", async () => {
  const id = await newSession();
  db.prepare("UPDATE sessions SET verification = ? WHERE id = ?").run(JSON.stringify({ payout: { passed: true } }), id);
  assert.equal((await functional(id, { functional: { touch: "pass" }, merge: true })).status, 409);
  const id2 = await newSession();
  db.prepare("INSERT INTO purchases (id, client_id, status, session_id) VALUES (?, ?, ?, ?)").run("p_test_paid", "swapmore-in", "paid", id2);
  assert.equal((await functional(id2, { functional: { touch: "pass" }, merge: true })).status, 409);
  assert.equal((await gradeManual(id2, "A")).status, 409);
  // A BLOCKED accept is not a lock: the seller may fix Find My and try again.
  const id3 = await newSession();
  db.prepare("UPDATE sessions SET verification = ? WHERE id = ?").run(JSON.stringify({ payout: { passed: false } }), id3);
  assert.equal((await functional(id3, { functional: { touch: "pass" }, merge: true })).status, 200);
});

await t("SwapUp's server key may forward a re-run pass over a fail — only when the key is configured", async () => {
  const KEY = "giq-server-key-for-tests";
  const id = await newSession();
  await functional(id, { functional: { mic: "fail" }, merge: true });
  const headers = { "x-gradeiq-server-key": KEY };
  // No key configured on GradeIQ → the header is ignored: the forward saves, the fail is kept.
  const ignored = await functional(id, { functional: { mic: "pass" }, merge: true }, { headers });
  assert.equal(ignored.status, 200);
  assert.deepEqual((await ignored.json()).refused, ["mic: fail → pass"]);
  assert.equal(getSession(id).functional.mic, "fail");
  process.env.GRADEIQ_SERVER_KEY = KEY;
  try {
    await functional(id, { functional: { mic: "pass" }, merge: true }, { headers: { "x-gradeiq-server-key": "wrong" } });
    assert.equal(getSession(id).functional.mic, "fail");
    const ok = await functional(id, { functional: { mic: "pass" }, merge: true }, { headers });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).refused, undefined);
    assert.equal(getSession(id).functional.mic, "pass");
    assert.equal(events(id, "staff-override")[0].detail.by, "server");
    // CounterIQ's retail key buys IMEI lookups, never this.
    process.env.GRADEIQ_RETAIL_KEY = `${KEY}-retail`;
    const id2 = await newSession();
    await functional(id2, { functional: { mic: "fail" }, merge: true });
    const retail = await functional(id2, { functional: { mic: "pass" }, merge: true }, { headers: { "x-gradeiq-retail-key": `${KEY}-retail` } });
    assert.deepEqual((await retail.json()).refused, ["mic: fail → pass"]);
    assert.equal(getSession(id2).functional.mic, "fail");
  } finally {
    delete process.env.GRADEIQ_SERVER_KEY;
    delete process.env.GRADEIQ_RETAIL_KEY;
  }
});

console.log("offer");

await t("a seller's provisional pick is priced at the LOWEST grade, with what it is worth once confirmed", async () => {
  // The US heuristic tenant: the offer engine prices iPhone 13 off its seed table.
  const pick = await newSession("denovo");
  assert.equal((await gradeManual(pick, "Premium")).status, 200);
  const o = await offerFor(pick);
  assert.equal(o.provisional, true);
  assert.deepEqual(o.gradeRange, { best: "Premium", worst: "D" });
  assert.equal(o.offer, o.floor, "no share of the gap for a claim");
  assert.ok(o.ceiling > o.floor, `ceiling ${o.ceiling} > floor ${o.floor}`);
  assert.ok(!o.lines.some((l) => /Uncertainty share/.test(l.label)));
  assert.ok(o.explanation.some((e) => /You picked grade Premium, but nothing has checked/.test(e)), o.explanation.join(" | "));
  // The same phone graded by the store: D is the floor, Premium the ceiling.
  const cookie = legacyCookie("admin", ADMIN_PW);
  const staffD = await newSession("denovo");
  await gradeManual(staffD, "D", { cookie });
  const staffP = await newSession("denovo");
  await gradeManual(staffP, "Premium", { cookie });
  const [d, p] = [await offerFor(staffD), await offerFor(staffP)];
  assert.equal(d.provisional, false);
  assert.equal(o.floor, d.offer);
  assert.equal(o.ceiling, p.offer);
  assert.ok(o.offer < p.offer);
  // Once the store confirms the pick, the full price applies.
  await gradeManual(pick, "Premium", { cookie });
  const confirmed = await offerFor(pick);
  assert.equal(confirmed.provisional, false);
  assert.equal(confirmed.offer, p.offer);
});

await t("an AI provisional range is still risk-shared as before", async () => {
  const id = await newSession("denovo");
  db.prepare("UPDATE sessions SET cosmetic = ?, cosmetic_grade = ? WHERE id = ?").run(
    JSON.stringify({ grade: "B", conclusive: false, gradeRange: { best: "A", worst: "C" }, source: "gemini", tierUsed: "pro" }),
    "B",
    id
  );
  const o = await offerFor(id);
  assert.equal(o.provisional, true);
  assert.deepEqual(o.gradeRange, { best: "A", worst: "C" });
  assert.ok(o.offer > o.floor && o.offer < o.ceiling, `${o.floor} < ${o.offer} < ${o.ceiling}`);
  assert.ok(o.lines.some((l) => /Uncertainty share/.test(l.label)));
});

console.log(`\n${pass} passed${process.exitCode ? ", SOME FAILED" : ""}`);
