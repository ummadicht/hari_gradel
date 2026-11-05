// A whole-panel colour cast is the camera, not the panel.
//
// Session 8c55b4fb failed its display sweep on "Uneven blueish tint" boxed over
// the entire screen, and SwapUp priced a working phone as "Needs repair". These
// tests pin the fix: a discoloration/tint covering ≥ 70% of the frame is an
// advisory note and never a fail; anything localised fails exactly as before.
//
// No network: global fetch answers with a scripted model reply.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// settings.ts opens <cwd>/data/gradeiq.db — never a real one.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "giq-display-test-")));
process.env.GEMINI_API_KEY = "test-key";
const { validateDisplay, isWholePanelCast, CAST_NOTE } = await import("./displayCheck.ts");

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

const CAPS = ["white", "red", "green", "blue", "black"].map((pattern) => ({ pattern, dataUrl: "data:image/jpeg;base64,AAAA" }));

/** The model answers `reply` (as Gemini's JSON-mode text). */
function modelSays(reply) {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(reply) }] } }] }), { status: 200 });
}

// The real finding, verbatim, from production session 8c55b4fb.
const CAST_8C55 = { pattern: "white", type: "discoloration", label: "Uneven blueish tint", severity: "moderate", box: [0.05, 0.05, 0.9, 0.95] };
const display = (verdict) => (verdict === "pass" ? "pass" : verdict === "fail" ? "fail" : "skip"); // the display route's mapping

await t("session 8c55b4fb: the whole-panel blueish tint is NOT a fail", async () => {
  modelSays({ verdict: "fail", confidence: 0.85, note: "Uneven blueish tint across the panel.", findings: [CAST_8C55] });
  const r = await validateDisplay(CAPS, "Galaxy S23 Ultra");
  assert.equal(r.verdict, "pass");
  assert.equal(display(r.verdict), "pass", "functional.display");
  assert.deepEqual(r.findings, [], "the cast is not a finding — nothing for SwapUp to count as a fault");
  assert.ok(r.note.includes(CAST_NOTE), r.note);
  assert.doesNotMatch(r.note, /blueish/, "the model's defect wording is not repeated");
});

await t("the cast alone at low confidence is 'unknown', never a pass", async () => {
  modelSays({ verdict: "fail", confidence: 0.3, findings: [CAST_8C55] });
  const r = await validateDisplay(CAPS);
  assert.equal(r.verdict, "unknown");
  assert.equal(display(r.verdict), "skip");
});

await t("a screen the model could not see stays 'unknown' even with a cast listed", async () => {
  modelSays({ verdict: "unknown", confidence: 0.9, findings: [CAST_8C55] });
  assert.equal((await validateDisplay(CAPS)).verdict, "unknown");
});

await t("a localised discoloration still fails", async () => {
  const spot = { pattern: "gray", type: "discoloration", label: "Yellow patch top-left", severity: "moderate", box: [0.05, 0.05, 0.4, 0.5] };
  modelSays({ verdict: "fail", confidence: 0.8, note: "Yellow patch.", findings: [spot] });
  const r = await validateDisplay(CAPS);
  assert.equal(r.verdict, "fail");
  assert.equal(r.findings.length, 1);
  assert.equal(r.note, "Yellow patch.", "no cast dropped → the model's note as today");
});

await t("lines, dead pixels and whole-screen non-tint findings still fail", async () => {
  for (const f of [
    { pattern: "white", type: "line", label: "Green vertical line", severity: "severe", box: [0, 0.6, 1, 0.62] },
    { pattern: "black", type: "deadpixel", label: "Stuck pixel", severity: "minor", box: [0.5, 0.5, 0.51, 0.51] },
    { pattern: "black", type: "bleed", label: "Backlight bleed", severity: "moderate", box: [0, 0, 1, 1] },
  ]) {
    modelSays({ verdict: "fail", confidence: 0.8, findings: [f] });
    assert.equal((await validateDisplay(CAPS)).verdict, "fail", f.type);
  }
});

await t("a cast beside a real defect: the defect fails, the cast is only the advisory", async () => {
  const line = { pattern: "white", type: "line", label: "Pink line", severity: "severe", box: [0, 0.3, 1, 0.32] };
  modelSays({ verdict: "fail", confidence: 0.9, findings: [CAST_8C55, line] });
  const r = await validateDisplay(CAPS);
  assert.equal(r.verdict, "fail");
  assert.deepEqual(r.findings.map((f) => f.label), ["Pink line"]);
  assert.ok(r.note.includes(CAST_NOTE), r.note);
});

await t("a model 'fail' with no findings at all still fails (unchanged)", async () => {
  modelSays({ verdict: "fail", confidence: 0.8, findings: [] });
  assert.equal((await validateDisplay(CAPS)).verdict, "fail");
});

await t("the 70% edge, permille boxes, and a finding with no box", async () => {
  const f = (box) => ({ pattern: "white", type: "discoloration", label: "tint", severity: "moderate", box });
  assert.equal(isWholePanelCast(f([0, 0, 0.7, 1])), true, "exactly 70%");
  assert.equal(isWholePanelCast(f([0, 0, 0.69, 1])), false, "just under");
  assert.equal(isWholePanelCast({ ...f(undefined), type: "Uneven tint" }), false, "no box → cannot be whole-panel");
  assert.equal(isWholePanelCast({ ...f([0, 0, 1, 1]), type: "blob" }), false, "only discoloration/tint");
  // The parser rescales permille boxes; the 8c55b4fb box in permille is still a cast.
  modelSays({ verdict: "fail", confidence: 0.85, findings: [{ ...CAST_8C55, box: [50, 50, 900, 950] }] });
  assert.equal((await validateDisplay(CAPS)).verdict, "pass");
});

console.log(`\n${pass} passed${process.exitCode ? " — FAILURES above" : ""}`);
