// SwapMore PRICEBOOK consumer — the type + offer math, COPIED VERBATIM from
// swapmore/src/lib/pricebook.ts so a synced book reproduces SwapMore's exact
// buyback offer. `computeOffer` reads everything from `book` (no SwapMore imports),
// so identical code + identical book data ⇒ identical $. Keep in lockstep with
// SwapMore; parity is asserted by a Node test at build time.

export interface Pricebook {
  currency: "USD";
  schema: 1;
  constants: {
    marginRate: number;
    processingCost: number;
    scrapFloorRate: number;
    carrierLockPenalty: number;
  };
  storageMultipliers: Record<string, number>;
  defaultStorage: string;
  reconCosts: Record<string, number>;
  repairCosts: Record<string, { part: number; labor: number }>;
  cosmeticGrades: { id: string; label: string }[];
  functionalIssues: { id: string; label: string }[];
  models: { id: string; brand: string; name: string; basePrice: number }[];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function computeOffer(
  book: Pricebook,
  input: {
    basePrice: number;
    cosmetic: string; // pricebook cosmetic grade id (flawless|good|fair|rough)
    storage?: string;
    faults?: string[]; // pricebook fault ids
    carrierLocked?: boolean;
  },
): number {
  const { marginRate, processingCost, scrapFloorRate, carrierLockPenalty } = book.constants;
  const storageMult = book.storageMultipliers[input.storage ?? book.defaultStorage] ?? 1;
  const cleanBase = input.basePrice * storageMult;
  const resale = Math.round((cleanBase + processingCost) / (1 - marginRate));
  const partTier = clamp(resale / 300, 0.6, 2.4);
  const laborTier = clamp(resale / 300, 0.85, 1.4);
  const reconTier = clamp(resale / 300, 0.8, 1.8);

  let repairsTotal = 0;
  for (const id of input.faults ?? []) {
    const r = book.repairCosts[id];
    if (!r) continue;
    repairsTotal += Math.round(r.part * partTier + r.labor * laborTier);
  }
  const reconCost = Math.round((book.reconCosts[input.cosmetic] ?? book.reconCosts.fair ?? 0) * reconTier);
  const margin = Math.round(resale * marginRate);
  const raw = resale - repairsTotal - reconCost - processingCost - margin;
  const floor = Math.round(resale * scrapFloorRate);
  const offer = Math.max(floor, Math.round(raw));
  const locked = input.carrierLocked ? 1 - carrierLockPenalty : 1;
  return Math.round(offer * locked);
}

/** Look up a model in the book by id, then by loose name match (GradeIQ knows names). */
export function findModel(book: Pricebook, opts: { id?: string; name?: string }) {
  if (opts.id) {
    const byId = book.models.find((m) => m.id === opts.id);
    if (byId) return byId;
  }
  const n = (opts.name || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!n) return null;
  return (
    book.models.find((m) => m.name.toLowerCase() === n) ||
    book.models.find((m) => m.name.toLowerCase().replace(/\s+/g, "") === n.replace(/\s+/g, "")) ||
    null
  );
}
