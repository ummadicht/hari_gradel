import { FUNCTIONAL_TESTS } from "./tests";
import { COSMETIC_TIERS, type CosmeticGrade } from "./grading";

/**
 * The GRADE & FAULT PRICING CATALOG — the money model behind every offer,
 * owned per client and per currency, editable in the console (Pricing tab).
 *
 * Before this, the numbers that turn a grade into an offer lived as hardcoded
 * USD constants in lib/offer.ts: grade multipliers, refurb costs, per-fault
 * repair costs, the battery rule, margin. An INR client therefore quoted with
 * US dollar repair economics behind a ₹ symbol.
 *
 * TWO RULES, both learned the hard way in this codebase:
 *
 *  1. NEVER FX-CONVERT A COST. A ₹ catalog is NOT a $ catalog times a rate — a
 *     display swap is ~$90 in the US and ~₹6,500 in India, which is nothing
 *     like 90 × 83. Each currency has its OWN authored defaults below.
 *  2. SAY WHICH NUMBERS YOU USED. Every catalog reports `source`: "catalog"
 *     when an operator saved it, "default" when it's the starter table. The
 *     console labels it so nobody mistakes a default for a priced decision.
 *
 * This module is PURE (no sqlite) so the console editor can import the types
 * and field lists; lib/priceCatalog.ts holds the server-side store.
 */

export type Currency = "USD" | "INR" | "EUR";

export type PriceCatalog = {
  currency: Currency;
  /** Grade → share of the Grade-A market base (1.0 = base). */
  gradeFactors: Record<CosmeticGrade, number>;
  /** Grade → cosmetic refurb cost, in `currency`. */
  cosmeticRefurb: Record<CosmeticGrade, number>;
  /** Functional test id → repair cost when that test FAILS, in `currency`. */
  faultCosts: Record<string, number>;
  /** Battery health at or below this % is priced as a replacement. */
  batteryThreshold: number;
  batteryCost: number;
  /** Dealer margin as a fraction of graded value (0.15 = 15%). */
  marginRate: number;
  /** Flat top-up added to every unblocked offer, in `currency`. */
  promoBonus: number;
};

export type StoredCatalog = PriceCatalog & {
  source: "catalog" | "default";
  updatedAt?: string;
  updatedBy?: string;
};

export const CURRENCY_SYMBOL: Record<Currency, string> = { USD: "$", INR: "₹", EUR: "€" };

/** Faults an operator can price = the functional tests we actually run. */
export const FAULT_IDS: string[] = FUNCTIONAL_TESTS.map((t) => t.id);
export const FAULT_LABELS: Record<string, string> = Object.fromEntries(
  FUNCTIONAL_TESTS.map((t) => [t.id, t.name || t.id]),
);
export const GRADES = COSMETIC_TIERS as readonly CosmeticGrade[];

// ── Authored starter defaults, one table per currency ────────────────────────
// Grade factors are market-share ratios and hold across currencies; the COSTS
// do not, so each currency gets its own repair economics.

const GRADE_FACTORS: Record<CosmeticGrade, number> = {
  Premium: 1.08,
  A: 1.0,
  B: 0.82,
  C: 0.6,
  D: 0.35,
};

const USD: PriceCatalog = {
  currency: "USD",
  gradeFactors: GRADE_FACTORS,
  cosmeticRefurb: { Premium: 0, A: 5, B: 20, C: 55, D: 110 },
  faultCosts: {
    touch: 90,
    multitouch: 90,
    display: 90,
    camera: 60,
    faceid: 80,
    mic: 40,
    speaker: 40,
    voice: 40,
    motion: 35,
    vibration: 25,
    buttons: 45,
  },
  batteryThreshold: 85,
  batteryCost: 45,
  marginRate: 0.15,
  promoBonus: 0,
};

