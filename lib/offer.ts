// The AI Offer Engine — GradeIQ's competitive layer. It fuses:
//   • AI cosmetic grade   (Gemini)
//   • functional results  (the gamified browser tests)
//   • trusted diagnostics (Phonecheck: battery, FMiP, erase)
//   • IMEI intel          (model, blacklist, carrier-lock)
//   • live market price    (wholesale resale)
//   • refurbishment cost   (repair prediction)
// …into a single trade-in offer WITH a plain-English explanation and fraud
// flags. This is the "explain why that offer was made" advantage.

import { COSMETIC_TIERS, type FunctionalResults } from "./grading";
import type { ImeiInfo } from "./imei";
import type { PhonecheckReport } from "./phonecheck";
import type { ProgramConfig } from "./programConfig";
import { defaultCatalog, money, type PriceCatalog } from "./priceCatalogTypes";

type Pricing = ProgramConfig["pricing"];

// Seed wholesale resale prices (USD, Grade A baseline). A real deployment pulls
// these live from a market feed; overridable via the settings table.
const MARKET_BASE: Record<string, number> = {
  "iPhone 15 Pro Max": 900,
  "iPhone 15 Pro": 780,
  "iPhone 14 Pro": 640,
  "iPhone 14": 480,
  "iPhone 13 Pro": 520,
  "iPhone 13": 400,
  "iPhone 12": 280,
  "Galaxy S22 Ultra": 430,
  "Galaxy S21 5G": 250,
  "Pixel 7": 260,
  "11 5G": 220,
};

/**
 * Grade-A market base for a model, or NULL when we genuinely don't know it.
 *
 * This used to return a flat 180 for anything unrecognised, which is how a
 * device whose model doesn't even exist ("iPhone 17 Pro Max") still produced a
 * confident $180 → $18 offer. A made-up base is worse than no offer: every
 * number downstream inherits the fiction. Unknown model → no price, say so.
 */
function baseFor(model: string, pricing?: Pricing): number | null {
  if (!model) return null;
  const lc = model.toLowerCase();
  // Configurator/admin overrides win over the seed table.
  const ov = pricing?.marketBase ?? {};
  const ovHit = Object.keys(ov).find((k) => lc.includes(k.toLowerCase()));
  if (ovHit) return ov[ovHit];
  const hit = Object.keys(MARKET_BASE).find((k) => lc.includes(k.toLowerCase()));
  return hit ? MARKET_BASE[hit] : null;
}
// Every "what does a grade or a fault cost" number now comes from the client's
// PRICE CATALOG (lib/priceCatalogTypes.ts) — per tenant, per currency, editable
// in the console. These readers are the only way the engine sees those numbers.
const gradeFactor = (grade: string, cat: PriceCatalog): number =>
  cat.gradeFactors[grade as keyof PriceCatalog["gradeFactors"]] ?? 0.6;
const repairCost = (id: string, cat: PriceCatalog): number | undefined => cat.faultCosts[id];
const cosmeticRefurb = (grade: string, cat: PriceCatalog): number =>
  cat.cosmeticRefurb[grade as keyof PriceCatalog["cosmeticRefurb"]] ?? 0;

export type OfferLine = { label: string; amount: number };
export type Offer = {
  currency: string;
  marketBase: number; // grade-A wholesale
  gradedValue: number; // after (worst-case, if provisional) cosmetic grade
  refurbCost: number;
  margin: number;
  offer: number; // final trade-in offer (never < 0)
  lines: OfferLine[]; // itemized deductions (negative)
  explanation: string[];
  flags: string[]; // fraud / lock / blacklist blockers
  blocked: boolean; // hard-stop (blacklisted / locked / FMiP on)
  needsModel: boolean; // device model unknown — can't price it
  // Risk-shared provisional (when cosmetics couldn't be conclusively graded):
  provisional: boolean;
  floor?: number; // worst-case net (buyback-protected)
  ceiling?: number; // best-case net (if condition verifies)
  gradeRange?: { best: string; worst: string };
};

