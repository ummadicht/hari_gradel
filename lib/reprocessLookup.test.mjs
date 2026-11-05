// A staff re-grade pays for AT MOST ONE IMEI lookup, through the 24 h cache.
//
// POST /api/sessions/[id]/reprocess refreshed identity with lookupImei — which
// itself calls getPhonecheck — and then called getPhonecheck again: two paid
// Phonecheck lookups per re-grade for the same answer, straight past the 24 h
// cache and the daily limits. These tests pin the replacement — at most ONE
// paid call per re-grade:
//   • one lookup (station database, then the registry) for an IMEI nobody
//     resolved today, counted under the staff caller;
//   • none at all within 24 h when the cached answer is a station record;
//   • when the cached answer is the registry's (SwapUp's call A is made before
//     the phone goes on a station), ONE GetDeviceInfo — never the registry
//     again — so a station test done after call A reaches the report;
//   • what is written back never downgrades: a registry answer, an outage or a
//     partial outage never replaces a station record already stored — but a
//     fresher BLACKLISTED is always kept.
//
// Runs the PRODUCTION route handler as a signed-in operator. No network: global
// fetch is a scripted fake that records every Phonecheck path it is asked for.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

// db.ts opens <cwd>/data/gradeiq.db — never a real database.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "giq-reprocess-lookup-")));
for (const k of Object.keys(process.env)) {
  if (/^(GEMINI_|GOOGLE_API_KEY|OPENAI_|MOONSHOT_|KIMI_|VISION_|PRO_ONLY|GRADEIQ_|GIQ_AUTH_MODE|KEYCLOAK_|PORTAL_PW_|ENT_|PHONECHECK_|IMEI_API_|NEXT_PUBLIC_BASE_PATH|PUBLIC_ORIGIN)/.test(k)) delete process.env[k];
}
if (process.env.NODE_ENV === "development") delete process.env.NODE_ENV;
process.env.GIQ_AUTH_MODE = "legacy";
process.env.GEMINI_API_KEY = "test-key";
const ADMIN_PW = `t-${Math.random().toString(36).slice(2)}`;
process.env.PORTAL_PW_ADMIN = ADMIN_PW;
// Cloud DB credentials only, exactly like production (no v2 ESN, no provider).
process.env.PHONECHECK_API_KEY = "pc-test-key";
process.env.PHONECHECK_USERNAME = "pc-test-user";

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

const SAMSUNG = imeiFrom("35124296555113"); // never on a station → the GSMA registry answers
const STATION = imeiFrom("35290611234567"); // a Phonecheck station tested it
const OUTAGE = imeiFrom("35999901234567"); // Phonecheck is down for this one
const LATER = imeiFrom("35124296777001"); // call A first, the station test after it
const LATER_NO_ESN = imeiFrom("35124296777003"); // the same, and the station record carries no ESN
const HELD = imeiFrom("35124296777002"); // the session already holds a station record
const PARTIAL = imeiFrom("35124296777004"); // GetDeviceInfo down, CheckEsn up
const NOW_STOLEN = imeiFrom("35124296777005"); // a station record on the session, then reported stolen

/** IMEIs a Phonecheck station has tested — GetDeviceInfo returns a record for these. */
const stationTested = new Set([STATION]);
/** Per IMEI: the registry's lost/stolen answer ("No" = clean, "Yes" = blacklisted). */
const registryStatus = {};
/** Per IMEI: which endpoint is down. */
const down = { [OUTAGE]: "both", [PARTIAL]: "station" };

const gsmaBody = (blackliststatus) => ({
  API: "G001",
  RawResponse: {
    marketingname: "Galaxy Z Flip5",
    brandname: "Samsung",
    manufacturer: "Samsung Korea",
    blackliststatus,
    operatingsys: "Android",
    modelname: "SM-F731W",
  },
});
const stationRow = (imei, over = {}) => ({
  IMEI: imei,
  Make: "Samsung",
  Model: "Galaxy S23 Ultra",
  ModelNumber: "SM-S918B",
  BatteryHealthPercentage: "91",
  BatteryCycle: "300",
  DeviceLock: "Off",
  UnlockStatus: "Unlocked",
  ESNResponse: "Clean",
  ...over,
});
/** Per IMEI: overrides for its station row. */
const stationOver = {};

