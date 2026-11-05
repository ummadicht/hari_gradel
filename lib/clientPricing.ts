import fs from "node:fs";
import path from "node:path";
import { computeOffer, findModel, type Pricebook } from "./pricebook";
import seed from "./pricebook-swapmore.seed.json";
import { resolveClient } from "./clients";
import type { Session } from "./db";
import { isStructuralFinding, type Finding, type SpecialistId } from "./visionAgents";

/**
 * Did the vision cascade actually locate CRACKED/SHATTERED GLASS on a surface an
 * LCD fault can live on?
 *
 * Reads the structured `findings` (whose `type` is a constrained enum) rather
 * than any prose, and defers to the grader's own isStructuralFinding() gate — so
 * a minor finish chip, an unlocalized guess, or a note describing the ABSENCE of
 * cracks can never price a phone as screen-damaged. `front` is the cover glass
 * and `display` the panel itself; a crack on the rear glass or the frame is real
 * damage but it is not an LCD fault, and the cosmetic grade already carries it.
 */
function hasScreenDamage(cosmetic: Session["cosmetic"]): boolean {
  const specialists = (cosmetic as { specialists?: unknown } | null | undefined)?.specialists;
  if (!Array.isArray(specialists)) return false;
  const SCREEN: SpecialistId[] = ["front", "display"];
  return specialists.some((s) => {
    const id = (s as { id?: SpecialistId })?.id;
    if (!id || !SCREEN.includes(id)) return false;
    const findings = (s as { findings?: Finding[] })?.findings;
    if (!Array.isArray(findings)) return false;
    return findings.some(
      (f) => isStructuralFinding(id, f) && /crack|shatter/i.test(String(f.type || "")),
    );
  });
}

// The swapmore client's pricebook: the live SYNCED copy (data/pricebook-swapmore.json,
// pushed by SwapMore on every admin save) if present, else the SEED snapshot bundled
// at build. Either way GradeIQ HOLDS it (self-contained at quote time), fed from
// SwapMore. computeOffer is byte-identical to SwapMore's → same $.

const DATA_DIR = path.join(process.cwd(), "data");
const bookPath = (clientId: string) => path.join(DATA_DIR, `pricebook-${clientId}.json`);

export function loadPricebook(clientId: string): { book: Pricebook; source: "synced" | "seed" } {
  try {
    const book = JSON.parse(fs.readFileSync(bookPath(clientId), "utf8")) as Pricebook;
    if (book && Array.isArray(book.models) && book.models.length) return { book, source: "synced" };
  } catch {
    /* fall through to seed */
  }
  return { book: seed as Pricebook, source: "seed" };
}

export function savePricebook(clientId: string, book: Pricebook) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(bookPath(clientId), JSON.stringify(book, null, 2));
}

// GradeIQ COSMETIC grade → SwapMore cosmetic grade id. (Cosmetic only — functional
// faults are decomposed separately below so they aren't double-counted.)
const GRADE_TO_COSMETIC: Record<string, string> = {
  Premium: "flawless",
  A: "good",
  B: "fair",
  C: "rough",
  D: "rough",
};
// GradeIQ functional test id → SwapMore fault id. Only FAILED tests become faults.
const TEST_TO_FAULT: Record<string, string> = {
  battery: "battery-weak",
  camera: "camera-issue",
  mic: "speaker-mic",
  speaker: "speaker-mic",
  voice: "speaker-mic",
  faceid: "face-id",
  touch: "lcd-damage",
  multitouch: "lcd-damage",
  charging: "charging-port",
  charge: "charging-port",
  buttons: "buttons-broken",
};

export interface OfferInput {
  model: { id: string; name: string; basePrice: number } | null;
  cosmetic: string;
  faults: string[];
  storage: string;
  carrierLocked: boolean;
  grade: string;
}