// Fraction of the best-vs-worst upside handed to the customer up front. The
// remainder is held back as the buyback's risk buffer. 0.6 = customer-friendly
// but still protected.
const CUSTOMER_SHARE = 0.6;

// The lowest cosmetic tier: what a phone nobody has looked at is surely worth.
const LOWEST_TIER: string = COSMETIC_TIERS[COSMETIC_TIERS.length - 1];

// Net offer for one concrete cosmetic grade, plus the itemized lines/refurb.
function netForGrade(
  grade: string,
  marketBase: number,
  functional: FunctionalResults,
  battery: number | undefined,
  marginRate: number,
  cat: PriceCatalog
): { net: number; gradedValue: number; refurbCost: number; margin: number; lines: OfferLine[] } {
  const gradedValue = Math.round(marketBase * gradeFactor(grade, cat));
  const lines: OfferLine[] = [];
  let refurbCost = 0;
  for (const [id, r] of Object.entries(functional)) {
    const rc = repairCost(id, cat);
    if (r === "fail" && rc) {
      refurbCost += rc;
      lines.push({ label: `Repair: ${id}`, amount: -rc });
    }
  }
  const cosRefurb = cosmeticRefurb(grade, cat);
  if (cosRefurb) {
    refurbCost += cosRefurb;
    lines.push({ label: "Cosmetic refurb", amount: -cosRefurb });
  }
  if (typeof battery === "number" && battery < cat.batteryThreshold && cat.batteryCost > 0) {
    refurbCost += cat.batteryCost;
    lines.push({ label: `Battery ${battery}% → replace`, amount: -cat.batteryCost });
  }
  const margin = Math.round(gradedValue * marginRate);
  lines.push({ label: `Dealer margin (${Math.round(marginRate * 100)}%)`, amount: -margin });
  const net = Math.max(0, gradedValue - refurbCost - margin);
  return { net, gradedValue, refurbCost, margin, lines };
}