/** Every Phonecheck request, as "<path> <imei>". */
let calls = [];
let visionCalls = 0;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.hostname === "generativelanguage.googleapis.com") {
    visionCalls++;
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ components: {} }) }] } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
  const imei = init.body instanceof URLSearchParams ? init.body.get("imei") : "";
  calls.push(`${u.pathname} ${imei}`);
  const isStation = u.pathname.startsWith("/cloud/cloudDB/GetDeviceInfo");
  if (down[imei] === "both" || (down[imei] === "station" && isStation))
    return new Response("<html>502 Bad Gateway</html>", { status: 502 });
  let body;
  if (isStation) {
    body = stationTested.has(imei) ? [stationRow(imei, stationOver[imei])] : { status: 0, msg: "No Data Found" };
  } else if (u.pathname.startsWith("/cloud/cloudDB/CheckEsn")) {
    body = gsmaBody(registryStatus[imei] ?? "No");
  } else {
    throw new Error(`unexpected fetch ${u.href}`);
  }
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
};

globalThis.AsyncLocalStorage ??= (await import("node:async_hooks")).AsyncLocalStorage;
const require = createRequire(import.meta.url);
const { workAsyncStorage } = require("next/dist/server/app-render/work-async-storage.external.js");
const { workUnitAsyncStorage } = require("next/dist/server/app-render/work-unit-async-storage.external.js");
const { RequestCookies } = require("next/dist/server/web/spec-extension/cookies.js");
const { NextRequest } = await import("next/server.js");

const { buildPassport } = await import("./passport.ts");
const { parseGsmaResponse, parsePcReport } = await import("./phonecheck.ts");
const { imeiInfoFromReport } = await import("./imei.ts");
const { resolveImei, storedLookup } = await import("./imeiCache.ts");
const { db, getSession } = await import("./db.ts");
const { checkLogin } = await import("./portalAuth.ts");
const reprocessRoute = await import("../app/api/sessions/[id]/reprocess/route.ts");

const BASE = "http://localhost:3700";

function seedSession(id, cols = {}) {
  const c = {
    imei: "",
    model: "Galaxy Z Flip5",
    imei_info: {},
    phonecheck: {},
    ocr: {},
    device: {},
    overall_grade: "",
    cosmetic_grade: "",
    photos: [],
    ...cols,
  };
  db.prepare(
    `INSERT INTO sessions (id, client_id, imei, model, status, imei_info, phonecheck, ocr, device, overall_grade, cosmetic_grade, cosmetic, photos)
     VALUES (?, 'swapup', ?, ?, 'open', ?, ?, ?, ?, ?, ?, '{}', ?)`
  ).run(
    id,
    c.imei,
    c.model,
    JSON.stringify(c.imei_info),
    JSON.stringify(c.phonecheck),
    JSON.stringify(c.ocr),
    JSON.stringify(c.device),
    c.overall_grade,
    c.cosmetic_grade,
    JSON.stringify(c.photos)
  );
  return getSession(id);
}
/** A lookup-table row, as resolveImei writes it. */
const clearCache = () => {
  db.prepare("DELETE FROM imei_lookups").run();
  db.prepare("DELETE FROM paid_lookups").run();
};
const row = (p, key) => p.diagnostics.rows.find((r) => r.key === key);
const gsmaReport = (imei, status = "No") => parseGsmaResponse(gsmaBody(status), imei);
const stationReport = (imei, over = {}) => parsePcReport(stationRow(imei, over), imei);
const GDI = (imei) => `/cloud/cloudDB/GetDeviceInfo ${imei}`;
const ESN = (imei) => `/cloud/cloudDB/CheckEsn/ ${imei}`;
const paidRows = () => db.prepare("SELECT caller, outcome, n FROM paid_lookups").all().map((x) => [x.caller, x.outcome, x.n]);

console.log("re-grade — one lookup, through the cache");

// A real (tiny) photo on disk, so the staff re-grade has something to read.
const sharp = (await import("sharp")).default;
fs.mkdirSync(path.join(process.cwd(), "data", "uploads"), { recursive: true });
const jpeg = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 90, g: 90, b: 90 } } }).jpeg().toBuffer();
fs.writeFileSync(path.join(process.cwd(), "data", "uploads", "rp-1.jpg"), jpeg);

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
const seedRegrade = (id, imei, cols = {}) => seedSession(id, { imei, photos: ["/api/uploads/rp-1.jpg"], ...cols });
async function regrade(id) {
  const r = await inRequest(adminCookie(), () =>
    reprocessRoute.POST(
      new NextRequest(`${BASE}/api/sessions/${id}/reprocess`, { method: "POST", body: JSON.stringify({ tier: "flash" }) }),
      { params: Promise.resolve({ id }) }
    )
  );
  const body = await r.json();
  assert.equal(r.status, 200, JSON.stringify(body));
  return body;
}

