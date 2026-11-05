// SUP-72 — anonymous callers may not run up the paid IMEI lookup bill.
//
// A session is created with nothing but a POST, and every new IMEI on it used
// to spend Phonecheck calls. These tests pin lib/lookupBudget.ts THROUGH THE
// PRODUCTION ROUTE HANDLERS:
//   • SwapUp's server key, CounterIQ's retail key and staff always get the
//     lookup — CounterIQ's desks all reach us from one address, so 25 retail
//     creates from one IP must all be paid;
//   • an anonymous caller from a known channel (a tenant's embed, a keyless
//     retail desk) gets GRADEIQ_ANON_LOOKUP_CAP per address per day, and all
//     of them together GRADEIQ_ANON_LOOKUP_TOTAL_CAP per day; past either the
//     session is created WITHOUT a lookup, identity unverified;
//   • anyone else gets the free TAC answer only;
//   • a cached IMEI is free for everyone, and the session routes (/accept,
//     /offer, /ocr) cannot buy the lookup the create was refused;
//   • journey start makes ONE cached lookup, not two uncached ones;
//   • the day's count reaches staff through GET /api/settings.
//
// No network: global fetch is a scripted Phonecheck that records every call.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

// db.ts opens <cwd>/data/gradeiq.db — never a real database.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "giq-lookup-budget-")));
for (const k of Object.keys(process.env)) {
  if (/^(PHONECHECK_|IMEI_API_|GEMINI_|GOOGLE_API_KEY|GRADEIQ_|GIQ_AUTH_MODE|KEYCLOAK_|PORTAL_PW_|ENT_)/.test(k)) delete process.env[k];
}
if (process.env.NODE_ENV === "development") delete process.env.NODE_ENV;
process.env.PHONECHECK_API_KEY = "pc-test-key";
process.env.PHONECHECK_USERNAME = "pc-test-user";
process.env.GRADEIQ_ANON_LOOKUP_CAP = "3";
process.env.GIQ_AUTH_MODE = "legacy";
const KEY = `giq-server-key-${Math.random().toString(36).slice(2)}`;
process.env.GRADEIQ_SERVER_KEY = KEY;
const RKEY = `giq-retail-key-${Math.random().toString(36).slice(2)}`;
process.env.GRADEIQ_RETAIL_KEY = RKEY;
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
let seq = 0;
/** A fresh IMEI nobody has looked up yet (same Samsung TAC every time). */
const freshImei = () => imeiFrom(`351242965${String(10000 + seq++).slice(-5)}`);

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

/** Every Phonecheck request, as "<path> <imei>". */
let calls = [];
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const imei = init.body instanceof URLSearchParams ? init.body.get("imei") : "";
  calls.push(`${u.pathname} ${imei}`);
  let body;
  if (u.pathname.startsWith("/cloud/cloudDB/GetDeviceInfo")) body = { status: 0, msg: "No Data Found" };
  else if (u.pathname.startsWith("/cloud/cloudDB/CheckEsn")) body = GSMA_SAMSUNG;
  else throw new Error(`unexpected fetch ${u.href}`);
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
};
/** The distinct IMEIs Phonecheck was asked about since the last reset. */
const imeisAsked = () => [...new Set(calls.map((c) => c.split(" ")[1]))];

// Next's server runtime installs this global before any request store exists.
globalThis.AsyncLocalStorage ??= (await import("node:async_hooks")).AsyncLocalStorage;
const require = createRequire(import.meta.url);
const { workAsyncStorage } = require("next/dist/server/app-render/work-async-storage.external.js");
const { workUnitAsyncStorage } = require("next/dist/server/app-render/work-unit-async-storage.external.js");
const { RequestCookies } = require("next/dist/server/web/spec-extension/cookies.js");