// India: independent repair-market economics (parts + labour), not a conversion.
const INR: PriceCatalog = {
  currency: "INR",
  gradeFactors: GRADE_FACTORS,
  cosmeticRefurb: { Premium: 0, A: 400, B: 1500, C: 4000, D: 8000 },
  faultCosts: {
    touch: 6500,
    multitouch: 6500,
    display: 6500,
    camera: 3500,
    faceid: 5500,
    mic: 1800,
    speaker: 1800,
    voice: 1800,
    motion: 2200,
    vibration: 1200,
    buttons: 2500,
  },
  batteryThreshold: 85,
  batteryCost: 2500,
  marginRate: 0.15,
  promoBonus: 0,
};

const EUR: PriceCatalog = {
  currency: "EUR",
  gradeFactors: GRADE_FACTORS,
  cosmeticRefurb: { Premium: 0, A: 5, B: 20, C: 50, D: 100 },
  faultCosts: {
    touch: 85,
    multitouch: 85,
    display: 85,
    camera: 55,
    faceid: 75,
    mic: 38,
    speaker: 38,
    voice: 38,
    motion: 32,
    vibration: 22,
    buttons: 42,
  },
  batteryThreshold: 85,
  batteryCost: 42,
  marginRate: 0.15,
  promoBonus: 0,
};

const DEFAULTS: Record<Currency, PriceCatalog> = { USD, INR, EUR };

export function defaultCatalog(currency: Currency): PriceCatalog {
  // Deep copy — callers edit these freely.
  return JSON.parse(JSON.stringify(DEFAULTS[currency])) as PriceCatalog;
}

/**
 * Coerce one number.
 *
 * The asymmetry is deliberate. A value ABOVE the range is a real intention
 * ("charge a lot for this") and clamps to the ceiling. A value BELOW it — a
 * negative repair cost, a negative grade factor — is nonsense input, and
 * clamping it to 0 would silently switch that deduction OFF: a fault priced at
 * zero is never subtracted, so a broken screen would quietly stop costing
 * anything. Nonsense falls back to the default instead. An explicit 0 is still
 * honoured, because "this fault is free to fix" is a legitimate thing to say.
 */
const num = (v: unknown, fallback: number, min: number, max: number): number => {
  const n = typeof v === "string" ? Number(v) : (v as number);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return fallback;
  return Math.min(max, n);
};

/**
 * Coerce arbitrary input into a valid catalog. Anything missing or out of range
 * falls back to that currency's default rather than to zero — a silently-zeroed
 * repair cost would quietly inflate every offer for that fault.
 */
export function normalizeCatalog(input: unknown, currency: Currency): PriceCatalog {
  const d = defaultCatalog(currency);
  const c = (input ?? {}) as Partial<PriceCatalog>;
  const out: PriceCatalog = { ...d, currency };

  for (const g of GRADES) {
    out.gradeFactors[g] = num(c.gradeFactors?.[g], d.gradeFactors[g], 0, 2);
    out.cosmeticRefurb[g] = Math.round(num(c.cosmeticRefurb?.[g], d.cosmeticRefurb[g], 0, 1_000_000));
  }
  out.faultCosts = {};
  for (const id of FAULT_IDS) {
    out.faultCosts[id] = Math.round(num(c.faultCosts?.[id], d.faultCosts[id] ?? 0, 0, 1_000_000));
  }
  out.batteryThreshold = Math.round(num(c.batteryThreshold, d.batteryThreshold, 0, 100));
  out.batteryCost = Math.round(num(c.batteryCost, d.batteryCost, 0, 1_000_000));
  out.marginRate = num(c.marginRate, d.marginRate, 0, 0.9);
  out.promoBonus = Math.round(num(c.promoBonus, d.promoBonus, 0, 1_000_000));
  return out;
}

/** Format money in the catalog's currency — no decimals; offers are whole units. */
export function money(amount: number, currency: Currency): string {
  const n = Math.round(amount);
  const grouped = currency === "INR" ? indianGrouping(n) : n.toLocaleString("en-US");
  return `${CURRENCY_SYMBOL[currency]}${grouped}`;
}

/** 1,50,000 — the lakh/crore grouping an Indian operator expects to read. */
function indianGrouping(n: number): string {
  const s = String(Math.abs(n));
  if (s.length <= 3) return (n < 0 ? "-" : "") + s;
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",");
  return `${n < 0 ? "-" : ""}${rest},${last3}`;
}
