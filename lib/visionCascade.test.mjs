// The cascade must say WHY nothing graded.
//
// Through the 2026-10-18 Pro outage every ungraded capture's note read "Stub
// cascade (no working vision key)" — the key was fine; Google was answering
// 503. That sent people hunting for a key problem that did not exist. These
// tests pin the reason end to end: provider error → VisionPass → result.
//
// No network: global fetch is scripted per model.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// settings.ts opens <cwd>/data/gradeiq.db and one test flips pro_only. Run in a
// throwaway directory so this can never touch a real (let alone production)
// database, whatever directory it is launched from.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "giq-cascade-test-")));

for (const k of ["OPENAI_API_KEY", "MOONSHOT_API_KEY", "KIMI_API_KEY", "GOOGLE_API_KEY", "VISION_PROVIDER", "PRO_ONLY", "VISION_SCHEMA", "GEMINI_MODEL_PRO", "GEMINI_MODEL_FLASH", "GEMINI_MODEL_FLASH_FALLBACK", "VISION_TIMEOUT_MS"]) delete process.env[k];
process.env.GEMINI_API_KEY = "test-key";
const { runVisionCascade } = await import("./visionAgents.ts");

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

const PHOTOS = Array.from({ length: 6 }, () => "data:image/jpeg;base64,AAAA");
const reset = () => globalThis.__gradeiq_vision_breakers?.clear();

/** `byModel[model]` = HTTP status, or a JSON body to answer 200 with. */
function fakeFetch(byModel) {
  globalThis.fetch = async (url) => {
    const model = /models\/([^:]+):generateContent/.exec(String(url))?.[1] ?? "?";
    const r = byModel[model] ?? 500;
    if (typeof r === "number") {
      return new Response(JSON.stringify({ error: { code: r, message: "scripted" } }), { status: r });
    }
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(r) }] } }] }), { status: 200 });
  };
}

await t("Pro 503 → ungraded, visionError 'unavailable', note blames the provider not the key", async () => {
  reset();
  fakeFetch({ "gemini-3.1-pro-preview": 503 });
  const r = await runVisionCascade(PHOTOS, "Apple iPhone 15 Pro", { forceTier: "pro" });
  assert.equal(r.tierUsed, "stub");
  assert.equal(r.grade, "");
  assert.equal(r.visionError, "unavailable");
  assert.match(r.notes, /overloaded/);
  assert.doesNotMatch(r.notes, /no working vision key/);
});

await t("a retired model (404) is named as such", async () => {
  reset();
  fakeFetch({ "gemini-3.1-pro-preview": 404 });
  const r = await runVisionCascade(PHOTOS, "", { forceTier: "pro" });
  assert.equal(r.visionError, "model_gone");
  assert.match(r.notes, /retired/);
});

await t("a 200 with no inspection in it is an unusable answer, not an outage", async () => {
  reset();
  fakeFetch({ "gemini-3.6-flash": { hello: "world" } });
  const r = await runVisionCascade(PHOTOS, "", { forceTier: "flash" });
  assert.equal(r.tierUsed, "stub");
  assert.equal(r.visionError, "bad_response");
});

await t("no key at all still says so", async () => {
  reset();
  const saved = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    const r = await runVisionCascade(PHOTOS, "", { forceTier: "flash" });
    assert.equal(r.visionError, "no_key");
    assert.match(r.notes, /no working vision key/);
  } finally {
    process.env.GEMINI_API_KEY = saved;
  }
});

await t("when a model answers, visionError is null and the tier is the one that answered", async () => {
  reset();
  fakeFetch({ "gemini-3.6-flash": { components: {} } });
  const r = await runVisionCascade(PHOTOS, "", { forceTier: "flash" });
  assert.equal(r.tierUsed, "flash");
  assert.equal(r.visionError, null);
  assert.equal(r.visionModel, "gemini-3.6-flash");
});

await t("Flash down → the cascade grades on the fallback model and records it", async () => {
  reset();
  fakeFetch({ "gemini-3.6-flash": 503, "gemini-2.5-flash": { components: {} } });
  const r = await runVisionCascade(PHOTOS, "", { forceTier: "flash" });
  assert.equal(r.tierUsed, "flash");
  assert.equal(r.visionError, null);
  assert.equal(r.visionModel, "gemini-2.5-flash");
});

await t("pro_only still turns a requested Flash pass into Pro, and still fails hard when Pro is down", async () => {
  reset();
  const { setSetting } = await import("./settings.ts");
  setSetting("pro_only", "true");
  try {
    fakeFetch({ "gemini-3.1-pro-preview": 503, "gemini-3.6-flash": { components: {} } });
    const r = await runVisionCascade(PHOTOS, "", { forceTier: "flash" });
    assert.equal(r.tierUsed, "stub", "no Flash answer may stand in when pro_only is on");
    assert.equal(r.visionError, "unavailable");
  } finally {
    setSetting("pro_only", "false");
  }
});

console.log(`\n${pass} passed${process.exitCode ? " — FAILURES above" : ""}`);