const sessionsRoute = await import("../app/api/sessions/route.ts");
const sessionRoute = await import("../app/api/sessions/[id]/route.ts");
const acceptRoute = await import("../app/api/sessions/[id]/accept/route.ts");
const offerRoute = await import("../app/api/sessions/[id]/offer/route.ts");
const lookupRoute = await import("../app/api/imei/[imei]/route.ts");
const journeyRoute = await import("../app/api/journeys/[journey]/start/route.ts");
const settingsRoute = await import("../app/api/settings/route.ts");
const { db } = await import("./db.ts");
const { eventsFor } = await import("./events.ts");
const { checkLogin } = await import("./portalAuth.ts");
const budget = await import("./lookupBudget.ts");
const { resolveImei } = await import("./imeiCache.ts");

const BASE = "http://localhost:3700";

/** Run a handler the way Next does: inside a request scope with this cookie header. */
function inRequest(cookie, fn) {
  const cookies = new RequestCookies(new Headers(cookie ? { cookie } : {}));
  return workAsyncStorage.run({ route: "/api/test", forceStatic: false, dynamicShouldError: false }, () =>
    workUnitAsyncStorage.run({ type: "request", phase: "render", cookies }, fn)
  );
}
const staffCookie = () => {
  const hit = checkLogin("admin", ADMIN_PW);
  assert.ok(hit, "legacy staff sign-in");
  return `giq_portal=${hit.token}`;
};