export function computeOffer(input: {
  model: string;
  cosmetic: {
    grade: string;
    conclusive?: boolean;
    gradeRange?: { best: string; worst: string };
    /** The seller's own pick, unchecked (lib/sessionWriteRules.ts manualCosmetic). */
    provisional?: boolean;
  };
  functional: FunctionalResults;
  imei?: Partial<ImeiInfo>;
  phonecheck?: Partial<PhonecheckReport>;
  marginRate?: number; // dealer margin, default = the catalog's
  pricing?: Pricing; // legacy Configurator overrides (marketBase table only)
  /**
   * The client's grade & fault price catalog — the money model, in the client's
   * OWN currency. Omitted → USD starter defaults.
   */
  catalog?: PriceCatalog;
  /**
   * Grade-A market base in the CATALOG's currency, resolved by the caller from
   * that client's pricebook. `null` = we have no price for this model in this
   * currency, and will say so rather than quoting a converted or foreign one.
   * Omitted (undefined) → fall back to the built-in USD seed table.
   */
  marketBase?: number | null;
  // Vision signals. These were previously DETECTED and then ignored here, so a
  // case-obscured suspected counterfeit still produced an acceptable offer.
  vision?: {
    obstruction?: { present?: boolean; type?: string; note?: string };
    deviceMatch?: "match" | "mismatch" | "uncertain";
    oemVerdict?: "likely_oem" | "suspect_aftermarket" | "inconclusive";
  };
}): Offer {
  const {
    model,
    cosmetic,
    functional,
    imei = {},
    phonecheck = {},
    pricing,
    catalog,
    vision = {},
    marginRate = catalog?.marginRate ?? pricing?.marginRate ?? 0.15,
  } = input;
  // The money model in force. Omitted → USD starter defaults, so an unwired
  // caller behaves exactly as before rather than silently zeroing every cost.
  const cat = catalog ?? defaultCatalog("USD");
  const cur = cat.currency;
  const amt = (n: number) => money(n, cur);

  // No model → no price. We won't invent a dollar figure for an unknown device.
  const needsModel = !model.trim() || /^unknown/i.test(model.trim());
  if (needsModel) {
    return {
      currency: cur,
      marketBase: 0,
      gradedValue: 0,
      refurbCost: 0,
      margin: 0,
      offer: 0,
      lines: [],
      explanation: [
        "Device model unknown — scan the IMEI (or enter the model) to price it.",
      ],
      flags: [],
      blocked: false,
      needsModel: true,
      provisional: false,
    };
  }

  // Unknown model → we will NOT invent a base. Everything downstream (graded
  // value, repair deductions, margin, the final offer) multiplies off this
  // number, so a fabricated base produces a fabricated offer that looks precise.
  // The caller owns the base when it knows the client's own pricebook; only a
  // USD tenant may fall back to the built-in USD seed table.
  const knownBase =
    input.marketBase !== undefined
      ? input.marketBase
      : cur === "USD"
        ? baseFor(model, pricing)
        : null;
  if (knownBase === null) {
    return {
      currency: cur,
      marketBase: 0,
      gradedValue: 0,
      refurbCost: 0,
      margin: 0,
      offer: 0,
      lines: [],
      explanation: [
        `"${model}" isn't in the price book, so there is no market value to price against.`,
        "Add this model to the catalogue (or correct the model) to get an offer.",
      ],
      flags: [`❓ Unrecognised model "${model}" — not priced.`],
      blocked: true,
      needsModel: true,
      provisional: false,
    };
  }
  const marketBase = knownBase;
  const battery = phonecheck.batteryHealth;
  const explanation: string[] = [];
  const flags: string[] = [];

  explanation.push(
    `Market resale for ${model || "this model"} at Grade A is ${amt(marketBase)}.`
  );

  // A seller's own pick (no photo grade, no store check — SUP-66) is a claim,
  // not a grade. Priced at the pick, it paid out on the seller's word alone:
  // pick "Premium", accept, and the session locked at the Premium price. It is
  // priced at the LOWEST grade instead, with no uncertainty share (a share of
  // the gap would still pay more for a higher pick), and shows what the pick
  // is worth once the store confirms it.
  const sellerPick = cosmetic.provisional === true && !cosmetic.gradeRange && !!cosmetic.grade;
  const gradeRange = cosmetic.gradeRange ?? (sellerPick ? { best: cosmetic.grade, worst: LOWEST_TIER } : undefined);

  // Risk-shared provisional path: cosmetics couldn't be conclusively graded.
  const provisional = (cosmetic.conclusive === false && !!cosmetic.gradeRange) || sellerPick;

  let base;
  let floor: number | undefined;
  let ceiling: number | undefined;
  let provisionalOffer: number | undefined;

  if (provisional && gradeRange) {
    const { best, worst } = gradeRange;
    const worstCalc = netForGrade(worst, marketBase, functional, battery, marginRate, cat);
    const bestCalc = netForGrade(best, marketBase, functional, battery, marginRate, cat);
    floor = worstCalc.net;
    ceiling = bestCalc.net;
    const share = sellerPick ? 0 : Math.round((ceiling - floor) * CUSTOMER_SHARE);
    base = worstCalc; // breakdown shown at the conservative grade
    if (sellerPick) {
      explanation.push(
        `You picked grade ${best}, but nothing has checked the phone's condition yet — so the offer is at grade ${worst} for now.`
      );
      explanation.push(`Up to ${amt(ceiling)} once the store confirms grade ${best}.`);
    } else {
      explanation.push(
        `Cosmetics weren't conclusive — plausible grade ${best}–${worst}.`
      );
      explanation.push(
        `Worst-case value ${amt(floor)}, best-case ${amt(ceiling)}. We share the uncertainty: ${amt(
          share
        )} of the ${amt(ceiling - floor)} gap goes to you now (buffer for you), the rest is held for our risk.`
      );
    }
    if (base.refurbCost) explanation.push(`Refurb at worst-case: ${amt(base.refurbCost)}.`);
    provisionalOffer = floor + share;
    // Show the customer's uncertainty buffer as a positive line so the
    // breakdown reconciles to the provisional offer.
    if (!sellerPick) base.lines.push({ label: "Uncertainty share (to you)", amount: share });
  } else {
    base = netForGrade(cosmetic.grade || "C", marketBase, functional, battery, marginRate, cat);
    explanation.push(
      `Cosmetic grade ${cosmetic.grade || "?"} → resale ${amt(base.gradedValue)}.`
    );
    if (base.refurbCost) explanation.push(`Predicted refurbishment: ${amt(base.refurbCost)}.`);
  }

  if (typeof battery === "number" && battery < cat.batteryThreshold && cat.batteryCost > 0)
    explanation.push(
      `Battery ${battery}% (<${cat.batteryThreshold}%) — priced in a ${amt(cat.batteryCost)} replacement.`
    );

  let offer = provisional ? provisionalOffer ?? base.net : base.net;

  // Fraud / trust blockers.
  const black = imei.blacklist === "blacklisted" || phonecheck.blacklist === "blacklisted";
  const locked = imei.lock === "locked" || phonecheck.simLock === "locked";
  const findMyOn = phonecheck.fmip === "on";
  // MDM enrolment used to be read AS Find My (it was the first field the
  // station parser looked at), so an MDM-managed phone was blocked under the
  // Find My flag. Find My now comes only from the activation-lock fields; MDM
  // keeps blocking, under its own name.
  const mdmOn = phonecheck.mdm === "on";
  const fmipOn = findMyOn || mdmOn;
  if (black) flags.push("⛔ IMEI blacklisted (lost/stolen/unpaid) — cannot accept.");
  if (findMyOn) flags.push("🔒 Find My iPhone / activation lock is ON — must be removed.");
  if (mdmOn) flags.push("🔒 Device management (MDM) is ON — must be released before payout.");
  if (locked) flags.push("📶 Carrier-locked — reduces resale, verify before payout.");

  // ── Vision-signal hard stops ──
  // These were detected by the inspection and then ignored here, which is how a
  // device wearing a case that hid its back/frame/cameras — and flagged as a
  // suspected counterfeit — still produced a firm, acceptable offer. A price is
  // only meaningful once we know WHAT the device is and have actually SEEN it.
  const obstructed = vision.obstruction?.present === true;
  const wrongModel = vision.deviceMatch === "mismatch";
  const suspectParts = vision.oemVerdict === "suspect_aftermarket";
  if (obstructed) {
    flags.push(
      `📵 ${vision.obstruction?.note || "A case/cover hides the device"} — remove it and retake before pricing.`
    );
  }
  if (wrongModel) flags.push("🚩 Photographed device does not match the claimed model — verify identity.");
  if (suspectParts) flags.push("🔧 Suspected non-OEM/aftermarket parts — verify before payout.");

  const blocked = black || fmipOn || obstructed || wrongModel || suspectParts;
  if (blocked) {
    explanation.push("Offer blocked pending the flags above.");
    offer = 0;
  }

  // Promotion bonus (Configurator) — a flat top-up on live offers.
  const promo = cat.promoBonus || pricing?.promoBonus || 0;
  if (promo > 0 && !blocked && offer > 0) {
    base.lines.push({ label: "🎁 Promo bonus", amount: promo });
    explanation.push(`Promo bonus: +${amt(promo)}.`);
    offer += promo;
    if (typeof floor === "number") floor += promo;
    if (typeof ceiling === "number") ceiling += promo;
  }

  return {
    currency: cur,
    marketBase,
    gradedValue: base.gradedValue,
    refurbCost: base.refurbCost,
    margin: base.margin,
    offer,
    lines: base.lines,
    explanation,
    flags,
    blocked,
    needsModel: false,
    provisional,
    floor,
    ceiling,
    gradeRange,
  };
}
