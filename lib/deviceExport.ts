import type { Session } from "./db";
import { buildPassport } from "./passport";
import { buildPlan } from "./suggester";
import { gradeFunctional } from "./grading";
import { FUNCTIONAL_TESTS } from "./tests";

// The SuperIQ import contract, built in-process. Shared by
//   GET  /api/report/[id]/export         (?format=devicefax | superiq)
//   POST /api/report/[id]/push-superiq   (sends the superiq batch to SuperIQ)
// push-superiq used to fetch its own export over HTTP from `req.url`'s origin —
// behind Caddy that is https://localhost:3700, which speaks plain http, so every
// push died on a TLS error before it ever reached SuperIQ.
//
// `origin` must be the PUBLIC origin (lib/authUrls.ts publicOrigin): the photo
// and report URLs inside are links SuperIQ and its users will open.

/** "devicefax" (default) → the rich single-device DeviceFax document.
 *  "superiq"             → a Phonecheck-shaped { source, rows:[…] } batch that
 *                          SuperIQ's /api/diagnostics endpoint ingests directly
 *                          (matched by IMEI), with the DeviceFax extras in `raw`. */
export function buildDeviceExport(s: Session, origin: string, format: "devicefax" | "superiq" = "devicefax") {
  const passport = buildPassport(s);
  const plan = buildPlan(s);
  const verdict = gradeFunctional(s.functional);
  const cos = s.cosmetic as any;

  const base = process.env.NEXT_PUBLIC_BASE_PATH || "";
  const photos = s.photos.map((p) => `${origin}${p.startsWith("/") ? "" : "/"}${base}${p}`);
  const reportUrl = `${origin}${base}/report/${s.id}`;

  const devicefax = {
    schema: "gradeiq.devicefax/v1",
    exportedAt: new Date().toISOString(),
    session: s.id,
    passportId: passport.id,
    identity: {
      imei: s.imei,
      model: s.model,
      make: passport.identification.find((f) => f.label === "Make")?.value,
      storage: passport.identification.find((f) => f.label === "Storage")?.value,
      colour: passport.identification.find((f) => f.label === "Colour")?.value,
      serial: passport.identification.find((f) => f.label === "Serial")?.value,
    },
    grade: {
      overall: s.overall_grade,
      cosmetic: s.cosmetic_grade,
      functional: verdict.grade,
      score: cos?.score ?? null,
      verified: passport.verified,
    },
    diagnostics: {
      phonecheck: s.phonecheck, // leveraged where available
      imeiInfo: s.imei_info,
    },
    // Unified per-component record (Pandas-shape) — cosmetic + functional.
    assessments: s.assessments,
    cosmetic: {
      source: cos?.source ?? null,
      specialists: cos?.specialists ?? [],
      findings: cos?.findings ?? [],
      notes: cos?.notes ?? "",
    },
    functional: {
      verdict: verdict.grade,
      passed: verdict.passed,
      failed: verdict.failed,
      criticalFailures: verdict.criticalFailures,
      results: s.functional,
    },
    plan, // the refurb / solution plan (Suggester)
    photos,
    signature: passport.signature,
  };

  // SuperIQ ingestion format — a Phonecheck-shaped batch its /api/diagnostics
  // endpoint accepts as-is (source "GradeIQ"), matched to devices by IMEI.
  if (format === "superiq") {
    const testResults = FUNCTIONAL_TESTS.filter(
      (t) => s.functional[t.id]
    ).map((t) => ({
      testName: t.name,
      status:
        s.functional[t.id] === "pass"
          ? "pass"
          : s.functional[t.id] === "fail"
            ? "fail"
            : "warn",
      detail: t.critical ? "critical" : undefined,
    }));
    // Every diagnostic from the ONE reading the report shows (the passport's
    // diagnostics), so a row never mixes sources: battery from a station
    // record next to blacklist / Find My / lock read from the session's empty
    // columns exported a blacklisted, Find-My-on, locked phone as
    // unknown / unknown / unlocked.
    const dx = passport.diagnostics;
    const row = {
      imei: s.imei,
      batteryHealthPct: dx.batteryHealth ?? undefined,
      batteryCycleCount: dx.batteryCycles ?? undefined,
      carrierLocked: dx.lock === "locked",
      blacklistStatus: dx.blacklist,
      icloudStatus: dx.fmip ?? "unknown",
      cosmeticGrade: s.cosmetic_grade || undefined,
      testResults,
      overall:
        verdict.grade === "Faulty"
          ? "fail"
          : verdict.grade === "Working"
            ? "pass"
            : "warn",
      reportUrl,
      reports: photos.map((url, i) => ({ label: `Photo ${i + 1}`, url })),
      raw: devicefax, // full DeviceFax: grade, score, solution plan, findings
    };
    return { source: "GradeIQ", rows: [row] };
  }

  return devicefax;
}
