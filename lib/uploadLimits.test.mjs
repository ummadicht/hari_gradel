// SUP-80 — anonymous uploads and vision calls are capped and rate-limited.
//
// Through the PRODUCTION route handlers:
//   • 413 when a body is over its route's cap — by Content-Length before a byte
//     is read, and by counting the stream when the header lies or is missing —
//     with nothing written and no model call;
//   • 429 past the per-session daily limit and the per-IP hourly limit (the
//     shared SUP-72 limiter, lib/lookupBudget.ts) — nothing written, no model
//     call, the refusal in the session trail, Retry-After set;
//   • SwapUp's server key, CounterIQ's retail key and staff are never limited;
//   • /camera-assess counts only real model calls, not its cached answer;
//   • the windows turn over, and a parallel burst cannot overshoot;
//   • the biggest request each of GradeIQ's own pages can send, and a heavy
//     session from a busy store, stay under the default limits.
//
// No network: global fetch is a scripted vision model that counts every call.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

// db.ts opens <cwd>/data/gradeiq.db — never a real database.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "giq-upload-limits-")));
for (const k of Object.keys(process.env)) {
  if (/^(PHONECHECK_|IMEI_API_|GEMINI_|GOOGLE_API_KEY|OPENAI_|MOONSHOT_|KIMI_|VISION_|PRO_ONLY|GRADEIQ_|GIQ_AUTH_MODE|KEYCLOAK_|PORTAL_PW_|ENT_)/.test(k)) delete process.env[k];
}
if (process.env.NODE_ENV === "development") delete process.env.NODE_ENV;
process.env.GEMINI_API_KEY = "gemini-test-key";
process.env.GIQ_AUTH_MODE = "legacy";
const SESSION_CAP = 4;
const IP_CAP = 10;
process.env.GRADEIQ_ANON_UPLOAD_SESSION_CAP = String(SESSION_CAP);
process.env.GRADEIQ_ANON_UPLOAD_IP_HOURLY_CAP = String(IP_CAP);
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

/** Every request to a vision model. */
let modelCalls = 0;
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  if (!/googleapis\.com$|openai\.com$|moonshot/.test(u.hostname)) throw new Error(`unexpected fetch ${u.href}`);
  modelCalls++;
  const body = { candidates: [{ content: { parts: [{ text: "{}" }] } }] };
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
};

globalThis.AsyncLocalStorage ??= (await import("node:async_hooks")).AsyncLocalStorage;
const require = createRequire(import.meta.url);
const { workAsyncStorage } = require("next/dist/server/app-render/work-async-storage.external.js");
const { workUnitAsyncStorage } = require("next/dist/server/app-render/work-unit-async-storage.external.js");
const { RequestCookies } = require("next/dist/server/web/spec-extension/cookies.js");

const sessionsRoute = await import("../app/api/sessions/route.ts");
const routes = {
  cosmetic: await import("../app/api/sessions/[id]/cosmetic/route.ts"),
  display: await import("../app/api/sessions/[id]/display/route.ts"),
  ocr: await import("../app/api/sessions/[id]/ocr/route.ts"),
  "camera-frames": await import("../app/api/sessions/[id]/camera-frames/route.ts"),
  "camera-assess": await import("../app/api/sessions/[id]/camera-assess/route.ts"),
  "lens-verify": await import("../app/api/sessions/[id]/lens-verify/route.ts"),
  video: await import("../app/api/sessions/[id]/video/route.ts"),
};
const imeiOcrRoute = await import("../app/api/imei/ocr/route.ts");
const { db } = await import("./db.ts");
const { eventsFor } = await import("./events.ts");
const { checkLogin } = await import("./portalAuth.ts");
const { insertSession, newSid } = await import("./oidc-session.ts");
const budget = await import("./lookupBudget.ts");
const { UPLOAD_BODY_CAPS } = await import("./uploadLimits.ts");

const BASE = "http://localhost:3700";
const MB = 1024 * 1024;
const UPLOADS = path.join(process.cwd(), "data", "uploads");
const fileCount = () => fs.readdirSync(UPLOADS).length;

function inRequest(cookie, fn) {
  const cookies = new RequestCookies(new Headers(cookie ? { cookie } : {}));
  return workAsyncStorage.run({ route: "/api/test", forceStatic: false, dynamicShouldError: false }, () =>
    workUnitAsyncStorage.run({ type: "request", phase: "render", cookies }, fn)
  );
}
const staffCookie = () => `giq_portal=${checkLogin("admin", ADMIN_PW).token}`;

