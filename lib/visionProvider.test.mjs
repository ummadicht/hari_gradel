// Vision-provider failure handling.
//
// Written against the 2026-10-18 Pro outage: gemini-3.1-pro-preview answered
// 503 "high demand" for 11+ hours while Flash was healthy. The provider filed
// every one of those as "bad_response", retried nothing, and made each caller
// wait 4–8 s for a failure it could have known about in advance. These tests
// pin the three behaviours that replace that: a 5xx is "unavailable", it gets
// exactly one retry, and a model that keeps failing is skipped without a call.
//
// No network: global fetch is replaced by a scripted fake that records which
// model each request was for.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// settings.ts opens <cwd>/data/gradeiq.db. Run from a throwaway directory, so
// this file can never write a setting into a real database — on the VM, cwd
// ~/gradeiq would be PRODUCTION, and these tests set gemini_model_pro.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "giq-vision-test-")));

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

const PHOTO = "data:image/jpeg;base64,AAAA";
const OK_BODY = { candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] };

/** Script the fake: `plan[model]` is a list of statuses served in order (last one repeats). */
let calls = [];
function fakeFetch(plan) {
  calls = [];
  globalThis.fetch = async (url) => {
    const model = /models\/([^:]+):generateContent/.exec(String(url))?.[1] ?? "?";
    calls.push(model);
    const seq = plan[model] ?? [200];
    const status = seq.length > 1 ? seq.shift() : seq[0];
    const body = status === 200 ? OK_BODY : { error: { code: status, status: "UNAVAILABLE", message: "high demand" } };
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
}

/** Breaker state is process-wide; give every test a clean slate. */
const reset = () => globalThis.__gradeiq_vision_breakers?.clear();

// Only a Gemini key, exactly like production — the host's own environment must
// not add providers to the fallback order or flip a mode under the test.
for (const k of ["OPENAI_API_KEY", "MOONSHOT_API_KEY", "KIMI_API_KEY", "GOOGLE_API_KEY", "VISION_PROVIDER", "PRO_ONLY", "VISION_SCHEMA", "GEMINI_MODEL_PRO", "GEMINI_MODEL_FLASH", "GEMINI_MODEL_FLASH_FALLBACK", "VISION_TIMEOUT_MS"]) delete process.env[k];
process.env.GEMINI_API_KEY = "test-key";
const { visionJSON, unavailableModels } = await import("./visionProvider.ts");
const { setSetting } = await import("./settings.ts");
const PRO = "gemini-3.1-pro-preview";
const FLASH = "gemini-3.6-flash";
const FLASH_FB = "gemini-2.5-flash";

await t("a 503 is 'unavailable', not 'bad_response'", async () => {
  reset();
  fakeFetch({ [PRO]: [503] });
  const out = await visionJSON("p", [PHOTO], "pro", undefined, null);
  assert.equal(out.json, null);
  assert.equal(out.error, "unavailable");
});

await t("a transient 503 gets exactly one retry, and a good retry is returned", async () => {
  reset();
  fakeFetch({ [PRO]: [503, 200] });
  const out = await visionJSON("p", [PHOTO], "pro", undefined, null);
  assert.deepEqual(out.json, { ok: true });
  assert.equal(out.model, PRO);
  assert.deepEqual(calls, [PRO, PRO]);
});

await t("a recovered model is not left marked unavailable", async () => {
  // Continues from the previous test's state: one 503, then a success.
  assert.deepEqual(unavailableModels(), []);
});

await t("ONE unlucky request (503, retry 503) does not open the breaker", async () => {
  reset();
  fakeFetch({ [PRO]: [503] });
  await visionJSON("p", [PHOTO], "pro", undefined, null);
  assert.equal(calls.length, 2, "first attempt + one retry");
  assert.deepEqual(unavailableModels(), [], "a single request is not an outage");
});

await t("two separate overloaded requests open the breaker; the next call makes NO request", async () => {
  reset();
  fakeFetch({ [PRO]: [503] });
  await visionJSON("p", [PHOTO], "pro", undefined, null);
  await visionJSON("p", [PHOTO], "pro", undefined, null); // second request → trips
  assert.equal(calls.length, 4);
  assert.equal(unavailableModels().length, 1);
  assert.equal(unavailableModels()[0].model, `gemini:${PRO}`);

  calls = [];
  const t0 = Date.now();
  const out = await visionJSON("p", [PHOTO], "pro", undefined, null);
  assert.equal(out.error, "unavailable");
  assert.equal(calls.length, 0, "an open breaker must not call the provider");
  assert.ok(Date.now() - t0 < 50, "and must fail fast");
});

await t("an open Pro breaker does not touch Flash", async () => {
  // Pro is still tripped from the previous test.
  fakeFetch({ [FLASH]: [200] });
  const out = await visionJSON("p", [PHOTO], "flash", undefined, null);
  assert.deepEqual(out.json, { ok: true });
  assert.equal(out.model, FLASH);
  assert.deepEqual(calls, [FLASH]);
});

await t("after the cool-down one probe goes through, and success closes the breaker", async () => {
  // Pro is still tripped. Jump the clock past the cool-down.
  const realNow = Date.now;
  Date.now = () => realNow() + 2 * 60_000;
  try {
    fakeFetch({ [PRO]: [200] });
    const out = await visionJSON("p", [PHOTO], "pro", undefined, null);
    assert.deepEqual(out.json, { ok: true });
    assert.deepEqual(calls, [PRO]);
    assert.deepEqual(unavailableModels(), []);
  } finally {
    Date.now = realNow;
  }
});

await t("a failed probe re-opens the breaker immediately (no second wasted call)", async () => {
  reset();
  fakeFetch({ [PRO]: [503] });
  await visionJSON("p", [PHOTO], "pro", undefined, null);
  await visionJSON("p", [PHOTO], "pro", undefined, null); // trips
  const realNow = Date.now;
  Date.now = () => realNow() + 2 * 60_000;
  try {
    calls = [];
    const out = await visionJSON("p", [PHOTO], "pro", undefined, null);
    assert.equal(out.error, "unavailable");
    assert.deepEqual(calls, [PRO], "one probe, no retry once the breaker re-opens");
    assert.equal(unavailableModels().length, 1);
  } finally {
    Date.now = realNow;
  }
});

await t("Flash is never skipped: back-to-back 503s on Flash do not block the next capture", async () => {
  reset();
  fakeFetch({ [FLASH]: [503, 503, 200], [FLASH_FB]: [503] });
  const first = await visionJSON("p", [PHOTO], "flash", undefined, null); // 503 + retry 503, fallback the same
  assert.equal(first.error, "unavailable");
  assert.deepEqual(unavailableModels(), [], "no breaker on the floor tier");
  const second = await visionJSON("p", [PHOTO], "flash", undefined, null);
  assert.deepEqual(second.json, { ok: true }, "the next capture still tries — and grades");
  assert.equal(second.model, FLASH);
  assert.deepEqual(calls, [FLASH, FLASH, FLASH_FB, FLASH_FB, FLASH]);
});

await t("a 500/504 is retried but never trips the breaker — one bad request must not shut Pro off for everyone", async () => {
  reset();
  fakeFetch({ [PRO]: [500, 504] });
  const out = await visionJSON("p", [PHOTO], "pro", undefined, null);
  assert.equal(out.error, "unavailable");
  assert.equal(calls.length, 2, "retried once");
  assert.deepEqual(unavailableModels(), []);
});

await t("pro_only: Pro is the floor, so it is never skipped even after an outage-shaped run", async () => {
  reset();
  setSetting("pro_only", "true");
  try {
    fakeFetch({ [PRO]: [503, 503, 503, 503, 200] });
    await visionJSON("p", [PHOTO], "pro", undefined, null);
    await visionJSON("p", [PHOTO], "pro", undefined, null);
    assert.deepEqual(unavailableModels(), [], "no breaker while pro_only is on");
    const out = await visionJSON("p", [PHOTO], "pro", undefined, null);
    assert.deepEqual(out.json, { ok: true }, "the next capture still reaches Pro");
  } finally {
    setSetting("pro_only", "false");
  }
});

await t("the selected provider's error is reported, not a later fallback's", async () => {
  reset();
  process.env.OPENAI_API_KEY = "test-openai";
  try {
    calls = [];
    globalThis.fetch = async (url) => {
      const u = String(url);
      calls.push(u.includes("openai") ? "openai" : "gemini");
      return u.includes("openai")
        ? new Response(JSON.stringify({ error: { message: "no credit" } }), { status: 429 })
        : new Response(JSON.stringify({ error: { message: "high demand" } }), { status: 503 });
    };
    const out = await visionJSON("p", [PHOTO], "pro", undefined, null);
    assert.equal(out.error, "unavailable", "Gemini (selected) was overloaded — that is the story, not OpenAI's quota");
    assert.ok(calls.includes("openai"), "the fallback was still tried");
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
});

await t("a call that never answers ends as 'timeout' within its budget, and is not retried", async () => {
  reset();
  process.env.VISION_TIMEOUT_MS = "150";
  // AbortSignal.timeout's timer is unref'd, so with nothing else pending Node
  // would simply exit mid-test. A server always has something pending.
  const keepAlive = setInterval(() => {}, 50);
  try {
    calls = [];
    globalThis.fetch = (url, init) => {
      calls.push("hang");
      // Never answers — only the caller's AbortSignal can end it.
      return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
    };
    const t0 = Date.now();
    const out = await visionJSON("p", [PHOTO], "pro", undefined, null);
    assert.equal(out.error, "timeout");
    assert.ok(Date.now() - t0 < 1500, `bounded (took ${Date.now() - t0} ms)`);
    assert.equal(calls.length, 1, "a spent budget is not spent twice");
    assert.deepEqual(unavailableModels(), []);
  } finally {
    clearInterval(keepAlive);
    delete process.env.VISION_TIMEOUT_MS;
  }
});

await t("a Pro timeout is an overload strike: a hang after a trip keeps the breaker OPEN, and hangs alone trip it", async () => {
  reset();
  process.env.VISION_TIMEOUT_MS = "100";
  const keepAlive = setInterval(() => {}, 50);
  const hang = (url, init) =>
    new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
  const realNow = Date.now;
  try {
    // (a) trip on 503s, then the probe HANGS: must stay open, not reset.
    fakeFetch({ [PRO]: [503] });
    await visionJSON("p", [PHOTO], "pro", undefined, null);
    await visionJSON("p", [PHOTO], "pro", undefined, null);
    assert.equal(unavailableModels().length, 1);
    Date.now = () => realNow() + 2 * 60_000;
    globalThis.fetch = hang;
    assert.equal((await visionJSON("p", [PHOTO], "pro", undefined, null)).error, "timeout");
    assert.equal(unavailableModels().length, 1, "a hung probe is not proof of recovery");
    Date.now = realNow;

    // (b) two hanging requests alone open it.
    reset();
    globalThis.fetch = hang;
    await visionJSON("p", [PHOTO], "pro", undefined, null);
    await visionJSON("p", [PHOTO], "pro", undefined, null);
    assert.equal(unavailableModels().length, 1);

    // (c) Flash hangs never touch any breaker.
    reset();
    await visionJSON("p", [PHOTO], "flash", undefined, null);
    await visionJSON("p", [PHOTO], "flash", undefined, null);
    assert.deepEqual(unavailableModels(), []);
  } finally {
    Date.now = realNow;
    clearInterval(keepAlive);
    delete process.env.VISION_TIMEOUT_MS;
  }
});

await t("half-open is single-flight: while the probe is out, other Pro calls skip at once", async () => {
  reset();
  process.env.VISION_TIMEOUT_MS = "200";
  const keepAlive = setInterval(() => {}, 50);
  const realNow = Date.now;
  try {
    fakeFetch({ [PRO]: [503] });
    await visionJSON("p", [PHOTO], "pro", undefined, null);
    await visionJSON("p", [PHOTO], "pro", undefined, null); // tripped
    const base = realNow() + 2 * 60_000;
    Date.now = () => base; // frozen just past the cool-down
    calls = [];
    globalThis.fetch = (url, init) => {
      calls.push("probe");
      return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
    };
    const probe = visionJSON("p", [PHOTO], "pro", undefined, null); // becomes the probe, hangs
    await new Promise((r) => setTimeout(r, 20));
    const t0 = realNow();
    const other = await visionJSON("p", [PHOTO], "pro", undefined, null);
    assert.equal(other.error, "unavailable");
    assert.ok(realNow() - t0 < 50, "the second caller did not wait for the hang");
    assert.equal((await probe).error, "timeout");
    assert.deepEqual(calls, ["probe"], "exactly one request reached the model");
    assert.equal(unavailableModels().length, 1, "the hung probe re-opens the breaker");
  } finally {
    Date.now = realNow;
    clearInterval(keepAlive);
    delete process.env.VISION_TIMEOUT_MS;
  }
});

await t("a 429 is 'quota': no retry and no breaker trip", async () => {
  reset();
  fakeFetch({ [PRO]: [429] });
  const out = await visionJSON("p", [PHOTO], "pro", undefined, null);
  assert.equal(out.error, "quota");
  assert.deepEqual(calls, [PRO]);
  await visionJSON("p", [PHOTO], "pro", undefined, null);
  assert.deepEqual(unavailableModels(), []);
});

await t("401/403 stay 'auth', 400 stays 'bad_response', 404 is 'model_gone'", async () => {
  reset();
  fakeFetch({ [PRO]: [403] });
  assert.equal((await visionJSON("p", [PHOTO], "pro", undefined, null)).error, "auth");
  fakeFetch({ [PRO]: [400] });
  assert.equal((await visionJSON("p", [PHOTO], "pro", undefined, null)).error, "bad_response");
  assert.equal(calls.length, 1, "a 4xx is not retried");
  fakeFetch({ [PRO]: [404] });
  assert.equal((await visionJSON("p", [PHOTO], "pro", undefined, null)).error, "model_gone");
  assert.equal(calls.length, 1, "a retired model is not retried");
  assert.deepEqual(unavailableModels(), [], "and does not trip the breaker");
});

await t("a network error is retried once but never trips the breaker", async () => {
  reset();
  calls = [];
  globalThis.fetch = async () => {
    calls.push("x");
    throw new TypeError("fetch failed");
  };
  const out = await visionJSON("p", [PHOTO], "pro", undefined, null);
  assert.equal(out.error, "network");
  assert.equal(calls.length, 2);
  assert.deepEqual(unavailableModels(), []);
});

await t("gemini_model_pro in settings swaps the Pro model without a deploy", async () => {
  reset();
  setSetting("gemini_model_pro", "gemini-test-pro");
  try {
    fakeFetch({ "gemini-test-pro": [200] });
    const out = await visionJSON("p", [PHOTO], "pro", undefined, null);
    assert.equal(out.model, "gemini-test-pro");
    assert.deepEqual(calls, ["gemini-test-pro"]);
  } finally {
    setSetting("gemini_model_pro", ""); // throwaway DB (see the chdir at the top)
  }
  fakeFetch({ [PRO]: [200] });
  assert.equal((await visionJSON("p", [PHOTO], "pro", undefined, null)).model, PRO, "unset → pinned default");
});

// ---- Flash fallback chain ----

await t("Flash down (503, retry 503) → ONE fallback model answers, and `model` says which", async () => {
  reset();
  fakeFetch({ [FLASH]: [503], [FLASH_FB]: [200] });
  const out = await visionJSON("p", [PHOTO], "flash", undefined, null);
  assert.deepEqual(out.json, { ok: true });
  assert.equal(out.provider, "gemini");
  assert.equal(out.model, FLASH_FB);
  assert.deepEqual(calls, [FLASH, FLASH, FLASH_FB]);
});

await t("Flash hung (timeout, not retried) → the fallback answers", async () => {
  reset();
  process.env.VISION_TIMEOUT_MS = "100";
  const keepAlive = setInterval(() => {}, 50);
  try {
    calls = [];
    globalThis.fetch = (url, init) => {
      const model = /models\/([^:]+):generateContent/.exec(String(url))?.[1] ?? "?";
      calls.push(model);
      if (model === FLASH_FB) return Promise.resolve(new Response(JSON.stringify(OK_BODY), { status: 200 }));
      return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
    };
    const out = await visionJSON("p", [PHOTO], "flash", undefined, null);
    assert.equal(out.model, FLASH_FB);
    assert.deepEqual(calls, [FLASH, FLASH_FB]);
  } finally {
    clearInterval(keepAlive);
    delete process.env.VISION_TIMEOUT_MS;
  }
});

await t("a forced Gemini Flash call takes the fallback too (still Gemini, honestly attributed)", async () => {
  reset();
  fakeFetch({ [FLASH]: [503], [FLASH_FB]: [200] });
  const out = await visionJSON("p", [PHOTO], "flash", "gemini", null);
  assert.equal(out.model, FLASH_FB);
});

await t("both down → the PRIMARY's error is reported, and the chain stops at one fallback", async () => {
  reset();
  fakeFetch({ [FLASH]: [503], [FLASH_FB]: [404] });
  const out = await visionJSON("p", [PHOTO], "flash", undefined, null);
  assert.equal(out.json, null);
  assert.equal(out.error, "unavailable", "Flash was overloaded — not the fallback's 404");
  assert.deepEqual(calls, [FLASH, FLASH, FLASH_FB]);
});

await t("only unavailable/timeout fall back: quota, auth, a retired model and a bad answer do not", async () => {
  for (const status of [429, 403, 404, 400]) {
    reset();
    fakeFetch({ [FLASH]: [status], [FLASH_FB]: [200] });
    await visionJSON("p", [PHOTO], "flash", undefined, null);
    assert.deepEqual(calls, [FLASH], `HTTP ${status}`);
  }
});

await t("primary == fallback (production: gemini_model_flash=gemini-2.5-flash) → no second model", async () => {
  reset();
  setSetting("gemini_model_flash", FLASH_FB);
  try {
    fakeFetch({ [FLASH_FB]: [503] });
    const out = await visionJSON("p", [PHOTO], "flash", undefined, null);
    assert.equal(out.error, "unavailable");
    assert.deepEqual(calls, [FLASH_FB, FLASH_FB], "its own retry only");
  } finally {
    setSetting("gemini_model_flash", "");
  }
});

await t("gemini_model_flash_fallback swaps the fallback; with primary 2.5-flash the chain still works", async () => {
  reset();
  setSetting("gemini_model_flash", FLASH_FB);
  setSetting("gemini_model_flash_fallback", "gemini-test-flash-fb");
  try {
    fakeFetch({ [FLASH_FB]: [503], "gemini-test-flash-fb": [200] });
    const out = await visionJSON("p", [PHOTO], "flash", undefined, null);
    assert.equal(out.model, "gemini-test-flash-fb");
    assert.deepEqual(calls, [FLASH_FB, FLASH_FB, "gemini-test-flash-fb"]);
  } finally {
    setSetting("gemini_model_flash", "");
    setSetting("gemini_model_flash_fallback", "");
  }
});

await t("Pro is unchanged: a Pro outage never calls the Flash fallback model", async () => {
  reset();
  fakeFetch({ [PRO]: [503], [FLASH_FB]: [200] });
  const out = await visionJSON("p", [PHOTO], "pro", undefined, null);
  assert.equal(out.error, "unavailable");
  assert.deepEqual(calls, [PRO, PRO]);
});

console.log(`\n${pass} passed${process.exitCode ? " — FAILURES above" : ""}`);
