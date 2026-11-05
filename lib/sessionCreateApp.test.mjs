// SUP-265 — POST /api/sessions marks SwapUp's sessions `profile.app = "swapup"`,
// and only SwapUp's.
//
// SwapUp creates its GradeIQ sessions under client swapmore-in, channel retail
// — the same pair GradeIQ's own retail desk and CounterIQ use — so the pair
// cannot say whose a session is. The server key can: it belongs to SwapUp
// alone (lib/serverKey.ts). These tests run the PRODUCTION handler and pin:
//   • the server key → app "swapup";
//   • no key, a wrong key, the retail key, or `app` asked for in the body →
//     no app, and the rest of the profile is what it always was.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "giq-session-app-")));
for (const k of Object.keys(process.env)) {
  if (/^(PHONECHECK_|IMEI_API_|GEMINI_|GOOGLE_API_KEY|GRADEIQ_|GIQ_AUTH_MODE|KEYCLOAK_)/.test(k)) delete process.env[k];
}
if (process.env.NODE_ENV === "development") delete process.env.NODE_ENV;
// Made-up keys, generated per run.
const SERVER_KEY = `sk-${Math.random().toString(36).slice(2)}`;
const RETAIL_KEY = `rk-${Math.random().toString(36).slice(2)}`;
process.env.GRADEIQ_SERVER_KEY = SERVER_KEY;
process.env.GRADEIQ_RETAIL_KEY = RETAIL_KEY;

globalThis.fetch = async (url) => {
  throw new Error(`unexpected fetch ${url}`);
};

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

globalThis.AsyncLocalStorage ??= (await import("node:async_hooks")).AsyncLocalStorage;
const require = createRequire(import.meta.url);
const { workAsyncStorage } = require("next/dist/server/app-render/work-async-storage.external.js");
const { workUnitAsyncStorage } = require("next/dist/server/app-render/work-unit-async-storage.external.js");
const { RequestCookies } = require("next/dist/server/web/spec-extension/cookies.js");

const sessionsRoute = await import("../app/api/sessions/route.ts");
const sessionRoute = await import("../app/api/sessions/[id]/route.ts");
const { getSession } = await import("./db.ts");

const BASE = "http://localhost:3700";
const SWAPUP_BODY = { client: "swapmore-in", channel: "retail", segment: "c2b" };

function inRequest(fn) {
  const cookies = new RequestCookies(new Headers({}));
  return workAsyncStorage.run({ route: "/api/test", forceStatic: false, dynamicShouldError: false }, () =>
    workUnitAsyncStorage.run({ type: "request", phase: "render", cookies }, fn)
  );
}

async function create(headers = {}, body = SWAPUP_BODY) {
  const r = await inRequest(() =>
    sessionsRoute.POST(
      new Request(`${BASE}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      })
    )
  );
  assert.equal(r.status, 200);
  const j = await r.json();
  return { id: j.id, profile: j.profile, stored: getSession(j.id).profile };
}

/** The profile without the fields that differ per request. */
const shape = (p) => {
  const rest = { ...p };
  delete rest.app;
  return { ...rest, origin: Object.keys(p.origin || {}).sort() };
};

await t('the server key → profile.app "swapup", stored and returned', async () => {
  const { id, profile, stored } = await create({ "x-gradeiq-server-key": SERVER_KEY });
  assert.equal(profile.app, "swapup");
  assert.equal(stored.app, "swapup");
  // The camera page reads it off GET /api/sessions/[id].
  const got = await (await sessionRoute.GET(new Request(`${BASE}/api/sessions/${id}`), { params: Promise.resolve({ id }) })).json();
  assert.equal(got.profile.app, "swapup");
});

await t("no key → no app", async () => {
  const { profile, stored } = await create();
  assert.equal("app" in profile, false);
  assert.equal("app" in stored, false);
});

await t("a wrong server key → no app", async () => {
  const { stored } = await create({ "x-gradeiq-server-key": `${SERVER_KEY}x` });
  assert.equal("app" in stored, false);
});

await t("only the retail key (CounterIQ) → no app", async () => {
  const { stored } = await create({ "x-gradeiq-retail-key": RETAIL_KEY });
  assert.equal("app" in stored, false);
});

await t("asking for app in the body does nothing", async () => {
  const { stored } = await create({}, { ...SWAPUP_BODY, app: "swapup", profile: { app: "swapup" } });
  assert.equal("app" in stored, false);
});

await t("the mark is the only difference the key makes to the profile", async () => {
  const keyed = await create({ "x-gradeiq-server-key": SERVER_KEY });
  const plain = await create();
  assert.deepEqual(shape(keyed.stored), shape(plain.stored));
});

await t("with no server key configured, the header is ignored", async () => {
  const saved = process.env.GRADEIQ_SERVER_KEY;
  delete process.env.GRADEIQ_SERVER_KEY;
  try {
    const { stored } = await create({ "x-gradeiq-server-key": SERVER_KEY });
    assert.equal("app" in stored, false);
  } finally {
    process.env.GRADEIQ_SERVER_KEY = saved;
  }
});

console.log(`${pass} passed`);