let ipSeq = 1;
/** A fresh address per test, so the per-IP hour starts empty. */
const freshIp = () => `203.0.113.${ipSeq++}`;

async function newSession(ip = "198.51.100.1") {
  const r = await inRequest("", () =>
    sessionsRoute.POST(
      new Request(`${BASE}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
        body: JSON.stringify({ client: "swapmore-in", channel: "retail", segment: "c2b", model: "iPhone 13" }),
      })
    )
  );
  assert.equal(r.status, 200);
  return (await r.json()).id;
}

/** POST /api/sessions/[id]/<sub> as a browser at `ip`. `body` is JSON-encoded unless it is a string or stream. */
function post(sub, id, body, { ip, headers = {}, cookie = "" } = {}) {
  const raw = typeof body === "string" || body instanceof ReadableStream ? body : JSON.stringify(body ?? {});
  const init = {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip, ...headers },
    body: raw,
  };
  if (raw instanceof ReadableStream) init.duplex = "half";
  return inRequest(cookie, () =>
    routes[sub].POST(new Request(`${BASE}/api/sessions/${id}/${sub}`, init), { params: Promise.resolve({ id }) })
  );
}
function imeiOcr(body, { ip, headers = {}, cookie = "" } = {}) {
  return inRequest(cookie, () =>
    imeiOcrRoute.POST(
      new Request(`${BASE}/api/imei/ocr`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": ip, "sec-fetch-site": "same-origin", ...headers },
        body: JSON.stringify(body),
      })
    )
  );
}

/** A data URL of `bytes` decoded bytes (the content is junk; the size is the point). */
const dataUrl = (bytes, mime = "image/jpeg") => `data:${mime};base64,${Buffer.alloc(bytes, 7).toString("base64")}`;
const smallFrame = () => ({ lensId: "rear-1", name: "Wide", facing: "rear", photo: dataUrl(20_000) });
const displayBody = () => ({ captures: [{ pattern: "white", photo: dataUrl(30_000) }] });
const eventsOf = (id, event) => eventsFor(id).filter((e) => e.step === "uploads" && e.event === event);

console.log("upload limits (SUP-80)");

// ── 413 ─────────────────────────────────────────────────────────────────────

await t("413 by Content-Length: nothing read, written or counted, no model call, logged", async () => {
  const ip = freshIp();
  const id = await newSession();
  const files = fileCount();
  const calls = modelCalls;
  const r = await post("display", id, displayBody(), {
    ip,
    headers: { "content-length": String(UPLOAD_BODY_CAPS.display + 1) },
  });
  assert.equal(r.status, 413);
  const d = await r.json();
  assert.equal(d.error, "payload too large");
  assert.equal(d.limit, UPLOAD_BODY_CAPS.display);
  assert.equal(fileCount(), files);
  assert.equal(modelCalls, calls);
  assert.equal(budget.uploadCallsToday(id), 0, "a refused size is not a spent call");
  assert.equal(eventsOf(id, "too-large").length, 1);
});

await t("413 when the stream runs past the cap with no Content-Length: cut off, nothing written", async () => {
  const ip = freshIp();
  const id = await newSession();
  const files = fileCount();
  const cap = UPLOAD_BODY_CAPS["camera-frames"];
  let sent = 0;
  const stream = new ReadableStream({
    pull(c) {
      // An endless body: the route must stop reading, not wait for the end.
      const chunk = new Uint8Array(256 * 1024).fill(65);
      sent += chunk.byteLength;
      c.enqueue(chunk);
    },
  });
  const r = await post("camera-frames", id, stream, { ip });
  assert.equal(r.status, 413);
  assert.ok(sent <= cap + 2 * 256 * 1024 + 1, `stopped reading near the cap (read ${sent} of an endless body)`);
  assert.equal(fileCount(), files);
});

await t("413 when Content-Length understates the body", async () => {
  const id = await newSession();
  const big = JSON.stringify({ frames: [{ ...smallFrame(), photo: dataUrl(UPLOAD_BODY_CAPS["camera-frames"]) }] });
  const r = await post("camera-frames", id, big, { ip: freshIp(), headers: { "content-length": "100" } });
  assert.equal(r.status, 413);
});

await t("under the cap the route answers as before (and junk JSON is still {} → its own 400)", async () => {
  const ip = freshIp();
  const id = await newSession();
  const ok = await post("camera-frames", id, { frames: [smallFrame()] }, { ip });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).saved, 1);
  const junk = await post("video", id, "not json at all", { ip });
  assert.equal(junk.status, 400);
  assert.equal((await junk.json()).error, "no video");
});

// ── 429 ─────────────────────────────────────────────────────────────────────

await t("per session: the call past the daily limit is 429 — nothing written, no model call, logged", async () => {
  const ip = freshIp();
  const id = await newSession();
  for (let i = 0; i < SESSION_CAP; i++) {
    const r = await post("display", id, displayBody(), { ip });
    assert.equal(r.status, 200, `call ${i + 1}`);
  }
  assert.equal(budget.uploadCallsToday(id), SESSION_CAP);
  const files = fileCount();
  const calls = modelCalls;
  const r = await post("display", id, displayBody(), { ip });
  assert.equal(r.status, 429);
  const d = await r.json();
  assert.equal(d.code, "rate-limited");
  assert.equal(d.reason, "session-daily");
  assert.match(d.error, /too many uploads today/);
  const retry = Number(r.headers.get("retry-after"));
  assert.ok(retry > 0 && retry <= 86_400, `Retry-After ${retry}`);
  assert.equal(fileCount(), files, "nothing written");
  assert.equal(modelCalls, calls, "no model call");
  const ev = eventsOf(id, "rate-limited");
  assert.equal(ev.length, 1);
  assert.equal(ev[0].detail.route, "display");
  assert.equal(ev[0].detail.reason, "session-daily");
  assert.equal(budget.uploadRefusals("session", id), 1);
  // A flood of refusals is counted, but writes the trail once (per route, per hour).
  for (let i = 0; i < 5; i++) assert.equal((await post("display", id, displayBody(), { ip })).status, 429);
  assert.equal(budget.uploadRefusals("session", id), 6);
  assert.equal(eventsOf(id, "rate-limited").length, 1);
  // …every upload route shares the session's allowance.
  assert.equal((await post("video", id, { video: dataUrl(1000, "video/webm") }, { ip })).status, 429);
  assert.equal((await post("cosmetic", id, { photos: [dataUrl(1000)] }, { ip })).status, 429);
  // …and another session from the same address is unaffected.
  assert.equal((await post("display", await newSession(), displayBody(), { ip })).status, 200);
});

await t("per IP: past the hourly limit every route is 429 for that address, incl. /api/imei/ocr (no Gemini call)", async () => {
  const ip = freshIp();
  let used = 0;
  while (used < IP_CAP) {
    const id = await newSession();
    for (let i = 0; i < 3 && used < IP_CAP; i++, used++) {
      assert.equal((await post("camera-frames", id, { frames: [smallFrame()] }, { ip })).status, 200);
    }
  }
  assert.equal(budget.uploadCallsThisHour(ip), IP_CAP);
  const id = await newSession();
  const calls = modelCalls;
  const files = fileCount();
  const r = await post("display", id, displayBody(), { ip });
  assert.equal(r.status, 429);
  assert.equal((await r.json()).reason, "ip-hourly");
  assert.ok(Number(r.headers.get("retry-after")) <= 3600);
  const o = await imeiOcr({ photo: dataUrl(5000) }, { ip });
  assert.equal(o.status, 429);
  assert.equal(modelCalls, calls, "no model call");
  assert.equal(fileCount(), files);
  assert.equal(eventsOf(id, "rate-limited")[0].detail.reason, "ip-hourly");
  // A different address is its own allowance.
  assert.equal((await imeiOcr({ photo: dataUrl(5000) }, { ip: freshIp() })).status, 200);
  assert.ok(modelCalls > calls, "the allowed call did reach the model");
});

await t("never limited: SwapUp's server key, CounterIQ's retail key, staff (portal and Keycloak) — and not counted", async () => {
  const ip = freshIp();
  const id = await newSession();
  for (let i = 0; i < SESSION_CAP; i++) assert.equal((await post("camera-frames", id, { frames: [smallFrame()] }, { ip })).status, 200);
  assert.equal((await post("camera-frames", id, { frames: [smallFrame()] }, { ip })).status, 429);
  const sid = newSid();
  insertSession({ sid, sub: "kc-ops", email: "ops@example.test", name: "Ops", role: "client", clientId: "swapmore-in", id_token: null });
  const trusted = [
    { headers: { "x-gradeiq-server-key": KEY } },
    { headers: { "x-gradeiq-retail-key": RKEY } },
    { cookie: staffCookie() },
  ];
  for (let i = 0; i < 3; i++) {
    for (const how of trusted) {
      assert.equal((await post("camera-frames", id, { frames: [smallFrame()] }, { ip, ...how })).status, 200, JSON.stringify(how.headers ?? "staff"));
    }
  }
  process.env.GIQ_AUTH_MODE = "oidc";
  try {
    assert.equal((await post("camera-frames", id, { frames: [smallFrame()] }, { ip, cookie: `giq_session=${sid}` })).status, 200);
  } finally {
    process.env.GIQ_AUTH_MODE = "legacy";
  }
  assert.equal(budget.uploadCallsToday(id), SESSION_CAP, "trusted calls are not counted");
  // A wrong key is just anonymous.
  assert.equal((await post("camera-frames", id, { frames: [smallFrame()] }, { ip, headers: { "x-gradeiq-server-key": "nope" } })).status, 429);
  // The server key on /api/imei/ocr past the address's limit, too.
  for (let i = 0; i < IP_CAP; i++) budget.reserveUploadCall({ caller: "channel", ip }, null);
  assert.equal((await imeiOcr({ photo: dataUrl(5000) }, { ip, headers: { "x-gradeiq-server-key": KEY } })).status, 200);
});

await t("/camera-assess: the cached answer is free; real calls are counted and refused past the limit without a model call", async () => {
  const ip = freshIp();
  const id = await newSession();
  assert.equal((await post("camera-frames", id, { frames: [smallFrame()] }, { ip })).status, 200);
  const before = budget.uploadCallsToday(id);
  for (let i = before; i < SESSION_CAP; i++) await post("camera-assess", id, "", { ip });
  assert.equal(budget.uploadCallsToday(id), SESSION_CAP);
  const calls = modelCalls;
  const r = await post("camera-assess", id, "", { ip });
  assert.equal(r.status, 429);
  assert.equal(modelCalls, calls);
  // With an assessment on record the answer is cached: 200, not counted, even now.
  const cam = JSON.parse(db.prepare("SELECT camera FROM sessions WHERE id = ?").get(id).camera);
  db.prepare("UPDATE sessions SET camera = ? WHERE id = ?").run(JSON.stringify({ ...cam, assessment: { lenses: [] } }), id);
  const cached = await post("camera-assess", id, "", { ip });
  assert.equal(cached.status, 200);
  assert.equal((await cached.json()).cached, true);
});

// ── the limiter itself ──────────────────────────────────────────────────────

await t("the windows turn over: a new UTC hour for the address, a new UTC day for the session", async () => {
  const ip = freshIp();
  const now = Date.UTC(2026, 9, 22, 10, 59, 30);
  const g = { caller: "anonymous", ip };
  for (let i = 0; i < IP_CAP; i++) assert.equal(budget.reserveUploadCall(g, `s-${i}`, now).ok, true);
  const refused = budget.reserveUploadCall(g, "s-x", now);
  assert.deepEqual([refused.ok, refused.reason, refused.retryAfter], [false, "ip-hourly", 30]);
  assert.equal(budget.reserveUploadCall(g, "s-x", now + 31_000).ok, true, "11:00 is a new hour");

  const day = Date.UTC(2026, 9, 22, 23, 0, 0);
  const sess = "s-day";
  for (let i = 0; i < SESSION_CAP; i++) assert.equal(budget.reserveUploadCall({ caller: "channel", ip: freshIp() }, sess, day).ok, true);
  const r = budget.reserveUploadCall({ caller: "channel", ip: freshIp() }, sess, day);
  assert.deepEqual([r.ok, r.reason, r.retryAfter], [false, "session-daily", 3600]);
  assert.equal(budget.reserveUploadCall({ caller: "channel", ip: freshIp() }, sess, day + 3_600_000).ok, true, "a new UTC day");
});

await t("a parallel burst cannot overshoot: exactly the limit gets through", async () => {
  const ip = freshIp();
  const id = await newSession();
  const results = await Promise.all(
    Array.from({ length: 12 }, () => post("camera-frames", id, { frames: [smallFrame()] }, { ip }))
  );
  const codes = results.map((r) => r.status);
  assert.equal(codes.filter((c) => c === 200).length, SESSION_CAP, codes.join(","));
  assert.equal(codes.filter((c) => c === 429).length, 12 - SESSION_CAP);
});

await t("the SUP-72 lookup budget is untouched by upload traffic", async () => {
  assert.equal(budget.paidLookupStats().total, 0);
});

// ── legitimate flows at the DEFAULT limits ──────────────────────────────────

await t("defaults: 60 calls a session a day, 600 an address an hour", async () => {
  delete process.env.GRADEIQ_ANON_UPLOAD_SESSION_CAP;
  delete process.env.GRADEIQ_ANON_UPLOAD_IP_HOURLY_CAP;
  assert.equal(budget.anonUploadSessionCap(), 60);
  assert.equal(budget.anonUploadIpHourlyCap(), 600);
});

await t("the biggest request each of GradeIQ's own pages can send is admitted", async () => {
  const ip = freshIp();
  const id = await newSession();
  // Sizes from the code that builds each request — docs/UPLOAD-LIMITS.md.
  const photo = () => dataUrl(1_200_000); // ≤1440 px JPEG 0.86, high detail
  const biggest = {
    // V2Cam validate pass: 6 photos + 6 torch twins (~20 MB)
    cosmetic: { photos: Array.from({ length: 6 }, photo), lit: Array.from({ length: 6 }, photo), validateOnly: true },
    // V2Cam sweep: 8 screen captures (~13 MB)
    display: { captures: Array.from({ length: 8 }, (_, i) => ({ pattern: `p${i}`, photo: photo() })) },
    // V2Flow battery screenshot sent as picked: one 10 MB camera original (~14 MB)
    ocr: { frames: [dataUrl(10 * MB)] },
    // DeviceTest: 8 stills at the route's own 400 KB ceiling (~4.4 MB)
    "camera-frames": { frames: Array.from({ length: 8 }, () => ({ ...smallFrame(), photo: dataUrl(400 * 1024) })) },
    // DeviceTest: 3 downscaled shots + one the browser could not decode (~17 MB)
    "lens-verify": {
      shots: [
        ...Array.from({ length: 3 }, (_, i) => ({ lensId: `l${i}`, label: "x", zoom: i + 1, photo: dataUrl(480 * 1024) })),
        { lensId: "l3", label: "x", zoom: 5, photo: dataUrl(10 * MB) },
      ],
    },
    // V2Cam rotation take: 3 minutes at 2 Mbps (~60 MB)
    video: { video: dataUrl(45 * MB, "video/webm") },
  };
  for (const [route, body] of Object.entries(biggest)) {
    const raw = JSON.stringify(body);
    assert.ok(raw.length < UPLOAD_BODY_CAPS[route], `${route}: ${(raw.length / MB).toFixed(1)} MB under its ${UPLOAD_BODY_CAPS[route] / MB} MB cap`);
    const r = await post(route, id, raw, { ip });
    assert.ok(![413, 429].includes(r.status), `${route} answered ${r.status}`);
  }
  // ImeiScanner / V2Flow: one camera original (~14 MB).
  assert.equal((await imeiOcr({ photo: dataUrl(10 * MB) }, { ip })).status, 200);
});

await t("a heavy session (retakes, re-runs) and a busy store's hour stay well under the defaults", async () => {
  const ip = freshIp();
  const id = await newSession();
  // SwapUp tablet with three retakes, then the seller's phone re-running tests:
  // 4 validates + 1 final, 4 rotation takes, 2 screen passes, 2 Settings scans,
  // 3 camera runs (frames + assessment), 2 lens submits, 1 battery screenshot.
  const heavy = 4 + 1 + 4 + 2 + 2 + 3 * 2 + 2 + 1;
  for (let i = 0; i < heavy; i++) assert.equal(budget.reserveUploadCall({ caller: "channel", ip }, id).ok, true);
  assert.equal(heavy, 22);
  assert.ok(heavy * 2 < budget.anonUploadSessionCap(), "under half the session limit");
  // Three desks, one 10-minute session each per desk = 18 sessions an hour on
  // one address, every one of them heavy.
  for (let s = 1; s < 18; s++) {
    for (let i = 0; i < heavy; i++) assert.equal(budget.reserveUploadCall({ caller: "channel", ip }, `${id}-${s}`).ok, true);
  }
  assert.equal(budget.uploadCallsThisHour(ip), 18 * heavy);
  assert.ok(18 * heavy < budget.anonUploadIpHourlyCap() * 0.7, `${18 * heavy} of ${budget.anonUploadIpHourlyCap()}`);
});

console.log(`${pass} passed`);
