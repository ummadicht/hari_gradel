// SUP-263 — /cosmetic must not wipe what the camera and the phone wrote into
// `screen` while it was busy.
//
// The route read the session once, when the request began, then wrote back a
// spread of THAT copy after the upload, the capture gate and an 8-30 s vision
// call. The camera's `handoffDone`, the phone's `shown`/`shownAt` echoes and
// `connectedAt` written in between were lost — on every SwapUp session with a
// sweep, so the customer's phone never saw the camera finish.
//
// These tests pin:
//   • lib/db.ts updateScreen: the change sees the screen as stored NOW, other
//     columns land in the same statement (and can be worked out from the row
//     as it is now), and a bad call writes nothing;
//   • lib/cosmeticScreen.ts: each of the route's three writes sets only
//     `capture`, `cosmeticDone` and `angleLabels`;
//   • THROUGH THE PRODUCTION ROUTE: a write landing during the request (during
//     the upload, or during the background grade) survives the route's write —
//     the screen's fields, and the model /ocr sets from the Settings screen.
//     The photos are generated in memory — no image fixtures.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

// db.ts opens <cwd>/data/gradeiq.db — never a real database.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "giq-update-screen-")));
for (const k of Object.keys(process.env)) {
  if (/^(PHONECHECK_|IMEI_API_|GEMINI_|GOOGLE_API_KEY|OPENAI_API_KEY|MOONSHOT_API_KEY|KIMI_API_KEY|VISION_|PRO_ONLY|GRADEIQ_|GIQ_AUTH_MODE|KEYCLOAK_)/.test(k)) delete process.env[k];
}
if (process.env.NODE_ENV === "development") delete process.env.NODE_ENV;
// A dummy key, so the vision call goes through fetch — which this test holds.
process.env.GEMINI_API_KEY = "test-key";

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

// No network. The vision provider's call waits on `visionGate`, then answers
// 500 — so the grade lands as an honest stub exactly when the test says.
let visionGate = Promise.resolve();
let visionCalls = 0;
globalThis.fetch = async (url) => {
  if (/generativelanguage|:generateContent/.test(String(url))) {
    visionCalls++;
    await visionGate;
    return new Response(JSON.stringify({ error: { code: 500, message: "scripted" } }), { status: 500 });
  }
  throw new Error(`unexpected fetch ${url}`);
};

globalThis.AsyncLocalStorage ??= (await import("node:async_hooks")).AsyncLocalStorage;
const require = createRequire(import.meta.url);
const sharp = require("sharp");
const { workAsyncStorage } = require("next/dist/server/app-render/work-async-storage.external.js");
const { workUnitAsyncStorage } = require("next/dist/server/app-render/work-unit-async-storage.external.js");
const { RequestCookies } = require("next/dist/server/web/spec-extension/cookies.js");

const sessionsRoute = await import("../app/api/sessions/route.ts");
const cosmeticRoute = await import("../app/api/sessions/[id]/cosmetic/route.ts");
const screenRoute = await import("../app/api/sessions/[id]/screen/route.ts");
const { db, getSession, updateScreen } = await import("./db.ts");
const { screenAfterGrade, screenAfterHolding, screenAfterReject, modelAfterGrade } = await import("./cosmeticScreen.ts");

const BASE = "http://localhost:3700";

function inRequest(fn) {
  const cookies = new RequestCookies(new Headers({}));
  return workAsyncStorage.run({ route: "/api/test", forceStatic: false, dynamicShouldError: false }, () =>
    workUnitAsyncStorage.run({ type: "request", phase: "render", cookies }, fn)
  );
}

