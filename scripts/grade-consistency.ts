/**
 * GRADE REPEATABILITY HARNESS — the calibration bench for cosmetic grading.
 *
 * There is no fine-tuning step in GradeIQ: the vision model is called through
 * the Gemini API with a prompt, so "training" it is not something this codebase
 * can do. What it CAN do — and what the industrial graders actually rely on — is
 * calibrate against reference devices and measure repeatability: run the same
 * known photos through the pipeline N times and see whether the letter holds.
 *
 * That is the number that matters commercially. A grader that is 90% accurate
 * but returns a different letter every run cannot price anything, because the
 * seller and the buyer are looking at different answers to the same question.
 *
 * This replays REAL stored sessions (data/uploads), so the corpus is your own
 * production photos rather than synthetic fixtures.
 *
 * Usage:
 *   npx tsx scripts/grade-consistency.ts                 # 3 runs over 5 sessions
 *   npx tsx scripts/grade-consistency.ts --runs=5        # 5 runs each
 *   npx tsx scripts/grade-consistency.ts --sessions=08275d6c,7sbbkr
 *   npx tsx scripts/grade-consistency.ts --tier=flash    # cheaper sweep
 *
 * COSTS REAL MODEL CALLS: sessions x runs. Default 5 x 3 = 15 Pro calls.
 * Requires the server env (GEMINI_API_KEY) and a populated data/uploads.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { runVisionCascade } from "../lib/visionAgents";

type Row = { id: string; model: string; cosmetic_grade: string; photos: string };

const arg = (k: string, d?: string) =>
  process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;

const RUNS = Number(arg("runs", "3"));
const TIER = (arg("tier", "pro") as "flash" | "pro");
const ONLY = (arg("sessions") || "").split(",").filter(Boolean);
const LIMIT = Number(arg("limit", "5"));
/** Gap between calls. Firing Pro requests back-to-back gets them rate-limited,
 *  and a rate-limited call returns a STUB — which an earlier version of this
 *  harness counted as "the grade changed". Measure the model, not the quota. */
const PAUSE_MS = Number(arg("pause", "4000"));
const DB_PATH = arg("db", path.join(process.cwd(), "data", "gradeiq.db"))!;

const db = new Database(DB_PATH, { readonly: true });

let rows = db
  .prepare(
    `SELECT id, model, cosmetic_grade, photos FROM sessions
      WHERE photos IS NOT NULL AND photos != '' AND photos != '[]'
        AND cosmetic_grade IS NOT NULL AND cosmetic_grade != ''
      ORDER BY created_at DESC`,
  )
  .all() as Row[];

if (ONLY.length) rows = rows.filter((r) => ONLY.some((p) => r.id.startsWith(p)));
rows = rows.slice(0, LIMIT);

if (!rows.length) {
  console.error("No graded sessions with stored photos found.");
  process.exit(1);
}

/** Stored "/api/uploads/x.jpg" URLs → data URLs the vision call accepts. */
function loadPhotos(photosJson: string): string[] {
  let stored: string[] = [];
  try {
    stored = JSON.parse(photosJson || "[]");
  } catch {
    return [];
  }
  const dir = path.join(process.cwd(), "data", "uploads");
  const out: string[] = [];
  for (const url of stored) {
    const file = String(url).split("/").pop();
    if (!file) continue;
    try {
      out.push(`data:image/jpeg;base64,${fs.readFileSync(path.join(dir, file)).toString("base64")}`);
    } catch {
      /* file gone — skip */
    }
  }
  return out;
}

const mode = <T,>(xs: T[]): T =>
  [...new Set(xs)].sort(
    (a, b) => xs.filter((x) => x === b).length - xs.filter((x) => x === a).length,
  )[0];

(async () => {
  console.log(`Repeatability · ${rows.length} sessions x ${RUNS} runs · tier=${TIER}\n`);
  let stable = 0;
  const report: { id: string; model: string; stored: string; grades: string[]; ok: boolean }[] = [];

  for (const r of rows) {
    const photos = loadPhotos(r.photos);
    if (!photos.length) {
      console.log(`${r.id.slice(0, 8)}  ${r.model}  — photos missing on disk, skipped`);
      continue;
    }
    const grades: string[] = [];
    const scores: number[] = [];
    let failed = 0; // API/stub failures — NOT evidence that the grade is unstable
    let intakeFailed = false;
    for (let i = 0; i < RUNS; i++) {
      try {
        const res = await runVisionCascade(photos, r.model, { forceTier: TIER });
        // A stub is what the cascade returns when the vision call itself failed
        // (no key, quota, network). Counting it as "the grade changed" would
        // blame the model for an outage — and, worse, would let a real
        // instability problem hide behind an infrastructure one.
        if (res.tierUsed === "stub" || !res.grade) {
          failed++;
          continue;
        }
        if (res.intake && res.intake.passed === false) intakeFailed = true;
        grades.push(res.grade);
        scores.push(typeof res.score === "number" ? res.score : NaN);
      } catch {
        failed++;
      }
      // Pro calls carry a dozen images; back-to-back requests get rate-limited,
      // which is what produced the stubs this harness first mistook for variance.
      if (i < RUNS - 1) await new Promise((r) => setTimeout(r, PAUSE_MS));
    }
    if (grades.length < 2) {
      console.log(
        `SKIPPED  ${r.id.slice(0, 8)}  ${(r.model || "?").padEnd(22)} ` +
          `only ${grades.length}/${RUNS} runs answered (${failed} API failures) — cannot judge stability`,
      );
      continue;
    }
    const uniq = [...new Set(grades)];
    const ok = uniq.length === 1;
    if (ok) stable++;
    report.push({ id: r.id, model: r.model, stored: r.cosmetic_grade, grades, ok });
    console.log(
      `${ok ? "STABLE  " : "VARIES  "} ${r.id.slice(0, 8)}  ${(r.model || "?").padEnd(22)} ` +
        `stored=${(r.cosmetic_grade || "-").padEnd(8)} runs=[${grades.join(", ")}]  ` +
        `scores=[${scores.map((s) => (Number.isNaN(s) ? "?" : s)).join(", ")}]` +
        (failed ? `  (${failed} API failure${failed > 1 ? "s" : ""} excluded)` : "") +
        (ok ? "" : `  <<< consensus=${mode(grades)}`) +
        // A session the intake gate rejected is not a fair test of grading: the
        // photos are blurry, obstructed, or of a different device than claimed.
        // Instability there says more about the capture than the grader.
        (intakeFailed ? `\n         ! intake FAILED on this session — photos may not be gradeable` : ""),
    );
  }

  const n = report.length;
  console.log(
    `\n=== ${stable}/${n} sessions returned the SAME letter on all ${RUNS} runs ` +
      `(${n ? Math.round((stable / n) * 100) : 0}% repeatable) ===`,
  );
  // Non-zero exit when a majority wobble, so this can gate a deploy later.
  process.exit(n > 0 && stable / n < 0.8 ? 1 : 0);
})();
