// Pure compliance vocabulary — NO database import.
//
// Split out of lib/compliance.ts because that module imports lib/db.ts, and any
// CLIENT component importing a value from it drags `node:fs` into the browser
// bundle and fails the build. (The same trap lib/clients.ts fell into.) Types
// are erased at compile time and were safe; the KIND and SEVERITY constants are
// real values and were not.
//
// Anything a browser needs to know about compliance lives here. Anything that
// touches storage stays in lib/compliance.ts.

/** Controlled vocabulary. A free-text kind cannot be counted across stores. */
export const COMPLIANCE_KINDS = [
  // ── identity: is this the phone we were told it is? ──
  "identity.imei_mismatch", // typed IMEI ≠ the one on the device's own screen
  "identity.model_vs_vision", // claimed model ≠ what the photos show
  "identity.model_vs_fingerprint", // claimed model ≠ UA / viewport
  "identity.colour_mismatch",
  "identity.storage_mismatch",
  "identity.unproven", // priced with no IMEI corroboration at all

  // ── evidence: is what we are looking at admissible? ──
  "evidence.stale_screenshot", // taken before the challenge, or long after
  "evidence.obstruction", // a case/cover hid the device
  "evidence.duplicate_image", // this image has been seen in another session
  "evidence.missing_surface",
  "evidence.suspect_aftermarket",

  // ── process: did the operator follow it? ──
  "process.prep_not_acked",
  "process.step_skipped",
  "process.grade_overridden",
] as const;

export type ComplianceKind = (typeof COMPLIANCE_KINDS)[number];
export const isComplianceKind = (v: unknown): v is ComplianceKind =>
  typeof v === "string" && (COMPLIANCE_KINDS as readonly string[]).includes(v);

/**
 * `block` stops money moving. `flag` reaches the exception queue. `record` is
 * evidence only.
 *
 * Deliberately conservative: only identity mismatches block, because those are
 * the ones already proven to correlate with loss. Blocking on process
 * violations would stop honest operators working, and there is no data yet on
 * which violations predict a bad payout — that would be guessing at thresholds
 * again.
 */
export type ComplianceSeverity = "block" | "flag" | "record";

export const DEFAULT_SEVERITY: Record<ComplianceKind, ComplianceSeverity> = {
  "identity.imei_mismatch": "block",
  "identity.model_vs_vision": "block",
  "identity.model_vs_fingerprint": "flag",
  "identity.colour_mismatch": "flag",
  "identity.storage_mismatch": "flag",
  "identity.unproven": "flag",
  "evidence.stale_screenshot": "flag",
  "evidence.obstruction": "flag",
  "evidence.duplicate_image": "block",
  "evidence.missing_surface": "record",
  "evidence.suspect_aftermarket": "flag",
  "process.prep_not_acked": "record",
  "process.step_skipped": "record",
  "process.grade_overridden": "record",
};

