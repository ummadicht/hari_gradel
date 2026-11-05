// SUP-86 — GET /api/sessions/[id] carries the trust score CounterIQ prices on,
// and keeps the promise written down in contracts/grade-result.ts.
//
// CounterIQ reads `trust` off this response to hedge its buy offer (6% lower
// below 70). The field was never there, so every offer priced as fully trusted.
// These tests run the PRODUCTION handler and pin:
//   • `trust` is computeTrust(s).score — an integer 0..100, the same number the
//     /trust route reports — on both sides of CounterIQ's 70 line;
//   • nothing that was in the response before is renamed, dropped or changed;
//   • the response conforms to grade-result/1 and says so in a header.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "giq-grade-result-")));
for (const k of Object.keys(process.env)) {
  if (/^(PHONECHECK_|IMEI_API_|GEMINI_|GOOGLE_API_KEY|GRADEIQ_|GIQ_AUTH_MODE|KEYCLOAK_)/.test(k)) delete process.env[k];
}
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

const sessionRoute = await import("../app/api/sessions/[id]/route.ts");
const trustRoute = await import("../app/api/sessions/[id]/trust/route.ts");
const { db, getSession } = await import("./db.ts");
const { checkIdentity } = await import("./identity.ts");
const { computeTrust } = await import("./trust.ts");
const contract = await import("../contracts/grade-result.ts");

const BASE = "http://localhost:3700";
const get = (id) => sessionRoute.GET(new Request(`${BASE}/api/sessions/${id}`), { params: Promise.resolve({ id }) });
const PASS_ALL = { touch: "pass", speaker: "pass", mic: "pass", camera: "pass", wifi: "pass", buttons: "pass" };

function seed(id, { grade, functional, model = "iPhone 13", imei = "356938035643809" }) {
  db.prepare(
    `INSERT INTO sessions (id, imei, model, status, functional, cosmetic, functional_grade, cosmetic_grade, overall_grade, client_id, imei_info)
     VALUES (?, ?, ?, 'graded', ?, ?, ?, ?, ?, 'swapmore-in', ?)`
  ).run(
    id,
    imei,
    model,
    JSON.stringify(functional),
    JSON.stringify({ grade, conclusive: true, confidence: 0.92, source: "gemini", tierUsed: "pro", findings: [] }),
    Object.values(functional).includes("fail") ? "Faulty" : "Working",
    grade,
    grade,
    JSON.stringify({ imei, valid: true, brand: "Apple", model, source: "gsma", blacklist: "clean" })
  );
}
seed("gr-high", { grade: "A", functional: PASS_ALL });
seed("gr-low", { grade: "D", functional: { touch: "fail", speaker: "fail", mic: "fail", camera: "pass", wifi: "pass", buttons: "fail" } });

console.log("grade result — trust on GET /api/sessions/[id]");

await t("trust is an integer 0..100 equal to computeTrust(s).score", async () => {
  for (const id of ["gr-high", "gr-low"]) {
    const body = await (await get(id)).json();
    assert.equal(typeof body.trust, "number");
    assert.ok(Number.isInteger(body.trust) && body.trust >= 0 && body.trust <= 100, String(body.trust));
    assert.equal(body.trust, computeTrust(getSession(id)).score);
  }
});

await t("…the same number the /trust route reports", async () => {
  for (const id of ["gr-high", "gr-low"]) {
    const viaSession = (await (await get(id)).json()).trust;
    const viaTrust = (await (await trustRoute.GET(new Request(`${BASE}/api/sessions/${id}/trust`), { params: Promise.resolve({ id }) })).json()).trust.score;
    assert.equal(viaSession, viaTrust);
  }
});

await t("both sides of CounterIQ's 70 line reach it: a clean A is ≥ 70, a faulty D is < 70", async () => {
  const high = (await (await get("gr-high")).json()).trust;
  const low = (await (await get("gr-low")).json()).trust;
  assert.ok(high >= 70, `A: ${high}`);
  assert.ok(low < 70, `D: ${low}`);
});

await t("nothing that was in the response is renamed, dropped or changed (trust and refine are only added)", async () => {
  for (const id of ["gr-high", "gr-low"]) {
    const s = getSession(id);
    const before = JSON.parse(JSON.stringify({ ...s, identity: checkIdentity(s) })); // the response as it was
    const now = await (await get(id)).json();
    for (const k of Object.keys(before)) assert.deepEqual(now[k], before[k], k);
    // `refine` is SUP-63's read-only "still grading / did not finish" (lib/refineStatus.test.mjs).
    assert.deepEqual(Object.keys(now).filter((k) => !(k in before)), ["trust", "refine"]);
    assert.equal(now.refine.state, "none");
  }
});

await t("an unknown session is still a plain 404", async () => {
  const r = await get("no-such-session");
  assert.equal(r.status, 404);
  assert.deepEqual(await r.json(), { error: "not found" });
});

console.log("grade result — contracts/grade-result.ts");

await t("the live response conforms to grade-result/1 and names it in a header", async () => {
  for (const id of ["gr-high", "gr-low"]) {
    const r = await get(id);
    assert.equal(r.headers.get(contract.GRADE_RESULT_HEADER), "grade-result/1");
    assert.deepEqual(contract.gradeResultProblems(await r.json()), []);
  }
});

await t("a brand-new session (no grade, no IMEI, nothing connected) conforms too", async () => {
  db.prepare("INSERT INTO sessions (id, client_id) VALUES ('gr-empty', 'default')").run();
  const body = await (await get("gr-empty")).json();
  assert.deepEqual(contract.gradeResultProblems(body), []);
  assert.equal(body.identity.connected, null);
});

await t("every field the JSON Schema requires is present in the response", async () => {
  const body = await (await get("gr-high")).json();
  for (const k of contract.gradeResultSchemaV1.required) assert.ok(k in body, k);
  for (const k of contract.gradeResultSchemaV1.properties.identity.required) assert.ok(k in body.identity, `identity.${k}`);
});

await t("the checker catches a rename, a retype and an out-of-range trust", () => {
  const good = { id: "x", client_id: "c", imei: "", model: "", status: "open", cosmetic_grade: "", functional_grade: "", overall_grade: "", functional: {}, photos: [], cosmetic: {}, screen: {}, capture: {}, identity: { verdict: "unverified", flags: [], modelLevel: false, imei: { brand: "", model: "" }, connected: null }, trust: 70 };
  assert.deepEqual(contract.gradeResultProblems(good), []);
  const { overall_grade, ...renamed } = good;
  assert.deepEqual(contract.gradeResultProblems({ ...renamed, overallGrade: overall_grade }), ["overall_grade: not a string"]);
  assert.deepEqual(contract.gradeResultProblems({ ...good, trust: "70" }), ["trust: 70 is not an integer 0..100 or null"]);
  assert.deepEqual(contract.gradeResultProblems({ ...good, trust: 101 }), ["trust: 101 is not an integer 0..100 or null"]);
  assert.deepEqual(contract.gradeResultProblems({ ...good, trust: null }), []);
  assert.deepEqual(contract.gradeResultProblems({ ...good, identity: { ...good.identity, verdict: "ok" } }), ["identity.verdict: ok"]);
});

console.log(pass + " assertions passed\n");
