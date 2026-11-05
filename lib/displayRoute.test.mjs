// SUP-264 review — the screen sweep's misses are kept, as numbers, so its
// cut-offs can be tuned on real sweeps.
//
// The field sessions stored only the frames that matched, never what the
// camera saw of a colour it missed — so the black and green cut-offs could not
// be checked against the 25 Oct misses. The camera now sends the locked white
// and, per missed colour, the last region stats it saw; POST /display keeps
// them, cleaned (lib/displaySweep.ts cleanSweepStats), on the session's
// displayCheck. Through the production route; no network.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

// db.ts opens <cwd>/data/gradeiq.db — never a real database.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "giq-display-route-")));
for (const k of Object.keys(process.env)) {
  if (/^(PHONECHECK_|IMEI_API_|GEMINI_|GOOGLE_API_KEY|OPENAI_API_KEY|MOONSHOT_API_KEY|KIMI_API_KEY|VISION_|PRO_ONLY|GRADEIQ_|GIQ_AUTH_MODE|KEYCLOAK_)/.test(k)) delete process.env[k];
}
if (process.env.NODE_ENV === "development") delete process.env.NODE_ENV;
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
const displayRoute = await import("../app/api/sessions/[id]/display/route.ts");
const { getSession } = await import("./db.ts");

const BASE = "http://localhost:3700";

function inRequest(fn) {
  const cookies = new RequestCookies(new Headers({}));
  return workAsyncStorage.run({ route: "/api/test", forceStatic: false, dynamicShouldError: false }, () =>
    workUnitAsyncStorage.run({ type: "request", phase: "render", cookies }, fn)
  );
}

async function newSession() {
  const r = await inRequest(() =>
    sessionsRoute.POST(
      new Request(`${BASE}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client: "swapmore-in", channel: "retail", segment: "c2b", model: "iPhone 13" }),
      })
    )
  );
  assert.equal(r.status, 200);
  return (await r.json()).id;
}

function postDisplay(id, body) {
  return inRequest(() =>
    displayRoute.POST(
      new Request(`${BASE}/api/sessions/${id}/display`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) }
    )
  );
}

const REQUESTED = ["white", "black", "stripes", "red", "green", "blue"];

console.log("POST /api/sessions/[id]/display keeps the sweep's numbers");

await t("the locked white and each miss are stored, cleaned, on displayCheck.sweepStats", async () => {
  const id = await newSession();
  const r = await postDisplay(id, {
    captures: [],
    requested: REQUESTED,
    reason: "the screen never displayed a verifiable test pattern",
    stats: {
      white: { r: 234.6, g: 236.2, b: 239.9, sd: 3.14 },
      misses: [
        { pattern: "black", attempts: 3, echoed: true, seen: { r: 110.4, g: 108.6, b: 112, sd: 6.5 } },
        { pattern: "green", attempts: 2, echoed: false, seen: null, note: "dropped" },
      ],
      anything: "else",
    },
  });
  assert.equal(r.status, 200);
  const dc = getSession(id).screen.displayCheck;
  assert.deepEqual(dc.sweepStats, {
    white: { r: 235, g: 236, b: 240, sd: 3 },
    misses: [
      { pattern: "black", attempts: 3, echoed: true, seen: { r: 110, g: 109, b: 112, sd: 7 } },
      { pattern: "green", attempts: 2, echoed: false, seen: null },
    ],
  });
  // Everything the route stored before is unchanged.
  assert.deepEqual(dc.requested, REQUESTED);
  assert.deepEqual(dc.missing, REQUESTED);
  assert.deepEqual(dc.captures, []);
  assert.equal(dc.reason, "the screen never displayed a verifiable test pattern");
});

await t("a sweep that sends no numbers (an older camera page) stores none", async () => {
  const id = await newSession();
  const r = await postDisplay(id, { captures: [], requested: REQUESTED });
  assert.equal(r.status, 200);
  const dc = getSession(id).screen.displayCheck;
  assert.equal("sweepStats" in dc, false);
  assert.deepEqual(dc.missing, REQUESTED);
});

await t("junk in place of the numbers stores none", async () => {
  const id = await newSession();
  const r = await postDisplay(id, { captures: [], requested: REQUESTED, stats: "lots" });
  assert.equal(r.status, 200);
  assert.equal("sweepStats" in getSession(id).screen.displayCheck, false);
});

console.log(`${pass} passed`);
