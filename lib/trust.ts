import { buildPassport } from "./passport";
import type { Session } from "./db";

// Trust Score — the v2 fusion layer. Instead of a wall of pass/fail tests, one
// composite 0–100 built from the evidence GradeIQ already gathers: cosmetic
// grade (weighted by how reliably it was seen), functional pass rate, the
// anti-fraud identity check, and OEM-parts authenticity. Honest by construction:
// a component we couldn't verify lowers confidence, it doesn't fake a pass.

export type TrustBand = {
  label: string;
  value: string;
  state: "ok" | "warn" | "bad" | "na";
};

export type Trust = {
  score: number; // 0..100 composite
  grade: string; // headline cosmetic grade
  reliable: boolean; // cosmetic evidence trustworthy
  bands: TrustBand[];
  nudges: string[]; // one-line asks to raise confidence (retake / mismatch / cover)
  identityVerdict: "match" | "mismatch" | "unverified";
};

const GRADE_SCORE: Record<string, number> = {
  Premium: 100,
  A: 92,
  B: 78,
  C: 55,
  D: 30,
};

export function computeTrust(s: Session): Trust {
  const p = buildPassport(s);
  const gradeKey = (p.finalGrade || "—").split("·")[0].trim();

  let cos = GRADE_SCORE[gradeKey] ?? 60;
  if (!p.reliable) cos = Math.round(cos * 0.6); // provisional grade → discounted

  const fun = p.functional.total
    ? Math.round((p.functional.passed / p.functional.total) * 100)
    : 70;

  const idn =
    p.identity.verdict === "match" ? 100 : p.identity.verdict === "mismatch" ? 0 : 75;

  const oem = p.parts.checked ? (p.parts.anyNonGenuine ? 45 : 100) : 75;

  let score = Math.round(0.4 * cos + 0.3 * fun + 0.2 * idn + 0.1 * oem);
  // A device-identity mismatch is a fraud signal — cap the whole score hard.
  if (p.identity.verdict === "mismatch") score = Math.min(score, 35);
  score = Math.max(0, Math.min(100, score));

  const bands: TrustBand[] = [
    {
      label: "Cosmetic",
      value: gradeKey !== "—" ? `Grade ${gradeKey}${p.reliable ? "" : " · provisional"}` : "—",
      state: gradeKey === "—" ? "na" : p.reliable ? "ok" : "warn",
    },
    {
      label: "Functional",
      value:
        p.functional.passed + p.functional.failed === 0
          ? "Not run"
          : `${p.functional.passed}/${p.functional.total} pass${
              p.functional.notRun ? ` · ${p.functional.notRun} not run` : ""
            }`,
      state:
        p.functional.failed > 0
          ? "warn"
          : p.functional.passed > 0
            ? "ok"
            : "na",
    },
    {
      label: "Fraud / Identity",
      value:
        p.identity.verdict === "match"
          ? "IMEI matches device"
          : p.identity.verdict === "mismatch"
            ? "Mismatch — possible swap"
            : "Unverified",
      state: idn >= 100 ? "ok" : idn === 0 ? "bad" : "warn",
    },
    {
      label: "OEM parts",
      value: p.parts.checked ? (p.parts.anyNonGenuine ? "Non-OEM found" : "Genuine") : "Not checked",
      state: p.parts.anyNonGenuine ? "bad" : p.parts.checked ? "ok" : "na",
    },
    {
      label: "Battery health",
      // Missing means no reading reached this report (no station record on it,
      // no Settings screenshot) — not that a connection is down, and not that
      // the phone was never tested: a station GradeIQ cannot see may have.
      value: p.diagnostics.batteryHealth != null ? `${p.diagnostics.batteryHealth}%` : "No reading",
      state: p.diagnostics.batteryHealth != null ? "ok" : "na",
    },
  ];

  const nudges: string[] = [];
  if (p.obstruction?.present) nudges.push(`Remove the ${p.obstruction.type} and re-scan — it hides the real condition.`);
  if (p.identity.verdict === "mismatch") nudges.push(...p.identity.flags);
  if (!p.reliable) nudges.push(...p.retakeReasons.slice(0, 3));

  return {
    score,
    grade: gradeKey,
    reliable: p.reliable,
    bands,
    nudges: Array.from(new Set(nudges)).slice(0, 4),
    identityVerdict: p.identity.verdict,
  };
}