/** Decompose a GradeIQ session into SwapMore computeOffer inputs. */
export function sessionToOfferInput(book: Pricebook, s: Session): OfferInput {
  const model = findModel(book, {
    id: (s as unknown as { model_id?: string }).model_id,
    name: s.model || (s.imei_info as { model?: string } | undefined)?.model,
  });
  const grade = s.cosmetic_grade || (s.cosmetic as { grade?: string })?.grade || "";
  const cosmetic = GRADE_TO_COSMETIC[grade] ?? "fair"; // unknown → conservative mid
  const faults: string[] = [];
  for (const [testId, res] of Object.entries(s.functional || {})) {
    if (res === "fail") {
      const f = TEST_TO_FAULT[testId];
      if (f && !faults.includes(f)) faults.push(f);
    }
  }
  // A Gemini cosmetic cascade that flags a cracked/shattered SCREEN → lcd-damage.
  //
  // This used to be `/crack|shatter/i.test(JSON.stringify(s.cosmetic))` — a
  // substring match over the ENTIRE serialized result, prose included. Every
  // component writes a `notes` sentence, and the grader's habit is to state the
  // absence: "Front glass is clean with no visible scratches, chips, or cracks."
  // That sentence contains "crack", so it added an lcd-damage fault and CUT THE
  // PAYOUT on a phone whose screen was explicitly described as flawless. Across
  // the 44 production sessions this fired 30 times and only 10 had any crack
  // finding at all — 20 phones (including an iPhone 16 Pro graded Premium) were
  // priced as screen-damaged because the report said they weren't.
  //
  // Now it reads the structured findings, not the prose, and only from the
  // surfaces an LCD fault can actually live on — sharing isStructuralFinding()
  // with the grader so price and grade can never disagree about what damage is.
  if (!faults.includes("lcd-damage") && hasScreenDamage(s.cosmetic)) {
    faults.push("lcd-damage");
  }
  const storage =
    (((s.device as { storageText?: string } | undefined)?.storageText || "").match(/\d+\s?(gb|tb)/i)?.[0] || "")
      .toUpperCase()
      .replace(/\s/g, "") || book.defaultStorage;
  const carrierLocked = (s.imei_info as { lock?: string } | undefined)?.lock === "locked";
  return { model, cosmetic, faults, storage, carrierLocked, grade };
}

export interface ClientOffer {
  value: number | null;
  currency: string; // the BOOK's currency ("USD" | "INR" | …) — never FX-converted
  matched: boolean; // did we resolve the model in the pricebook?
  source: "synced" | "seed";
  input: OfferInput;
}

/**
 * Grade-A market base for a model IN THIS CLIENT'S CURRENCY, or null.
 *
 * The offer engine multiplies everything off this number, so it must come from
 * a book denominated in the currency we're about to quote in. A book whose
 * currency doesn't match the tenant's is ignored rather than converted — a USD
 * base shown behind a ₹ sign is a fabricated price, not a rounding issue.
 */
export function marketBaseFor(
  clientId: string,
  currency: string,
  model: string,
  modelId?: string,
): number | null {
  const { book } = loadPricebook(clientId);
  if (!book || (book.currency && book.currency !== currency)) return null;
  const m = findModel(book, { id: modelId, name: model });
  return m ? m.basePrice : null;
}

/**
 * The pricebook offer for a session, in the SESSION'S CLIENT's book. Formerly
 * hardcoded to the US swapmore book (+USD), which would price an India tenant
 * off the wrong market. Resolution order:
 *   1. the client's own synced book (data/pricebook-<clientId>.json)
 *   2. for an INR client without one → the synced swapmore-in India book
 *      (same market) — never the USD seed behind a ₹ sign
 *   3. the bundled USD seed, only for USD tenants
 * A book whose currency doesn't match the tenant's is treated as "no book"
 * (specialist quote), never FX-converted — per the catalog's own rule.
 */
export function clientOffer(s: Session, clientId?: string): ClientOffer {
  const client = resolveClient(clientId ?? (s as { client_id?: string }).client_id);
  let { book, source } = loadPricebook(client.id);
  const bookCur = (book.currency as string) || "USD";
  if (client.currency === "INR" && bookCur !== "INR" && client.id !== "swapmore-in") {
    const india = loadPricebook("swapmore-in");
    if (((india.book.currency as string) || "USD") === "INR") ({ book, source } = india);
  }
  const finalCur = (book.currency as string) || "USD";
  const input = sessionToOfferInput(book, s);
  // Wrong-currency book → refuse to fabricate a price in the tenant's currency.
  if (finalCur !== client.currency) {
    return { value: null, currency: client.currency, matched: false, source, input };
  }
  const value = input.model
    ? computeOffer(book, {
        basePrice: input.model.basePrice,
        cosmetic: input.cosmetic,
        storage: input.storage,
        faults: input.faults,
        carrierLocked: input.carrierLocked,
      })
    : null;
  return { value, currency: finalCur, matched: !!input.model, source, input };
}

/** Back-compat alias (existing console + valuation callers). */
export const swapmoreOffer = clientOffer;
