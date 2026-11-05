// IMEI lookup: who may spend it, how often it is paid for, and what it says.
//
// /api/imei/[imei] spends Phonecheck calls (station GetDeviceInfo, then GSMA
// CheckEsn) and /api/imei/ocr spends a Gemini call. Both were anonymous and
// uncached, and session create paid for the same lookup twice. These tests pin
// the replacement: a server key or a session to get in, one Phonecheck answer
// per IMEI per 24 h, and an answer that names its real source and model number.
//
// Runs the PRODUCTION route handlers. No network: global fetch is a scripted
// fake that records every Phonecheck path it is asked for.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// db.ts opens <cwd>/data/gradeiq.db. Run from a throwaway directory, so this
// file can never write a session or a cache row into a real database.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "giq-imei-test-")));

let pass = 0;
const t = async (name, fn) => {
  try {
    await fn();
    console.log("  ok  ", name);
    pass++;
  } catch (e) {
    console.log("  FAIL", name, "\n       ", e.message);
    process.exitCode = 1;
  }
};

// Only Cloud DB credentials, exactly like production: no v2 ESN credential, no
// IMEI_API provider, no Gemini — the host's own environment must not add a tier.
for (const k of Object.keys(process.env)) {
  if (/^(PHONECHECK_|IMEI_API_|GEMINI_|GOOGLE_API_KEY|GRADEIQ_SERVER_KEY|GIQ_AUTH_MODE|KEYCLOAK_)/.test(k)) delete process.env[k];
}
process.env.PHONECHECK_API_KEY = "pc-test-key";
process.env.PHONECHECK_USERNAME = "pc-test-user";
const KEY = "giq-server-key-for-tests";

/** Luhn check digit, so every test IMEI is a real-shaped one. */
function imeiFrom(body14) {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    let d = +body14[i];
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return body14 + ((10 - (sum % 10)) % 10);
}

const SAMSUNG = imeiFrom("35124296555113"); // never on a station → GSMA answers
const STATION = imeiFrom("35290611234567"); // a station tested it
const OUTAGE = imeiFrom("35999901234567"); // Phonecheck is down for this one
const NOWHERE = imeiFrom("35888801234567"); // neither the station nor the registry knows it

const GSMA_SAMSUNG = {
  API: "G001",
  RawResponse: {
    marketingname: "Galaxy Z Flip5",
    brandname: "Samsung",
    manufacturer: "Samsung Korea",
    blackliststatus: "No",
    operatingsys: "Android",
    modelname: "SM-F731W",
  },
};
const STATION_ROW = {
  IMEI: STATION,
  Make: "Samsung",
  Model: "Galaxy S23 Ultra",
  ModelNumber: "SM-S918B",
  BatteryHealthPercentage: "91",
  ESNResponse: "Clean",
};

/** Every Phonecheck request, as "<path> <imei>". */
let calls = [];
/** Gemini Settings-OCR requests (kept apart, so `calls` stays Phonecheck only). */
let geminiCalls = 0;
/** What the scripted Gemini reader "sees" on the Settings screen. */
let geminiReads = {};
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.hostname === "generativelanguage.googleapis.com") {
    geminiCalls++;
    const text = JSON.stringify(geminiReads);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  const imei = init.body instanceof URLSearchParams ? init.body.get("imei") : "";
  calls.push(`${u.pathname} ${imei}`);
  if (imei === OUTAGE) return new Response("<html>502 Bad Gateway</html>", { status: 502 });
  let body;
  if (u.pathname.startsWith("/cloud/cloudDB/GetDeviceInfo")) {
    body = imei === STATION ? [STATION_ROW] : { status: 0, msg: "No Data Found" };
  } else if (u.pathname.startsWith("/cloud/cloudDB/CheckEsn")) {
    body = imei === NOWHERE ? { status: 0, msg: "No Data Found" } : GSMA_SAMSUNG;
  } else {
    throw new Error(`unexpected fetch ${u.href}`);
  }
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
};

