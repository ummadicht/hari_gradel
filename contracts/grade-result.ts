/**
 * GRADE RESULT CONTRACT — what GET /api/sessions/{id} promises its readers.
 *
 * Two systems pay or price against this response, and neither may break
 * because GradeIQ renamed something:
 *   • SwapUp      (swapup lib/server/gradeiq.ts call 5 → lib/domain/gradeiqMap.ts readSnapshot)
 *   • CounterIQ   (retail-portal lib/gradeiq.ts fetchAssessment — prices the
 *                  buy offer off `trust`: below 70 the offer is 6% lower)
 *
 * The response is the whole hydrated session plus derived fields, so it carries
 * more than is listed here. Only what is listed is promised. Rules:
 *   • A listed field is never renamed, removed or retyped within a version.
 *   • Adding a field is not a new version. Changing a listed one is: bump
 *     GRADE_RESULT_VERSION, keep serving the old shape until both readers move.
 *   • The response says which version it follows in the GRADE_RESULT_HEADER
 *     header ("grade-result/1").
 *   • Readers ignore what they do not know. SwapUp deliberately drops `offer`
 *     (a price) and `staged` (base64 photos) — they are not part of this contract.
 *
 * Plain types and a JSON Schema, no runtime dependencies, so a reader can copy
 * this file as it is.
 */

export const GRADE_RESULT_CONTRACT = "grade-result";
export const GRADE_RESULT_VERSION = 1;
/** Response header naming the contract version, e.g. "grade-result/1". */
export const GRADE_RESULT_HEADER = "x-gradeiq-contract";
export const GRADE_RESULT_TAG = `${GRADE_RESULT_CONTRACT}/${GRADE_RESULT_VERSION}`;

export type IdentityVerdict = "match" | "mismatch" | "unverified";
export type TestResult = "pass" | "fail" | "skip";

/** grade-result/1 — the fields SwapUp (S) and CounterIQ (C) read. */
export type GradeResultV1 = {
  /** Session id (UUID). */
  id: string;
  /** Tenant. SwapUp refuses a session under another tenant. (S) */
  client_id: string;
  /** Scanned IMEI; "" when none yet. */
  imei: string;
  /** Best-known model name. (C) */
  model: string;
  /** open | functional_done | graded — informational; SwapUp ignores it. (C) */
  status: string;
  /** Premium | A | B | C | D | "" (S, C) */
  cosmetic_grade: string;
  /** Working | Faulty | "" (S, C) */
  functional_grade: string;
  /** Combined grade, "" until graded. (S, C) */
  overall_grade: string;
  /** Per-test results. (C: tested = non-empty) */
  functional: Record<string, TestResult>;
  /** Photo paths (/api/uploads/<file>). (S, C) */
  photos: string[];
  /**
   * The vision result. Fields read, all optional: grade, tierUsed (stub |
   * flash | pro), visionModel, refining, conclusive, gradeRange {best, worst},
   * needsHumanReview, coverage, score, specialists[{id, name, grade,
   * confidence, findings, notes}], obstruction {present, type, note}, oem
   * {verdict, confidence, evidence}, device {make, model, match, reason,
   * colour}, pendingVerification. (S; C reads it only to see photos happened)
   */
  cosmetic: Record<string, unknown>;
  /** Screen state: capture, displayCheck, angleLabels. (S) */
  screen: Record<string, unknown>;
  /** Capture-gate verdict {verdict, code, reasons, attempt}; {} until judged. (S) */
  capture: Record<string, unknown>;
  /**
   * Is the graded device the device on the record? Computed on every read.
   * A grade is only worth money if it belongs to the IMEI being paid for. (S, C)
   */
  identity: {
    verdict: IdentityVerdict;
    flags: string[];
    /** false = checked at brand level only, which proves almost nothing. (C) */
    modelLevel: boolean;
    imei: { brand: string; model: string };
    /** The device that ran the tests; null when none connected. (C reads resolved || model) */
    connected: { model: string; resolved: string } | null;
  };
  /**
   * Trust score, 0..100 (lib/trust.ts computeTrust(s).score): cosmetic grade
   * weighted by how reliably it was seen, functional pass rate, the identity
   * check, OEM parts. Capped at 35 on an identity mismatch. null only if it
   * could not be computed. CounterIQ hedges its offer by 6% below 70. (C)
   */
  trust: number | null;
  /**
   * Is a grade still being worked out (SUP-63)? Computed on every read, never
   * stored. "running": `cosmetic.refining` is set and younger than
   * `unfinishedAfterSeconds` (the Pro call timeout, its retry and a margin), so
   * the grade may still change. "unfinished": the flag is older than that, so
   * the background grading died and staff must re-grade; waiting changes
   * nothing. "none": nothing is refining. `cosmetic.refining` itself is sent as
   * stored. Added after grade-result/1 shipped, so a reader must treat a
   * missing `refine` as unknown.
   */
  refine?: {
    state: "none" | "running" | "unfinished";
    /** ISO time the grading started, or null when not known. */
    startedAt: string | null;
    unfinishedAfterSeconds: number;
  };
};