/** POST /api/sessions as a browser at `ip` (the first X-Forwarded-For entry Caddy sets). */
async function create(body, { ip = "198.51.100.7", headers = {}, cookie = "" } = {}) {
  const r = await inRequest(cookie, () =>
    sessionsRoute.POST(
      new Request(`${BASE}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": ip, ...headers },
        body: JSON.stringify({ segment: "c2b", ...body }),
      })
    )
  );
  assert.equal(r.status, 200);
  return r.json();
}
const getSessionApi = async (id) =>
  (await inRequest("", () => sessionRoute.GET(new Request(`${BASE}/api/sessions/${id}`), { params: Promise.resolve({ id }) }))).json();
const sessionPost = (route, id, sub, ip) =>
  inRequest("", () =>
    route.POST(new Request(`${BASE}/api/sessions/${id}/${sub}`, { method: "POST", headers: { "x-forwarded-for": ip } }), {
      params: Promise.resolve({ id }),
    })
  );

function reset() {
  db.prepare("DELETE FROM imei_lookups").run();
  db.prepare("DELETE FROM paid_lookups").run();
  calls = [];
}
/** Spend this address's whole daily allowance through the embed. */
async function exhaust(ip) {
  for (let i = 0; i < budget.anonLookupCap(); i++) await create({ imei: freshImei(), client: "swapmore" }, { ip });
}

console.log("lookup budget — who gets the paid lookup");

await t("consumer IMEI-first (SwapMore's embed, under the limit) resolves the model from the registry", async () => {
  reset();
  const imei = freshImei();
  const s = await create({ imei, client: "swapmore" });
  assert.deepEqual(calls, [`/cloud/cloudDB/GetDeviceInfo ${imei}`, `/cloud/cloudDB/CheckEsn/ ${imei}`]);
  assert.equal(s.model, "Galaxy Z Flip5");
  assert.equal(s.imeiInfo.source, "gsma");
  assert.equal(s.imeiInfo.skipped, undefined);
});

await t("CounterIQ's retail desk (channel retail) is a known channel too", async () => {
  reset();
  const s = await create({ imei: freshImei(), client: "denovo", channel: "retail" });
  assert.equal(calls.length, 2);
  assert.equal(s.imeiInfo.source, "gsma");
});

await t("OVER THE LIMIT: the session is created without a lookup — zero Phonecheck calls", async () => {
  reset();
  await exhaust("198.51.100.7");
  calls = [];
  const imei = freshImei();
  const s = await create({ imei, client: "swapmore" });
  assert.deepEqual(calls, []);
  assert.ok(s.id, "the session still exists");
  assert.equal(s.imei, imei);
  assert.equal(s.imeiInfo.skipped, "daily-cap");
  assert.ok(s.imeiInfo.source === "tac" || s.imeiInfo.source === "stub", s.imeiInfo.source);
  assert.equal(s.imeiInfo.blacklist, "unknown");
  assert.deepEqual(s.phonecheck, null);
  assert.ok(eventsFor(s.id).some((e) => e.event === "lookup-skipped" && e.detail?.reason === "daily-cap"));
});

await t("…and its identity reads UNVERIFIED on GET /api/sessions/[id], with the reason", async () => {
  reset();
  await exhaust("198.51.100.8");
  const s = await create({ imei: freshImei(), client: "swapmore" }, { ip: "198.51.100.8" });
  const got = await getSessionApi(s.id);
  assert.equal(got.identity.verdict, "unverified");
  assert.ok(got.identity.flags.some((f) => /not checked against the device registry \(the daily lookup limit was reached\)/.test(f)), got.identity.flags.join(" | "));
});

await t("the limit is per address: another IP still gets its lookup", async () => {
  reset();
  await exhaust("198.51.100.9");
  calls = [];
  const s = await create({ imei: freshImei(), client: "swapmore" }, { ip: "203.0.113.20" });
  assert.equal(calls.length, 2);
  assert.equal(s.imeiInfo.skipped, undefined);
});

await t("the address is the FIRST X-Forwarded-For entry (the one Caddy wrote)", async () => {
  reset();
  await exhaust("203.0.113.5");
  calls = [];
  const s = await create({ imei: freshImei(), client: "swapmore" }, { ip: "203.0.113.5, 10.0.0.1" });
  assert.deepEqual(calls, []);
  assert.equal(s.imeiInfo.skipped, "daily-cap");
  assert.equal(budget.anonPaidToday("203.0.113.5"), budget.anonLookupCap());
});

await t("a burst of parallel creates from one address cannot overrun the limit", async () => {
  reset();
  const ip = "198.51.100.30";
  const out = await Promise.all(Array.from({ length: 8 }, () => create({ imei: freshImei(), client: "swapmore" }, { ip })));
  assert.equal(imeisAsked().length, budget.anonLookupCap(), `Phonecheck asked about ${imeisAsked().length} IMEIs`);
  assert.equal(out.filter((s) => s.imeiInfo.skipped === "daily-cap").length, 8 - budget.anonLookupCap());
});

await t("no known channel (default client, no channel): no paid lookup at all", async () => {
  reset();
  const s = await create({ imei: freshImei() });
  assert.deepEqual(calls, []);
  assert.equal(s.imeiInfo.skipped, "no-channel");
  assert.ok(s.imeiInfo.source === "tac" || s.imeiInfo.source === "stub", s.imeiInfo.source);
  const got = await getSessionApi(s.id);
  assert.equal(got.identity.verdict, "unverified");
});

await t("a cached IMEI is free for everyone — even past the limit, even with no channel", async () => {
  reset();
  const imei = freshImei();
  await create({ imei, client: "swapmore" }, { ip: "203.0.113.40" }); // paid, now cached
  await exhaust("198.51.100.41");
  calls = [];
  const capped = await create({ imei, client: "swapmore" }, { ip: "198.51.100.41" });
  const nochannel = await create({ imei }, { ip: "198.51.100.42" });
  assert.deepEqual(calls, []);
  for (const s of [capped, nochannel]) {
    assert.equal(s.imeiInfo.skipped, undefined);
    assert.equal(s.imeiInfo.source, "gsma");
    assert.equal(s.model, "Galaxy Z Flip5");
  }
});

await t("SwapUp (server key) resolves the model past the limit — no limit for the server", async () => {
  reset();
  await exhaust("198.51.100.50");
  calls = [];
  // SwapUp's call A: the IMEI route, with the key.
  const imei = freshImei();
  const r = await inRequest("", () =>
    lookupRoute.GET(new Request(`${BASE}/api/imei/${imei}`, { headers: { "x-gradeiq-server-key": KEY, "x-forwarded-for": "198.51.100.50" } }), {
      params: Promise.resolve({ imei }),
    })
  );
  assert.equal(r.status, 200);
  assert.equal((await r.json()).model, "Galaxy Z Flip5");
  // And a session created with the key from the same, capped, address.
  const s = await create({ imei: freshImei() }, { ip: "198.51.100.50", headers: { "x-gradeiq-server-key": KEY } });
  assert.equal(imeisAsked().length, 2);
  assert.equal(s.model, "Galaxy Z Flip5");
  assert.equal(s.imeiInfo.skipped, undefined);
});

await t("a wrong server key is just anonymous (and capped)", async () => {
  reset();
  await exhaust("198.51.100.51");
  calls = [];
  const s = await create({ imei: freshImei(), client: "swapmore" }, { ip: "198.51.100.51", headers: { "x-gradeiq-server-key": KEY + "x" } });
  assert.deepEqual(calls, []);
  assert.equal(s.imeiInfo.skipped, "daily-cap");
});

await t("staff (a real portal sign-in) are not limited", async () => {
  reset();
  await exhaust("198.51.100.60");
  calls = [];
  const s = await create({ imei: freshImei() }, { ip: "198.51.100.60", cookie: staffCookie() });
  assert.equal(calls.length, 2);
  assert.equal(s.imeiInfo.source, "gsma");
});

await t("CounterIQ with its retail key: 25 retail creates from ONE address all get the paid lookup", async () => {
  reset();
  // Every desk on a CounterIQ deployment reaches GradeIQ from that VM's one address.
  const ip = "198.51.100.55";
  const out = [];
  for (let i = 0; i < 25; i++) {
    out.push(await create({ imei: freshImei(), client: "denovo", channel: "retail" }, { ip, headers: { "x-gradeiq-retail-key": RKEY } }));
  }
  assert.equal(imeisAsked().length, 25, `Phonecheck asked about ${imeisAsked().length} IMEIs`);
  assert.ok(out.every((s) => s.imeiInfo.skipped === undefined && s.imeiInfo.source === "gsma"));
  assert.equal(budget.anonPaidToday(ip), 0, "none of them counts against the anonymous limit");
  assert.equal(budget.paidLookupStats().byCaller.retail, 25);
});

await t("…and the same 25 with SwapUp's server key", async () => {
  reset();
  for (let i = 0; i < 25; i++) {
    await create({ imei: freshImei(), client: "denovo", channel: "retail" }, { ip: "198.51.100.56", headers: { "x-gradeiq-server-key": KEY } });
  }
  assert.equal(imeisAsked().length, 25);
});

await t("a wrong retail key (or none) is a keyless retail desk: capped per address", async () => {
  reset();
  const ip = "198.51.100.57";
  const out = [];
  for (let i = 0; i < budget.anonLookupCap() + 2; i++) {
    out.push(await create({ imei: freshImei(), client: "denovo", channel: "retail" }, { ip, headers: { "x-gradeiq-retail-key": RKEY + "x" } }));
  }
  assert.equal(imeisAsked().length, budget.anonLookupCap());
  assert.equal(out.filter((s) => s.imeiInfo.skipped === "daily-cap").length, 2);
});

await t("the retail key buys session lookups only — /api/imei still answers 401 to it", async () => {
  reset();
  const imei = freshImei();
  const r = await inRequest("", () =>
    lookupRoute.GET(new Request(`${BASE}/api/imei/${imei}`, { headers: { "x-gradeiq-retail-key": RKEY } }), {
      params: Promise.resolve({ imei }),
    })
  );
  assert.equal(r.status, 401);
  assert.deepEqual(calls, []);
});

console.log("lookup budget — the daily total for all anonymous callers");

await t("DAILY TOTAL: many addresses together stop at GRADEIQ_ANON_LOOKUP_TOTAL_CAP — then TAC only, logged once", async () => {
  reset();
  const saved = process.env.GRADEIQ_ANON_LOOKUP_TOTAL_CAP;
  const warn = console.warn;
  const warned = [];
  console.warn = (...a) => warned.push(a.join(" "));
  process.env.GRADEIQ_ANON_LOOKUP_TOTAL_CAP = "5";
  try {
    const out = [];
    // Four addresses, two creates each: every one is under its own limit (3).
    for (const ip of ["203.0.113.61", "203.0.113.62", "203.0.113.63", "203.0.113.64"]) {
      for (let i = 0; i < 2; i++) out.push(await create({ imei: freshImei(), client: "swapmore" }, { ip }));
    }
    assert.equal(imeisAsked().length, 5, `Phonecheck asked about ${imeisAsked().length} IMEIs`);
    const capped = out.filter((s) => s.imeiInfo.skipped === "total-cap");
    assert.equal(capped.length, 3);
    assert.ok(capped.every((s) => s.phonecheck === null && s.imeiInfo.blacklist === "unknown"));
    assert.ok(eventsFor(capped[0].id).some((e) => e.event === "lookup-skipped" && e.detail?.reason === "total-cap"));
    const got = await getSessionApi(capped[0].id);
    assert.equal(got.identity.verdict, "unverified");
    assert.ok(got.identity.flags.some((f) => /the daily lookup limit was reached/.test(f)), got.identity.flags.join(" | "));
    // The alert: one log line for the day, however many are held back.
    assert.equal(warned.length, 1, warned.join("\n"));
    assert.match(warned[0], /reached the daily total of 5 paid IMEI lookups \(GRADEIQ_ANON_LOOKUP_TOTAL_CAP\)/);
    const st = budget.paidLookupStats();
    assert.equal(st.totalReached, true);
    assert.equal(st.totalCap, 5);
    assert.equal(st.skippedByReason["total-cap"], 3);
    // The server key, the retail key and staff are not part of the total.
    calls = [];
    await create({ imei: freshImei() }, { ip: "203.0.113.65", headers: { "x-gradeiq-server-key": KEY } });
    await create({ imei: freshImei(), channel: "retail" }, { ip: "203.0.113.65", headers: { "x-gradeiq-retail-key": RKEY } });
    await create({ imei: freshImei() }, { ip: "203.0.113.65", cookie: staffCookie() });
    assert.equal(imeisAsked().length, 3);
  } finally {
    console.warn = warn;
    if (saved === undefined) delete process.env.GRADEIQ_ANON_LOOKUP_TOTAL_CAP;
    else process.env.GRADEIQ_ANON_LOOKUP_TOTAL_CAP = saved;
  }
});

await t("a parallel burst from many addresses cannot overrun the daily total", async () => {
  reset();
  process.env.GRADEIQ_ANON_LOOKUP_TOTAL_CAP = "4";
  const warn = console.warn;
  console.warn = () => {};
  try {
    const out = await Promise.all(
      Array.from({ length: 12 }, (_, i) => create({ imei: freshImei(), client: "swapmore" }, { ip: `2001:db8::${i + 1}` }))
    );
    assert.equal(imeisAsked().length, 4, `Phonecheck asked about ${imeisAsked().length} IMEIs`);
    assert.equal(out.filter((s) => s.imeiInfo.skipped === "total-cap").length, 8);
  } finally {
    console.warn = warn;
    delete process.env.GRADEIQ_ANON_LOOKUP_TOTAL_CAP;
  }
});

await t("GRADEIQ_ANON_LOOKUP_TOTAL_CAP: unset or junk → 200; 0 → no anonymous lookups at all", async () => {
  try {
    delete process.env.GRADEIQ_ANON_LOOKUP_TOTAL_CAP;
    assert.equal(budget.anonLookupTotalCap(), budget.DEFAULT_ANON_LOOKUP_TOTAL_CAP);
    assert.equal(budget.DEFAULT_ANON_LOOKUP_TOTAL_CAP, 200);
    process.env.GRADEIQ_ANON_LOOKUP_TOTAL_CAP = "-1";
    assert.equal(budget.anonLookupTotalCap(), budget.DEFAULT_ANON_LOOKUP_TOTAL_CAP);
    process.env.GRADEIQ_ANON_LOOKUP_TOTAL_CAP = "0";
    reset();
    const s = await create({ imei: freshImei(), client: "swapmore" }, { ip: "198.51.100.101" });
    assert.deepEqual(calls, []);
    assert.equal(s.imeiInfo.skipped, "total-cap");
  } finally {
    delete process.env.GRADEIQ_ANON_LOOKUP_TOTAL_CAP;
  }
});

console.log("lookup budget — the session routes cannot buy the refused lookup");

await t("/accept and /offer on an over-limit session make ZERO Phonecheck calls", async () => {
  reset();
  await exhaust("198.51.100.70");
  const s = await create({ imei: freshImei(), client: "swapmore" }, { ip: "198.51.100.70" });
  assert.equal(s.imeiInfo.skipped, "daily-cap");
  calls = [];
  for (let i = 0; i < 2; i++) {
    assert.equal((await sessionPost(acceptRoute, s.id, "accept", "198.51.100.70")).status, 200);
    assert.equal((await sessionPost(offerRoute, s.id, "offer", "198.51.100.70")).status, 200);
  }
  assert.deepEqual(calls, []);
});

await t("…a no-channel session cannot buy it from another address either", async () => {
  reset();
  const s = await create({ imei: freshImei() }, { ip: "198.51.100.71" });
  calls = [];
  await sessionPost(acceptRoute, s.id, "accept", "203.0.113.99");
  await sessionPost(offerRoute, s.id, "offer", "203.0.113.99");
  assert.deepEqual(calls, []);
});

console.log("lookup budget — journey start");

const startJourney = (imei, cookie) =>
  inRequest(cookie, () =>
    journeyRoute.POST(
      new Request(`${BASE}/api/journeys/denovo-tradein-employee/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": "198.51.100.80" },
        body: JSON.stringify({ imei }),
      }),
      { params: Promise.resolve({ journey: "denovo-tradein-employee" }) }
    )
  );

