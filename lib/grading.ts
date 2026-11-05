import { FUNCTIONAL_TESTS } from "./tests";

export type FunctionalResults = Record<string, "pass" | "fail" | "skip">;

export type FunctionalVerdict = {
  grade: "Working" | "Faulty" | "";
  passed: number;
  failed: number;
  skipped: number;
  /**
   * Tests ACTUALLY ATTEMPTED (passed + failed) — the denominator for "8/8 pass".
   *
   * This used to be FUNCTIONAL_TESTS.length, the size of the whole catalog, so a
   * Samsung that ran 8 tests and passed all 8 was reported as "8/11 pass" — the
   * three it never ran (Face ID on an Android, hardware buttons, a skipped
   * display check) read as three non-passes, and the very same report card
   * printed "8/8" a few sections later. Never counted ≠ didn't pass.
   */
  total: number;
  /** Size of the test catalog, for "3 not run" context. */
  catalogTotal: number;
  /** Tests with no result at all — not attempted on this device. */
  notRun: number;
  criticalFailures: string[]; // test names
};

// A device is "Faulty" if any *critical* test failed; otherwise "Working".
// Non-critical failures are recorded as defects but don't fail the device.
export function gradeFunctional(results: FunctionalResults): FunctionalVerdict {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const criticalFailures: string[] = [];

  for (const t of FUNCTIONAL_TESTS) {
    const r = results[t.id];
    if (r === "pass") passed++;
    else if (r === "fail") {
      failed++;
      if (t.critical) criticalFailures.push(t.name);
    } else skipped++;
  }

  const answered = passed + failed;
  return {
    grade: answered === 0 ? "" : criticalFailures.length ? "Faulty" : "Working",
    passed,
    failed,
    skipped,
    total: answered,
    catalogTotal: FUNCTIONAL_TESTS.length,
    notRun: FUNCTIONAL_TESTS.length - answered,
    criticalFailures,
  };
}

// Cosmetic ladder — mirrors the WholeCell/SuperIQ cosmetic tiers.
export const COSMETIC_TIERS = ["Premium", "A", "B", "C", "D"] as const;
export type CosmeticGrade = (typeof COSMETIC_TIERS)[number];

// Overall grade = cosmetic tier with a functional suffix, the CTIA-style
// convention the refurb side already uses. Faulty always drops to a working-
// grade cap and is flagged.
export function combineGrade(
  cosmetic: string,
  functionalGrade: string
): string {
  if (!cosmetic && !functionalGrade) return "";
  const cos = cosmetic || "?";
  if (functionalGrade === "Faulty") return `${cos} · FAULTY`;
  if (functionalGrade === "Working") return `${cos} · Working`;
  return cos;
}
