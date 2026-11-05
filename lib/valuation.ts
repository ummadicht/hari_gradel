import type { Session } from "./db";
import { computeTrust } from "./trust";
import { resolveClient } from "./clients";
import { swapmoreOffer } from "./clientPricing";

// Estimated trade / residual value. HONEST: this is a heuristic (model tier ×
// grade factor × functional/identity confidence), not a live pricebook — it is
// always labelled "estimated". A real deployment swaps modelBase for a live
// wholesale feed; the shape stays the same.

const GRADE_FACTOR: Record<string, number> = {
  Premium: 1.0,
  A: 0.86,
  B: 0.66,
  C: 0.46,
  D: 0.24,
  "—": 0.5,
};

// Very rough model → new-ish wholesale anchor (EUR). Pattern-matched.
//
// Returns NULL for a device we can't recognise. It used to fall back to a flat
// 420, which meant a model that doesn't exist still produced a confident live
// estimate — and it disagreed with lib/offer.ts computeOffer, which refuses to
// price an unknown model at all. Two engines quoting different numbers for the
// same phone is exactly how a valuation stops being trustworthy.
function modelBase(model: string): number | null {
  const m = (model || "").toLowerCase();
  if (/iphone/.test(m)) {
    if (/1[6-9].*pro max|pro max/.test(m)) return 1150;
    if (/1[6-9].*pro|17 pro|16 pro/.test(m)) return 1000;
    if (/1[6-9]|air/.test(m)) return 820;
    if (/1[3-5].*pro/.test(m)) return 720;
    if (/1[3-5]/.test(m)) return 560;
    if (/se/.test(m)) return 260;
    return 480;
  }
  if (/galaxy|samsung/.test(m)) {
    if (/ultra|fold/.test(m)) return 1000;
    if (/s2\d|flip/.test(m)) return 700;
    if (/\ba\d\d/.test(m)) return 260;
    return 480;
  }
  if (/pixel/.test(m)) return /pro/.test(m) ? 620 : 440;
  if (/oneplus/.test(m)) return 480;
  return null;
}

export type Valuation = {
  value: number; // estimated, in `currency`
  currency: string; // "EUR" | "USD" | "INR" — whatever the client's book quotes in
  grade: string;
  confidence: number; // 0..1 (from Trust Score)
  estimated: true;
  note: string;
};

export function estimateValue(s: Session): Valuation {
  const trust = computeTrust(s);

  // Per-client pricing: the "swapmore" client prices from SwapMore's synced
  // pricebook (USD) so the offer == SwapMore's own buyback price. Other clients
  // keep GradeIQ's EUR heuristic below.
  const client = resolveClient((s as { client_id?: string }).client_id);
  if (client.pricing === "swapmore") {
    const o = swapmoreOffer(s);
    if (o.value != null) {
      return {
        value: o.value,
        currency: o.currency,
        grade: o.input.grade || trust.grade || "—",
        confidence: Math.round((trust.score / 100) * 100) / 100,
        estimated: true,
        note: `${client.name} price for a ${o.input.model?.name || s.model || "device"}${
          o.input.faults.length ? ` (−${o.input.faults.length} fault${o.input.faults.length > 1 ? "s" : ""})` : ""
        }${o.input.carrierLocked ? ", carrier-locked" : ""}.`,
      };
    }
    // Model not in the client's catalog → no firm price; show a clear note.
    return {
      value: 0,
      currency: client.currency,
      grade: trust.grade || "—",
      confidence: Math.round((trust.score / 100) * 100) / 100,
      estimated: true,
      note: `${s.model || "This device"} isn't in the ${client.name} catalog yet — a specialist will quote it.`,
    };
  }

  const grade = trust.grade || "—";
  const base = modelBase(s.model || (s.imei_info as any)?.model || "");
  // Unrecognised device → no estimate, same stance as computeOffer. Showing a
  // number here would contradict the offer engine on the very same session.
  if (base === null) {
    return {
      value: 0,
      currency: "EUR",
      grade,
      confidence: 0,
      estimated: true,
      note: `${s.model || "This device"} isn't in the price book — a specialist will quote it.`,
    };
  }
  const gradeF = GRADE_FACTOR[grade] ?? 0.5;
  // Trust dampens the offer: low confidence (unverified / provisional) reduces it.
  const trustF = 0.7 + 0.3 * (trust.score / 100);
  const value = Math.max(0, Math.round(base * gradeF * trustF));
  return {
    value,
    currency: "EUR",
    grade,
    confidence: Math.round((trust.score / 100) * 100) / 100,
    estimated: true,
    note:
      grade === "—"
        ? "Complete the cosmetic scan for a firm figure."
        : `Estimated for a Grade ${grade} ${s.model || "device"} at ${trust.score}/100 confidence.`,
  };
}