await t("journey start with a cached IMEI makes ZERO Phonecheck calls", async () => {
  reset();
  const imei = freshImei();
  await create({ imei, client: "swapmore" }, { ip: "203.0.113.81" }); // cached now
  calls = [];
  const r = await startJourney(imei, staffCookie());
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.deepEqual(calls, []);
  assert.equal(out.model, "Galaxy Z Flip5");
});

await t("journey start on a new IMEI pays for ONE Phonecheck answer, not lookup + report side by side", async () => {
  reset();
  const imei = freshImei();
  const r = await startJourney(imei, staffCookie());
  assert.equal(r.status, 200);
  // Before: lookupImei (GetDeviceInfo + CheckEsn) AND getPhonecheck (the same two) — four calls.
  assert.deepEqual(calls, [`/cloud/cloudDB/GetDeviceInfo ${imei}`, `/cloud/cloudDB/CheckEsn/ ${imei}`]);
  assert.equal((await r.json()).model, "Galaxy Z Flip5");
  // …and it is cached for the next caller.
  calls = [];
  await resolveImei(imei);
  assert.deepEqual(calls, []);
});

await t("an employee journey still needs staff (401, nothing spent)", async () => {
  reset();
  const r = await startJourney(freshImei(), "");
  assert.equal(r.status, 401);
  assert.deepEqual(calls, []);
});