async function newSession(model = "iPhone 13") {
  const r = await inRequest(() =>
    sessionsRoute.POST(
      new Request(`${BASE}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client: "swapmore-in", channel: "retail", segment: "c2b", model }),
      })
    )
  );
  assert.equal(r.status, 200);
  return (await r.json()).id;
}

const setScreen = (id, screen) =>
  db.prepare("UPDATE sessions SET screen = ? WHERE id = ?").run(JSON.stringify(screen), id);

/** What the camera and the phone leave on the screen while /cosmetic works. */
const OTHERS = {
  shown: "white",
  shownAt: "2026-10-25T10:00:03.000Z",
  handoffDone: true,
  connectedAt: "2026-10-25T09:58:00.000Z",
  pattern: "idle",
};

/** POST /screen through the production handler (the camera or the phone). */
function postScreen(id, body) {
  return screenRoute.POST(
    new Request(`${BASE}/api/sessions/${id}/screen`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) }
  );
}

/**
 * POST /cosmetic with a body that streams in — `whileUploading` runs after the
 * route has read the session and before the body has arrived, which is the
 * window a real multi-megabyte upload leaves open.
 */
function postCosmetic(id, body, whileUploading = () => {}) {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  const stream = new ReadableStream({
    async pull(controller) {
      await whileUploading();
      controller.enqueue(bytes);
      controller.close();
    },
  });
  return inRequest(() =>
    cosmeticRoute.POST(
      new Request(`${BASE}/api/sessions/${id}/cosmetic`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: stream,
        duplex: "half",
      }),
      { params: Promise.resolve({ id }) }
    )
  );
}

/** Six genuinely different, sharp, framed views — made here, not fixtures. */
let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
async function sixViews() {
  const w = 480, h = 360, b = 24;
  const out = [];
  for (let n = 0; n < 6; n++) {
    const cols = Math.ceil(w / b);
    const levels = Array.from({ length: cols * Math.ceil(h / b) }, () => Math.floor(rnd() * 256));
    const raw = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = levels[Math.floor(y / b) * cols + Math.floor(x / b)];
        raw.fill(v, (y * w + x) * 3, (y * w + x) * 3 + 3);
      }
    }
    const jpg = await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 85 }).toBuffer();
    out.push(`data:image/jpeg;base64,${jpg.toString("base64")}`);
  }
  return out;
}

async function until(test, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (test()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out waiting");
}

const OK = { verdict: "ok", code: "ok", reasons: [], attempt: 0 };

console.log("updateScreen (lib/db.ts)");

await t("the change sees the screen as stored now, not a copy read earlier", async () => {
  const id = await newSession();
  const stale = getSession(id); // what the route held before its slow work
  setScreen(id, OTHERS); // …and what landed meanwhile
  let seen = null;
  const written = updateScreen(id, (cur) => {
    seen = cur;
    return screenAfterGrade(cur, OK, ["Front", "Back"]);
  });
  assert.deepEqual(stale.screen, {});
  assert.deepEqual(seen, OTHERS);
  assert.deepEqual(getSession(id).screen, written);
});

await t("other columns are written in the same statement, screen next to them", async () => {
  const id = await newSession();
  setScreen(id, OTHERS);
  updateScreen(id, screenAfterHolding, {
    photos: JSON.stringify(["/api/uploads/a.jpg"]),
    cosmetic: JSON.stringify({ refining: true, findings: [] }),
    cosmetic_grade: "B",
    model: "Apple iPhone 13",
    capture: JSON.stringify(OK),
    assessments: "[]",
  });
  const s = getSession(id);
  assert.deepEqual(s.photos, ["/api/uploads/a.jpg"]);
  assert.equal(s.cosmetic.refining, true);
  assert.equal(s.cosmetic_grade, "B");
  assert.equal(s.model, "Apple iPhone 13");
  assert.equal(s.capture.verdict, "ok");
  assert.deepEqual(s.screen, { ...OTHERS, cosmeticDone: true });
});

await t("columns can be worked out from the row as it is now (the model)", async () => {
  const id = await newSession("Unknown device (TAC 35000000)");
  db.prepare("UPDATE sessions SET model = ? WHERE id = ?").run("Apple iPhone 17 Pro Max", id); // landed meanwhile
  let seen = null;
  updateScreen(id, screenAfterHolding, (row) => {
    seen = row;
    return { model: modelAfterGrade(row.model, { make: "Apple", model: "iPhone 16 Pro Max" }), cosmetic_grade: "A" };
  });
  assert.deepEqual(seen, { model: "Apple iPhone 17 Pro Max" });
  const s = getSession(id);
  assert.equal(s.model, "Apple iPhone 17 Pro Max");
  assert.equal(s.cosmetic_grade, "A");
});

await t("a column outside the list, worked out from the row, throws and writes nothing", async () => {
  const id = await newSession();
  setScreen(id, OTHERS);
  assert.throws(() => updateScreen(id, (cur) => ({ ...cur, cosmeticDone: true }), () => ({ status: "graded" })), /not writable/);
  assert.deepEqual(getSession(id).screen, OTHERS);
});

await t("an unknown session returns null and writes nothing", async () => {
  assert.equal(updateScreen("no-such-session", (cur) => ({ ...cur, x: 1 })), null);
});

await t("a column outside the list throws before anything is written", async () => {
  const id = await newSession();
  setScreen(id, OTHERS);
  assert.throws(() => updateScreen(id, (cur) => ({ ...cur, cosmeticDone: true }), { status: "graded" }), /not writable/);
  assert.deepEqual(getSession(id).screen, OTHERS);
});

await t("an async change is refused and rolls back — there is no await inside", async () => {
  const id = await newSession();
  setScreen(id, OTHERS);
  assert.throws(() => updateScreen(id, async (cur) => ({ ...cur, cosmeticDone: true }), { cosmetic_grade: "A" }), /synchronously/);
  const s = getSession(id);
  assert.deepEqual(s.screen, OTHERS);
  assert.equal(s.cosmetic_grade, "");
});

await t("a screen column holding JSON null reads as an empty screen", async () => {
  const id = await newSession();
  db.prepare("UPDATE sessions SET screen = 'null' WHERE id = ?").run(id);
  assert.deepEqual(updateScreen(id, screenAfterHolding), { cosmeticDone: true });
});

console.log("the three /cosmetic writes (lib/cosmeticScreen.ts)");

await t("graded: capture, cosmeticDone and angleLabels set; every other field kept", () => {
  const next = screenAfterGrade({ ...OTHERS, displayCheck: { verdict: "pass" } }, OK, ["Front", "Back", "Left"]);
  assert.deepEqual(next, { ...OTHERS, displayCheck: { verdict: "pass" }, capture: OK, cosmeticDone: true, angleLabels: ["Front", "Back", "Left"] });
});

await t("graded with no labels (the Pro re-persist) keeps the stored labels", () => {
  const next = screenAfterGrade({ ...OTHERS, angleLabels: ["Front", "Back"] }, OK);
  assert.deepEqual(next.angleLabels, ["Front", "Back"]);
  assert.deepEqual(screenAfterGrade({ ...OTHERS, angleLabels: ["Front"] }, OK, []).angleLabels, ["Front"]);
});

await t("holding: only cosmeticDone is added", () => {
  assert.deepEqual(screenAfterHolding(OTHERS), { ...OTHERS, cosmeticDone: true });
});

await t("rejected: the verdict is recorded, cosmeticDone removed, handoffDone kept", () => {
  const verdict = { verdict: "retake", code: "blurry", reasons: ["soft"], attempt: 2 };
  const next = screenAfterReject({ ...OTHERS, cosmeticDone: true, angleLabels: ["Front"] }, verdict);
  assert.equal("cosmeticDone" in next, false);
  assert.equal(next.handoffDone, true);
  assert.deepEqual(next.capture, verdict);
  assert.deepEqual(next, { ...OTHERS, angleLabels: ["Front"], capture: verdict });
});

await t("modelAfterGrade: the vision's model fills only an empty or unknown model, as it is NOW", () => {
  const seen = { make: "Apple", model: "iPhone 16 Pro Max" };
  assert.equal(modelAfterGrade("", seen), "Apple iPhone 16 Pro Max");
  assert.equal(modelAfterGrade(null, seen), "Apple iPhone 16 Pro Max");
  assert.equal(modelAfterGrade("Unknown device (TAC 35000000)", seen), "Apple iPhone 16 Pro Max");
  assert.equal(modelAfterGrade("unknown", { model: "Galaxy S24" }), "Galaxy S24");
  // A model already there — typed, from the IMEI, or from /ocr — is never replaced.
  assert.equal(modelAfterGrade("Apple iPhone 17 Pro Max", seen), "Apple iPhone 17 Pro Max");
  // Nothing identified → the model stays as it is.
  assert.equal(modelAfterGrade("Unknown device (TAC 35000000)", null), "Unknown device (TAC 35000000)");
  assert.equal(modelAfterGrade("Unknown device (TAC 35000000)", { make: "Apple", model: "" }), "Unknown device (TAC 35000000)");
  assert.equal(modelAfterGrade("", undefined), "");
});

await t("the helpers never change the screen they were handed", () => {
  const cur = { ...OTHERS, cosmeticDone: true };
  const copy = structuredClone(cur);
  screenAfterGrade(cur, OK, ["Front"]);
  screenAfterHolding(cur);
  screenAfterReject(cur, { verdict: "retake" });
  assert.deepEqual(cur, copy);
});

console.log("through POST /api/sessions/[id]/cosmetic");

await t("rejected set: an echo and handoffDone written during the upload survive", async () => {
  const id = await newSession();
  setScreen(id, { connectedAt: OTHERS.connectedAt, cosmeticDone: true });
  // No photos and nothing staged → the capture gate rejects (422).
  const r = await postCosmetic(id, { photos: [] }, async () => {
    await postScreen(id, { shown: "white" });
    await postScreen(id, { handoffDone: true });
  });
  assert.equal(r.status, 422);
  const s = getSession(id);
  assert.equal(s.screen.shown, "white");
  assert.ok(s.screen.shownAt);
  assert.equal(s.screen.handoffDone, true);
  assert.equal(s.screen.connectedAt, OTHERS.connectedAt);
  assert.equal("cosmeticDone" in s.screen, false);
  assert.equal(s.screen.capture.verdict, "retake");
  assert.equal(s.capture.verdict, "retake");
});

await t("background grade: handoffDone and the echoes posted before the grade lands are kept", async () => {
  const id = await newSession();
  await postScreen(id, { connected: true });
  const photos = await sixViews();
  let release;
  visionGate = new Promise((r) => (release = r));
  const before = visionCalls;

  // The upload: the phone echoes white while the bytes are still arriving.
  const r = await postCosmetic(
    id,
    { photos, background: true, angleLabels: ["Front", "Back", "Left", "Right", "Top", "Bottom"] },
    () => postScreen(id, { shown: "white" })
  );
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  const body = await r.json();
  assert.equal(body.background, true);
  // The holding write kept the echo and the check-in.
  let s = getSession(id);
  assert.equal(s.screen.cosmeticDone, true);
  assert.equal(s.screen.shown, "white");
  assert.ok(s.screen.connectedAt);
  assert.equal(s.cosmetic.refining, true);

  // The grade is still out; the camera finishes and the phone goes idle.
  await until(() => visionCalls > before);
  await postScreen(id, { cosmeticDone: true, handoffDone: true, pattern: "idle" });
  await postScreen(id, { shown: "idle" });
  const shownAt = getSession(id).screen.shownAt;
  release();

  // The background grade lands (an honest stub: the provider answered 500).
  await until(() => getSession(id).cosmetic.tierUsed === "stub");
  s = getSession(id);
  assert.equal(s.screen.handoffDone, true, "handoffDone must survive the background grade");
  assert.equal(s.screen.shown, "idle");
  assert.equal(s.screen.shownAt, shownAt);
  assert.equal(s.screen.pattern, "idle");
  assert.ok(s.screen.connectedAt);
  assert.equal(s.screen.cosmeticDone, true);
  assert.deepEqual(s.screen.angleLabels, ["Front", "Back", "Left", "Right", "Top", "Bottom"]);
  assert.equal(s.screen.capture.verdict, "ok");
  assert.equal(s.capture.verdict, "ok");
  // GET /screen — what SwapUp and the phone poll — says the camera is done.
  const poll = await (await screenRoute.GET(new Request(`${BASE}/api/sessions/${id}/screen`), { params: Promise.resolve({ id }) })).json();
  assert.equal(poll.handoffDone, true);
  assert.equal(poll.cosmeticDone, true);
});

await t("background grade: a model /ocr wrote while the grade was out is not put back to the stale one", async () => {
  // No IMEI could name the phone; the advisor then photographs Settings and
  // /ocr names it while the background grade is still out.
  const id = await newSession("Unknown device (TAC 35000000)");
  const photos = await sixViews();
  let release;
  visionGate = new Promise((r) => (release = r));
  const before = visionCalls;
  const r = await postCosmetic(id, { photos, background: true, angleLabels: ["Front", "Back", "Left", "Right", "Top", "Bottom"] });
  assert.equal(r.status, 200);
  await until(() => visionCalls > before);
  // What /ocr's write does to the model column (app/api/sessions/[id]/ocr/route.ts).
  db.prepare("UPDATE sessions SET model = ?, updated_at = datetime('now') WHERE id = ?").run("Apple iPhone 17 Pro Max", id);
  release();
  await until(() => getSession(id).cosmetic.tierUsed === "stub");
  assert.equal(getSession(id).model, "Apple iPhone 17 Pro Max", "the grade must not write back the model it read before the vision call");
});

await t("background grade: with nothing else writing it, the model is left exactly as it was", async () => {
  const id = await newSession("Unknown device (TAC 35000001)");
  const photos = await sixViews();
  visionGate = Promise.resolve();
  const r = await postCosmetic(id, { photos, background: true });
  assert.equal(r.status, 200);
  await until(() => getSession(id).cosmetic.tierUsed === "stub");
  assert.equal(getSession(id).model, "Unknown device (TAC 35000001)");
});

console.log(`${pass} passed`);