await t("a re-grade pays for ONE lookup (station DB, then registry) — not lookupImei + getPhonecheck", async () => {
  clearCache();
  seedRegrade("rp-gsma", SAMSUNG);
  calls = [];
  const body = await regrade("rp-gsma");
  // Before: lookupImei (GetDeviceInfo + CheckEsn) then getPhonecheck (the same
  // two again) — four calls, straight past the cache and the daily limits.
  assert.deepEqual(calls, [`/cloud/cloudDB/GetDeviceInfo ${SAMSUNG}`, `/cloud/cloudDB/CheckEsn/ ${SAMSUNG}`]);
  assert.ok(visionCalls > 0, "the re-grade itself ran");
  assert.equal(body.lookup.cached, false);
  assert.ok(body.refreshed.includes("identity") && body.refreshed.includes("diagnostics"));
  const s = getSession("rp-gsma");
  assert.equal(s.imei_info.source, "gsma");
  assert.equal(s.phonecheck.source, "gsma");
  // …and it went through the cache: the answer is in the table now.
  assert.equal(storedLookup(SAMSUNG).phonecheck.source, "gsma");
  // Counted under the staff caller, like every other paid lookup.
  const paid = db.prepare("SELECT caller, outcome, n FROM paid_lookups").all();
  assert.deepEqual(paid.map((x) => [x.caller, x.outcome, x.n]), [["staff", "paid", 1]]);
});

await t("a second re-grade within 24 h never pays the registry again — one station re-check only", async () => {
  calls = [];
  const body = await regrade("rp-gsma");
  // The cached answer is the registry's: the station database is asked again
  // (the phone may have been station-tested since), the registry is not.
  assert.deepEqual(calls, [GDI(SAMSUNG)]);
  assert.equal(body.lookup.cached, true);
  assert.equal(body.lookup.station, "none");
  assert.deepEqual(paidRows(), [["staff", "paid", 2]]);
  const s = getSession("rp-gsma");
  assert.equal(s.phonecheck.source, "gsma");
  // …and the report says WHEN that station check found nothing.
  const p = buildPassport(s);
  assert.equal(row(p, "batteryHealth").note, "No Phonecheck station record when GradeIQ looked up this IMEI");
  assert.ok(row(p, "batteryHealth").checkedAt, "with the time of the re-check");
  assert.equal(row(p, "batteryHealth").timeLabel, "looked up");
});

await t("a cached STATION record: a re-grade makes ZERO calls", async () => {
  clearCache();
  seedRegrade("rp-station-twice", STATION);
  await regrade("rp-station-twice");
  calls = [];
  const body = await regrade("rp-station-twice");
  assert.deepEqual(calls, []);
  assert.equal(body.lookup.cached, true);
  assert.equal(body.lookup.station, null);
});

await t("SwapUp's call A, THEN a station test, then a re-grade: one GetDeviceInfo and the station record reaches the report", async () => {
  clearCache();
  await resolveImei(LATER, Date.now(), { caller: "server", ip: "" }); // call A: not on a station yet
  seedRegrade("rp-later", LATER);
  const before = buildPassport(getSession("rp-later"));
  assert.equal(row(before, "blacklist").value, "Clean", "the report reads the table even before any re-grade");
  assert.equal(row(before, "batteryHealth").value, null);
  stationTested.add(LATER); // the store tests the phone on a Phonecheck station
  calls = [];
  const body = await regrade("rp-later");
  assert.deepEqual(calls, [GDI(LATER)], "one station call, no second registry call");
  assert.equal(body.lookup.station, "found");
  const s = getSession("rp-later");
  assert.equal(s.phonecheck.source, "api");
  assert.equal(s.imei_info.source, "station");
  const p = buildPassport(s);
  assert.equal(row(p, "batteryHealth").value, "91%");
  assert.equal(row(p, "batteryHealth").source, "Phonecheck station");
  assert.equal(row(p, "batteryCycles").value, "300");
  assert.equal(row(p, "fmip").value, "Off");
  assert.equal(row(p, "carrierLock").value, "Unlocked");
  // The table now holds the station record: the next re-grade pays nothing.
  assert.equal(storedLookup(LATER).phonecheck.source, "api");
  calls = [];
  await regrade("rp-later");
  assert.deepEqual(calls, []);
});

await t("a station record with no lost/stolen status takes the CACHED registry answer — not a second registry call", async () => {
  clearCache();
  await resolveImei(LATER_NO_ESN, Date.now(), { caller: "server", ip: "" }); // call A
  seedRegrade("rp-later-noesn", LATER_NO_ESN);
  stationTested.add(LATER_NO_ESN);
  stationOver[LATER_NO_ESN] = { ESNResponse: undefined };
  calls = [];
  await regrade("rp-later-noesn");
  assert.deepEqual(calls, [GDI(LATER_NO_ESN)]);
  const p = buildPassport(getSession("rp-later-noesn"));
  assert.equal(row(p, "blacklist").value, "Clean");
  assert.equal(row(p, "blacklist").source, "GSMA registry via Phonecheck");
  assert.equal(row(p, "batteryHealth").value, "91%");
});