console.log("lookup budget — the count staff see");

await t("GET /api/settings shows staff today's paid and held-back lookups", async () => {
  reset();
  await create({ imei: freshImei(), client: "swapmore" }, { ip: "198.51.100.90" }); // channel, paid
  await create({ imei: freshImei() }, { ip: "198.51.100.90" }); // no channel, held back
  await create({ imei: freshImei() }, { ip: "198.51.100.90", headers: { "x-gradeiq-server-key": KEY } }); // server, paid
  await create({ imei: freshImei(), channel: "retail" }, { ip: "198.51.100.90", headers: { "x-gradeiq-retail-key": RKEY } }); // retail, paid
  await create({ imei: freshImei() }, { ip: "198.51.100.90", cookie: staffCookie() }); // staff, paid
  await exhaust("198.51.100.91");
  await create({ imei: freshImei(), client: "swapmore" }, { ip: "198.51.100.91" }); // over the limit
  const r = await inRequest(staffCookie(), () => settingsRoute.GET());
  assert.equal(r.status, 200);
  const { paidLookups: p } = await r.json();
  assert.equal(p.total, 4 + budget.anonLookupCap());
  assert.deepEqual(p.byCaller, { server: 1, retail: 1, staff: 1, channel: 1 + budget.anonLookupCap(), internal: 0 });
  assert.equal(p.skipped, 2);
  assert.deepEqual(p.skippedByReason, { "daily-cap": 1, "total-cap": 0, "no-channel": 1 });
  assert.equal(p.cap, budget.anonLookupCap());
  assert.equal(p.ipsAtCap, 1);
  assert.equal(p.totalCap, budget.DEFAULT_ANON_LOOKUP_TOTAL_CAP);
  assert.equal(p.totalReached, false);
  assert.equal(p.day, new Date().toISOString().slice(0, 10));
  // The same page without a sign-in: 401, no counts.
  const anon = await inRequest("", () => settingsRoute.GET());
  assert.equal(anon.status, 401);
});