const lookupRoute = await import("../app/api/imei/[imei]/route.ts");
const ocrRoute = await import("../app/api/imei/ocr/route.ts");
const sessionsRoute = await import("../app/api/sessions/route.ts");
const deviceRoute = await import("../app/api/sessions/[id]/device/route.ts");
const acceptRoute = await import("../app/api/sessions/[id]/accept/route.ts");
const sessionOcrRoute = await import("../app/api/sessions/[id]/ocr/route.ts");
const { resolveImei, IMEI_CACHE_TTL_MS } = await import("./imeiCache.ts");
const { lookupImei } = await import("./imei.ts");
const { isLiveImeiSource } = await import("./imeiSource.ts");
const { db } = await import("./db.ts");

const BASE = "http://localhost:3700";
const lookup = (imei, headers = {}) =>
  lookupRoute.GET(new Request(`${BASE}/api/imei/${imei}`, { headers }), { params: Promise.resolve({ imei }) });
const ocr = (headers = {}, body = { photo: "not-an-image" }) =>
  ocrRoute.POST(
    new Request(`${BASE}/api/imei/ocr`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
  );
// The per-IP daily allowance (lib/lookupBudget.ts) is spent by the anonymous
// channel sessions below; starting each test from zero keeps them independent.
const clearCache = () => {
  db.prepare("DELETE FROM imei_lookups").run();
  db.prepare("DELETE FROM paid_lookups").run();
};

console.log("imei — access");

await t("an anonymous lookup is 401 and spends nothing", async () => {
  process.env.GRADEIQ_SERVER_KEY = KEY;
  calls = [];
  const r = await lookup(SAMSUNG);
  assert.equal(r.status, 401);
  assert.deepEqual(await r.json(), { error: "unauthorized" });
  assert.deepEqual(calls, []);
});

await t("a wrong key is 401", async () => {
  process.env.GRADEIQ_SERVER_KEY = KEY;
  calls = [];
  assert.equal((await lookup(SAMSUNG, { "x-gradeiq-server-key": KEY + "x" })).status, 401);
  assert.equal((await lookup(SAMSUNG, { "x-gradeiq-server-key": "short" })).status, 401);
  assert.deepEqual(calls, []);
});

await t("the server key gets the lookup (200)", async () => {
  process.env.GRADEIQ_SERVER_KEY = KEY;
  clearCache();
  const r = await lookup(SAMSUNG, { "x-gradeiq-server-key": KEY });
  assert.equal(r.status, 200);
  const info = await r.json();
  assert.equal(info.imei, SAMSUNG);
  assert.equal(info.model, "Galaxy Z Flip5");
});

await t("no key configured = server-key auth OFF: the header alone is 401", async () => {
  delete process.env.GRADEIQ_SERVER_KEY;
  assert.equal((await lookup(SAMSUNG, { "x-gradeiq-server-key": "" })).status, 401);
  assert.equal((await lookup(SAMSUNG, { "x-gradeiq-server-key": KEY })).status, 401);
  process.env.GRADEIQ_SERVER_KEY = KEY;
});

await t("a seller page's same-origin fetch never opens the PAID lookup", async () => {
  calls = [];
  assert.equal((await lookup(SAMSUNG, { "sec-fetch-site": "same-origin" })).status, 401);
  assert.deepEqual(calls, []);
});

await t("anonymous OCR is 401 (no headers, or cross-site)", async () => {
  assert.equal((await ocr()).status, 401);
  assert.equal((await ocr({ "sec-fetch-site": "cross-site" })).status, 401);
  assert.equal((await ocr({ "sec-fetch-site": "same-site" })).status, 401);
  assert.equal((await ocr({ origin: "https://evil.example", host: "localhost:3700" })).status, 401);
  const body = await (await ocr()).json();
  assert.equal(body.error, "unauthorized");
});

await t("OCR answers GradeIQ's own seller pages (same-origin) and the server key", async () => {
  // A non-image body stops before Gemini, so a pass shows as bad_image, not 401.
  for (const h of [
    { "sec-fetch-site": "same-origin" },
    { origin: "http://localhost:3700", host: "localhost:3700" }, // iOS < 16.4: no Sec-Fetch-Site
    { origin: "https://swapmore.com", host: "localhost:3700", "x-forwarded-host": "swapmore.com" }, // behind Caddy
    { "x-gradeiq-server-key": KEY },
  ]) {
    const r = await ocr(h);
    assert.equal(r.status, 200, JSON.stringify(h));
    assert.equal((await r.json()).error, "bad_image");
  }
});

console.log("imei — the 24 h cache");

await t("a second lookup of the same IMEI makes ZERO Phonecheck calls", async () => {
  clearCache();
  calls = [];
  const a = await (await lookup(SAMSUNG, { "x-gradeiq-server-key": KEY })).json();
  assert.deepEqual(calls, [`/cloud/cloudDB/GetDeviceInfo ${SAMSUNG}`, `/cloud/cloudDB/CheckEsn/ ${SAMSUNG}`]);
  calls = [];
  const b = await (await lookup(SAMSUNG, { "x-gradeiq-server-key": KEY })).json();
  assert.deepEqual(calls, []);
  assert.deepEqual(b, a);
});

await t("the GSMA registry is asked once, not twice, when nobody knows the IMEI", async () => {
  // lookupImei used to follow getPhonecheck's own (empty) CheckEsn with a
  // second, identical one.
  clearCache();
  calls = [];
  const r = await resolveImei(NOWHERE);
  assert.deepEqual(calls, [`/cloud/cloudDB/GetDeviceInfo ${NOWHERE}`, `/cloud/cloudDB/CheckEsn/ ${NOWHERE}`]);
  assert.equal(r.phonecheck.source, "not_found");
  assert.equal(r.info.blacklist, "unknown"); // nobody answered — never "clean"
});

await t("a paid 'not found' is cached too — asking again changes nothing for a day", async () => {
  calls = [];
  const r = await resolveImei(NOWHERE);
  assert.equal(r.cached, true);
  assert.deepEqual(calls, []);
});

await t("after 24 h the IMEI is looked up again (a new lost/stolen report must land)", async () => {
  clearCache();
  const now = Date.now();
  await resolveImei(SAMSUNG, now);
  calls = [];
  const fresh = await resolveImei(SAMSUNG, now + IMEI_CACHE_TTL_MS - 1000);
  assert.equal(fresh.cached, true);
  assert.deepEqual(calls, []);
  const stale = await resolveImei(SAMSUNG, now + IMEI_CACHE_TTL_MS + 1000);
  assert.equal(stale.cached, false);
  assert.equal(calls.length, 2);
});

await t("a Phonecheck outage is not cached — the next ask retries", async () => {
  clearCache();
  calls = [];
  const a = await resolveImei(OUTAGE);
  assert.equal(a.phonecheck?.source, "error");
  assert.equal(a.info.blacklist, "unknown");
  const n = calls.length;
  assert.ok(n > 0);
  await resolveImei(OUTAGE);
  assert.equal(calls.length, n * 2, "the second ask must call Phonecheck again");
});

console.log("imei — what the answer says");

await t("GSMA answer: model number kept, source 'gsma', blacklist from the registry", async () => {
  clearCache();
  const { info } = await resolveImei(SAMSUNG);
  assert.equal(info.brand, "Samsung");
  assert.equal(info.model, "Galaxy Z Flip5");
  assert.equal(info.modelNumber, "SM-F731W");
  assert.equal(info.source, "gsma");
  assert.equal(info.blacklist, "clean");
  assert.equal(info.lock, "unknown"); // the registry carries no SIM lock
});

await t("station answer: source 'station', its own model number, ONE call (blacklist already known)", async () => {
  clearCache();
  calls = [];
  const { info, phonecheck } = await resolveImei(STATION);
  assert.equal(info.source, "station");
  assert.equal(info.model, "Galaxy S23 Ultra");
  assert.equal(info.modelNumber, "SM-S918B");
  assert.equal(info.blacklist, "clean");
  assert.equal(phonecheck.batteryHealth, 91);
  assert.deepEqual(calls, [`/cloud/cloudDB/GetDeviceInfo ${STATION}`]);
});

await t("no Phonecheck credentials: the free TAC/stub answer, honestly labelled, nothing cached", async () => {
  clearCache();
  delete process.env.PHONECHECK_API_KEY;
  try {
    calls = [];
    const r = await resolveImei(SAMSUNG);
    assert.deepEqual(calls, []);
    assert.ok(r.info.source === "tac" || r.info.source === "stub", r.info.source);
    assert.equal(r.info.modelNumber, null);
    assert.equal(r.info.blacklist, "unknown");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM imei_lookups").get().n, 0);
  } finally {
    process.env.PHONECHECK_API_KEY = "pc-test-key";
  }
});

await t("lookupImei handed a report never calls Phonecheck itself", async () => {
  calls = [];
  const pc = (await import("./phonecheck.ts")).parseGsmaResponse(GSMA_SAMSUNG, SAMSUNG);
  const info = await lookupImei(SAMSUNG, { phonecheck: pc });
  assert.deepEqual(calls, []);
  assert.equal(info.modelNumber, "SM-F731W");
});

await t("live sources read as live (legacy 'api' rows too); TAC and stub never do", () => {
  for (const s of ["esn", "station", "gsma", "provider", "api"]) assert.equal(isLiveImeiSource(s), true, s);
  for (const s of ["tac", "stub", "", undefined, null]) assert.equal(isLiveImeiSource(s), false, String(s));
});

console.log("imei — sessions");

// Sessions below come from a KNOWN channel — SwapMore's consumer embed
// (?client=swapmore) — the anonymous caller that may spend a paid lookup within
// its per-IP daily allowance. Who else may is pinned in lib/lookupBudget.test.mjs.
const EMBED = { client: "swapmore" };

const createSession = async (body) =>
  (await sessionsRoute.POST(
    new Request(`${BASE}/api/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  )).json();

await t("session create pays for ONE Phonecheck answer, not lookup + report side by side", async () => {
  clearCache();
  calls = [];
  const s = await createSession({ imei: SAMSUNG, segment: "c2b", ...EMBED });
  // Before: lookupImei (GetDeviceInfo + CheckEsn) AND getPhonecheck
  // (GetDeviceInfo + CheckEsn) side by side — four calls for one IMEI.
  assert.deepEqual(calls, [`/cloud/cloudDB/GetDeviceInfo ${SAMSUNG}`, `/cloud/cloudDB/CheckEsn/ ${SAMSUNG}`]);
  assert.equal(s.imeiInfo.model, "Galaxy Z Flip5");
  assert.equal(s.imeiInfo.modelNumber, "SM-F731W");
  assert.equal(s.phonecheck.source, "gsma");
  assert.equal(s.model, "Galaxy Z Flip5");
});

await t("a session for an IMEI resolved in the last 24 h makes no Phonecheck call", async () => {
  clearCache();
  await (await lookup(SAMSUNG, { "x-gradeiq-server-key": KEY })).json(); // SwapUp's resolve
  calls = [];
  const s = await createSession({ imei: SAMSUNG, segment: "c2b", ...EMBED });
  assert.deepEqual(calls, []);
  assert.equal(s.imeiInfo.modelNumber, "SM-F731W");
});

const postDevice = (id, body) =>
  deviceRoute.POST(
    new Request(`${BASE}/api/sessions/${id}/device`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id }) }
  );

await t("/device gives an IMEI-less session its IMEI — and runs no lookup", async () => {
  const s = await createSession({ segment: "c2b" });
  assert.equal(s.imei, "");
  calls = [];
  const r = await (await postDevice(s.id, { device: { source: "swapup-check", imei: SAMSUNG } })).json();
  assert.equal(r.session.imei, SAMSUNG);
  assert.equal(r.session.device.imei, SAMSUNG);
  assert.deepEqual(calls, []);
});

await t("/device never replaces an IMEI the session already has", async () => {
  const s = await createSession({ segment: "c2b" });
  await postDevice(s.id, { device: { imei: SAMSUNG } });
  const r = await (await postDevice(s.id, { device: { imei: STATION } })).json();
  assert.equal(r.session.imei, SAMSUNG);
});

await t("/device ignores an IMEI that fails Luhn (a typo can't become the anchor)", async () => {
  const s = await createSession({ segment: "c2b" });
  const bad = SAMSUNG.slice(0, 14) + ((+SAMSUNG[14] + 1) % 10);
  const r = await (await postDevice(s.id, { device: { imei: bad } })).json();
  assert.equal(r.session.imei, "");
});

console.log("imei — session routes answer from the 24 h cache");

// /accept is anonymous (a session id is all it takes, and the id is in the
// customer's camera URL), and /ocr is the Settings photo in the camera pass.
// Both used to call Phonecheck directly, so every press or retake paid again.

const accept = (id) =>
  acceptRoute.POST(new Request(`${BASE}/api/sessions/${id}/accept`, { method: "POST" }), {
    params: Promise.resolve({ id }),
  });
const sessionOcr = (id, frames = ["data:image/jpeg;base64,/9j/AAAA"]) =>
  sessionOcrRoute.POST(
    new Request(`${BASE}/api/sessions/${id}/ocr`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ frames }),
    }),
    { params: Promise.resolve({ id }) }
  );
/** A session that got its IMEI from SwapUp's /device forward (no lookup made). */
const sessionViaDevice = async (imei) => {
  const s = await createSession({ segment: "c2b", client: "swapmore", channel: "retail" });
  await postDevice(s.id, { device: { source: "swapup-check", imei } });
  return s.id;
};

await t("three /accept presses pay for ONE lookup at most (an IMEI never seen before)", async () => {
  const id = await sessionViaDevice(SAMSUNG);
  clearCache();
  calls = [];
  const results = [];
  for (let i = 0; i < 3; i++) results.push(await (await accept(id)).json());
  // Before: getPhonecheck on every press — GetDeviceInfo + CheckEsn three times.
  assert.deepEqual(calls, [`/cloud/cloudDB/GetDeviceInfo ${SAMSUNG}`, `/cloud/cloudDB/CheckEsn/ ${SAMSUNG}`]);
  for (const r of results) assert.equal(r.ok, true);
  assert.deepEqual(results[2].verification.checks, results[0].verification.checks);
  // The gate still reads the registry's answer, now from the cache.
  const blacklist = results[0].verification.checks.find((c) => /blacklisted/.test(c.label));
  assert.equal(blacklist.ok, true);
});

await t("/accept on an IMEI resolved in the last 24 h makes ZERO Phonecheck calls", async () => {
  clearCache();
  await (await lookup(SAMSUNG, { "x-gradeiq-server-key": KEY })).json(); // SwapUp's call A
  const id = await sessionViaDevice(SAMSUNG);
  calls = [];
  for (let i = 0; i < 3; i++) assert.equal((await accept(id)).status, 200);
  assert.deepEqual(calls, []);
});

await t("/accept on a session created with its IMEI (cached at create) makes ZERO calls", async () => {
  clearCache();
  const s = await createSession({ imei: SAMSUNG, segment: "c2b", ...EMBED });
  calls = [];
  for (let i = 0; i < 3; i++) await accept(s.id);
  assert.deepEqual(calls, []);
});

await t("lookup via /api/imei, then session /ocr reads that IMEI: ZERO further Phonecheck calls", async () => {
  process.env.GEMINI_API_KEY = "gemini-test-key";
  try {
    clearCache();
    await (await lookup(SAMSUNG, { "x-gradeiq-server-key": KEY })).json(); // SwapUp's call A
    const s = await createSession({ segment: "c2b", ...EMBED });
    geminiReads = { imei: SAMSUNG, model: "Galaxy Z Flip5" };
    geminiCalls = 0;
    calls = [];
    const r = await (await sessionOcr(s.id)).json();
    assert.equal(geminiCalls, 1, "the OCR reader itself still runs");
    assert.equal(r.ocr.imei, SAMSUNG);
    assert.deepEqual(calls, []);
    assert.equal(r.session.imei, SAMSUNG);
    assert.equal(r.session.imei_info.modelNumber, "SM-F731W"); // the cached answer, not a guess
    assert.equal(r.session.imei_info.source, "gsma");
  } finally {
    delete process.env.GEMINI_API_KEY;
  }
});

await t("a Settings retake pays for the OCR'd IMEI once, not once per submission", async () => {
  process.env.GEMINI_API_KEY = "gemini-test-key";
  try {
    clearCache();
    const s = await createSession({ segment: "c2b", ...EMBED });
    geminiReads = { imei: SAMSUNG };
    calls = [];
    await sessionOcr(s.id);
    await sessionOcr(s.id);
    assert.deepEqual(calls, [`/cloud/cloudDB/GetDeviceInfo ${SAMSUNG}`, `/cloud/cloudDB/CheckEsn/ ${SAMSUNG}`]);
  } finally {
    delete process.env.GEMINI_API_KEY;
  }
});

console.log(pass + " assertions passed\n");