await t("a cached registry answer never overwrites a station record the session already holds", async () => {
  clearCache();
  const st = stationReport(HELD, { BatteryHealthPercentage: "84" });
  seedRegrade("rp-held", HELD, { phonecheck: st, imei_info: imeiInfoFromReport(HELD, st) });
  await resolveImei(HELD, Date.now(), { caller: "server", ip: "" }); // the table: the registry's answer
  assert.equal(storedLookup(HELD).phonecheck.source, "gsma");
  calls = [];
  const body = await regrade("rp-held");
  assert.deepEqual(calls, [GDI(HELD)]);
  assert.ok(!body.refreshed.includes("diagnostics"));
  assert.ok(!body.refreshed.includes("identity"));
  const s = getSession("rp-held");
  assert.equal(s.phonecheck.source, "api");
  assert.equal(s.imei_info.source, "station");
  const p = buildPassport(s);
  assert.equal(row(p, "batteryHealth").value, "84%");
  assert.equal(row(p, "fmip").value, "Off");
  assert.equal(row(p, "carrierLock").value, "Unlocked");
});

await t("…but a fresher BLACKLISTED is kept on it, credited to the registry, and blocks the offer", async () => {
  clearCache();
  const st = stationReport(NOW_STOLEN);
  seedRegrade("rp-stolen", NOW_STOLEN, { phonecheck: st, imei_info: imeiInfoFromReport(NOW_STOLEN, st) });
  registryStatus[NOW_STOLEN] = "Yes"; // reported stolen since the station test
  await resolveImei(NOW_STOLEN, Date.now(), { caller: "server", ip: "" }); // the table: the registry's "Yes"
  calls = [];
  await regrade("rp-stolen");
  const s = getSession("rp-stolen");
  assert.equal(s.phonecheck.source, "api", "the station record is kept");
  assert.equal(s.phonecheck.blacklist, "blacklisted");
  assert.equal(s.phonecheck.batteryHealth, 91);
  const p = buildPassport(s);
  assert.equal(row(p, "blacklist").value, "Blacklisted");
  assert.equal(row(p, "blacklist").source, "GSMA registry via Phonecheck");
  assert.equal(s.offer.blocked, true);
});

await t("a partial outage (GetDeviceInfo down, CheckEsn up) never replaces a stored station record", async () => {
  clearCache();
  const st = stationReport(PARTIAL);
  seedRegrade("rp-partial", PARTIAL, { phonecheck: st, imei_info: imeiInfoFromReport(PARTIAL, st) });
  calls = [];
  await regrade("rp-partial");
  assert.deepEqual(calls, [GDI(PARTIAL), ESN(PARTIAL)], "one lookup");
  const s = getSession("rp-partial");
  assert.equal(s.phonecheck.source, "api");
  assert.equal(s.imei_info.source, "station");
  const p = buildPassport(s);
  assert.equal(row(p, "batteryHealth").value, "91%");
  assert.equal(row(p, "batteryHealth").source, "Phonecheck station");
});

await t("a station IMEI: one call, and the station record reaches the report", async () => {
  clearCache();
  seedRegrade("rp-station", STATION);
  calls = [];
  await regrade("rp-station");
  // The station record already carries lost/stolen — the registry is not asked.
  assert.deepEqual(calls, [GDI(STATION)]);
  const s = getSession("rp-station");
  assert.equal(s.phonecheck.source, "api");
  assert.equal(row(buildPassport(s), "batteryHealth").value, "91%");
});

await t("a Phonecheck outage during a re-grade never overwrites the real answer already stored", async () => {
  clearCache();
  const pc = gsmaReport(OUTAGE);
  seedRegrade("rp-outage", OUTAGE, { imei_info: imeiInfoFromReport(OUTAGE, pc), phonecheck: pc });
  calls = [];
  const body = await regrade("rp-outage");
  assert.equal(calls.length, 2, "one lookup (both endpoints fail)");
  assert.ok(!body.refreshed.includes("identity"));
  assert.ok(!body.refreshed.includes("diagnostics"));
  const s = getSession("rp-outage");
  assert.equal(s.imei_info.source, "gsma");
  assert.equal(s.phonecheck.source, "gsma");
  assert.equal(row(buildPassport(s), "blacklist").value, "Clean");
  // An outage is not an answer: nothing is cached, the next re-grade asks again.
  assert.equal(storedLookup(OUTAGE), null);
});

console.log(pass + " assertions passed\n");
