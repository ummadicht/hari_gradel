// A model the grader has never heard of is NOT a fake phone.
//
// THE FAILURE THIS EXISTS TO STOP, from a real session: a seller brought a
// Galaxy Z Fold8 Ultra — announced 22 July 2026, on sale 7 August 2026 — and the
// report said:
//
//   MISMATCH · "Claimed model Galaxy Z Fold8 Ultra does not exist; device
//    appears to be a Galaxy Z Fold 6 based on squared corners and camera layout."
//
// Every part of that is the same mistake. The vision model's knowledge of the
// catalogue is frozen at its training cutoff, so for any phone released after
// it, "does not exist" is guaranteed to be what it believes — and guaranteed to
// be wrong. And a new Fold looks like an old Fold, so "squared corners and
// camera layout" identifies a FAMILY, never a generation.
//
// The prompt already forbids this in plain language (see inspectionCatalog's
// "NEWER THAN THIS LIST IS NOT COUNTERFEIT"). It happened anyway, because the
// model's prior is stronger than an instruction. So the rule is enforced here
// instead of merely requested: a mismatch justified by the model's own
// knowledge of what exists is downgraded to "uncertain" before it can reach a
// compliance event, an offer block, or a customer.
//
// WHAT IS STILL ALLOWED. A mismatch grounded in something VISIBLE — three rear
// cameras where the claimed device has two, a headphone jack on a modern
// flagship, a body that is plainly not a foldable. Those survive untouched.
// This only removes verdicts whose evidence is "I have not heard of it".

export type DeviceIdentity = {
  make?: string;
  model?: string;
  match?: "match" | "mismatch" | "uncertain";
  reason?: string;
  colour?: string;
};

/**
 * Reasons that are really "this is not in my training data".
 *
 * Deliberately narrow — each pattern is a claim about the CATALOGUE rather than
 * about the photograph. Anything describing what is actually visible is left
 * alone, because that is evidence and this is not.
 */
const NOT_IN_MY_DATA = [
  /does\s*n[o']?t\s+exist/i,
  /doesn.?t\s+exist/i,
  /no\s+such\s+(model|device|phone|product)/i,
  /not\s+a\s+(real|genuine|valid|recognized|recognised|known|existing)\s+(model|device|phone|product)/i,
  /never\s+(been\s+)?(released|existed|announced|made)/i,
  /(is|was)\s+not\s+released/i,
  /unreleased|unannounced|non-?existent|fictional|made[-\s]?up|fabricated\s+model/i,
  /not\s+in\s+(my|the)\s+(knowledge|training|database|catalogue|catalog)/i,
  /i\s+am\s+not\s+aware\s+of/i,
];

export function citesNonExistence(reason?: string): boolean {
  const r = (reason || "").trim();
  if (!r) return false;
  return NOT_IN_MY_DATA.some((re) => re.test(r));
}

export type GuardResult = {
  device: DeviceIdentity;
  /** True when a mismatch verdict was withdrawn. */
  downgraded: boolean;
};

/**
 * Withdraw any mismatch whose stated evidence is the model's own ignorance.
 *
 * The original wording is PRESERVED in the reason, prefixed so an operator can
 * still read what the grader thought — suppressing the verdict is right,
 * hiding that it happened is not.
 */
export function guardDeviceIdentity(device?: DeviceIdentity | null): GuardResult {
  if (!device) return { device: {} as DeviceIdentity, downgraded: false };
  if (device.match !== "mismatch" || !citesNonExistence(device.reason)) {
    return { device, downgraded: false };
  }
  return {
    downgraded: true,
    device: {
      ...device,
      match: "uncertain",
      reason:
        `Not treated as a mismatch: the grader reported the claimed model as unknown to it, ` +
        `which reflects its training cutoff rather than the phone. Original note — ${device.reason}`,
    },
  };
}