/** The same promise as a JSON Schema (draft 2020-12), for readers outside TypeScript. */
export const gradeResultSchemaV1 = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: `https://swapmore.com/apps/gradeiq/contracts/${GRADE_RESULT_TAG}`,
  title: "GradeIQ grade result v1 (GET /api/sessions/{id})",
  type: "object",
  required: [
    "id",
    "client_id",
    "imei",
    "model",
    "status",
    "cosmetic_grade",
    "functional_grade",
    "overall_grade",
    "functional",
    "photos",
    "cosmetic",
    "screen",
    "capture",
    "identity",
    "trust",
  ],
  properties: {
    id: { type: "string" },
    client_id: { type: "string" },
    imei: { type: "string" },
    model: { type: "string" },
    status: { type: "string" },
    cosmetic_grade: { type: "string" },
    functional_grade: { type: "string" },
    overall_grade: { type: "string" },
    functional: { type: "object", additionalProperties: { enum: ["pass", "fail", "skip"] } },
    photos: { type: "array", items: { type: "string" } },
    cosmetic: { type: "object" },
    screen: { type: "object" },
    capture: { type: "object" },
    identity: {
      type: "object",
      required: ["verdict", "flags", "modelLevel", "imei", "connected"],
      properties: {
        verdict: { enum: ["match", "mismatch", "unverified"] },
        flags: { type: "array", items: { type: "string" } },
        modelLevel: { type: "boolean" },
        imei: { type: "object", required: ["model"], properties: { brand: { type: "string" }, model: { type: "string" } } },
        connected: {
          oneOf: [{ type: "null" }, { type: "object", properties: { model: { type: "string" }, resolved: { type: "string" } } }],
        },
      },
    },
    trust: { oneOf: [{ type: "null" }, { type: "integer", minimum: 0, maximum: 100 }] },
    refine: {
      type: "object",
      required: ["state", "startedAt", "unfinishedAfterSeconds"],
      properties: {
        state: { enum: ["none", "running", "unfinished"] },
        startedAt: { oneOf: [{ type: "null" }, { type: "string" }] },
        unfinishedAfterSeconds: { type: "number" },
      },
    },
  },
  additionalProperties: true,
} as const;

/**
 * Does `v` keep the grade-result/1 promise? Returns the problems found ([] =
 * conforms). Checks exactly what the schema above requires, nothing more, so
 * a test can hold the live response to it.
 */
export function gradeResultProblems(v: unknown): string[] {
  const out: string[] = [];
  const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
  if (!isObj(v)) return ["not an object"];
  for (const k of ["id", "client_id", "imei", "model", "status", "cosmetic_grade", "functional_grade", "overall_grade"]) {
    if (typeof v[k] !== "string") out.push(`${k}: not a string`);
  }
  if (!isObj(v.functional)) out.push("functional: not an object");
  else for (const [k, r] of Object.entries(v.functional)) if (r !== "pass" && r !== "fail" && r !== "skip") out.push(`functional.${k}: ${String(r)}`);
  if (!Array.isArray(v.photos) || v.photos.some((p) => typeof p !== "string")) out.push("photos: not a string array");
  for (const k of ["cosmetic", "screen", "capture"]) if (!isObj(v[k])) out.push(`${k}: not an object`);
  const id = v.identity;
  if (!isObj(id)) out.push("identity: not an object");
  else {
    if (id.verdict !== "match" && id.verdict !== "mismatch" && id.verdict !== "unverified") out.push(`identity.verdict: ${String(id.verdict)}`);
    if (!Array.isArray(id.flags) || id.flags.some((f) => typeof f !== "string")) out.push("identity.flags: not a string array");
    if (typeof id.modelLevel !== "boolean") out.push("identity.modelLevel: not a boolean");
    if (!isObj(id.imei) || typeof id.imei.model !== "string") out.push("identity.imei.model: not a string");
    if (id.connected !== null && !isObj(id.connected)) out.push("identity.connected: not an object or null");
  }
  const t = v.trust;
  if (!(t === null || (typeof t === "number" && Number.isInteger(t) && t >= 0 && t <= 100))) out.push(`trust: ${String(t)} is not an integer 0..100 or null`);
  // Optional (added after v1 shipped), but held to its shape when present.
  if ("refine" in v) {
    const r = v.refine;
    if (!isObj(r)) out.push("refine: not an object");
    else {
      if (r.state !== "none" && r.state !== "running" && r.state !== "unfinished") out.push(`refine.state: ${String(r.state)}`);
      if (r.startedAt !== null && typeof r.startedAt !== "string") out.push("refine.startedAt: not a string or null");
      if (typeof r.unfinishedAfterSeconds !== "number") out.push("refine.unfinishedAfterSeconds: not a number");
    }
  }
  return out;
}