await t("no Phonecheck credentials: nothing is spent, so nothing is counted as paid", async () => {
  reset();
  delete process.env.PHONECHECK_API_KEY;
  try {
    for (let i = 0; i < budget.anonLookupCap() + 2; i++) {
      const s = await create({ imei: freshImei(), client: "swapmore" }, { ip: "198.51.100.95" });
      assert.equal(s.imeiInfo.skipped, undefined, "the allowance was never used up");
    }
    assert.deepEqual(calls, []);
    assert.equal(budget.paidLookupStats().total, 0);
  } finally {
    process.env.PHONECHECK_API_KEY = "pc-test-key";
  }
});

await t("yesterday's lookups do not count against today", async () => {
  reset();
  const yesterday = Date.now() - 24 * 60 * 60 * 1000;
  const g = { caller: "channel", ip: "198.51.100.99" };
  for (let i = 0; i < budget.anonLookupCap(); i++) assert.equal(budget.reservePaidLookup(g, yesterday).ok, true);
  assert.deepEqual(budget.reservePaidLookup(g, yesterday), { ok: false, reason: "daily-cap" });
  assert.equal(budget.reservePaidLookup(g).ok, true);
});

await t("GRADEIQ_ANON_LOOKUP_CAP: unset or junk → 20; 0 → no anonymous lookups at all", async () => {
  const saved = process.env.GRADEIQ_ANON_LOOKUP_CAP;
  try {
    delete process.env.GRADEIQ_ANON_LOOKUP_CAP;
    assert.equal(budget.anonLookupCap(), budget.DEFAULT_ANON_LOOKUP_CAP);
    process.env.GRADEIQ_ANON_LOOKUP_CAP = "lots";
    assert.equal(budget.anonLookupCap(), budget.DEFAULT_ANON_LOOKUP_CAP);
    process.env.GRADEIQ_ANON_LOOKUP_CAP = "0";
    reset();
    const s = await create({ imei: freshImei(), client: "swapmore" }, { ip: "198.51.100.100" });
    assert.deepEqual(calls, []);
    assert.equal(s.imeiInfo.skipped, "daily-cap");
  } finally {
    process.env.GRADEIQ_ANON_LOOKUP_CAP = saved;
  }
});

console.log(pass + " assertions passed\n");
