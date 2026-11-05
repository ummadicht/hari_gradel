// IMEI lookup. Given a 15-digit IMEI, an IMEI-check API returns the device
// make/model (from the TAC — the first 8 digits) plus status signals like
// blacklist and carrier-lock. GradeIQ fuses this with its own functional +
// cosmetic grading. Runs on a local TAC stub until IMEI_API_KEY is set, exactly
// like the Gemini cosmetic grader — so the flow always works.

import type { PhonecheckReport } from "./phonecheck";
import type { ImeiSource } from "./imeiSource";
export { isLiveImeiSource, type ImeiSource } from "./imeiSource";

export type ImeiInfo = {
  imei: string;
  valid: boolean; // passes Luhn checksum
  tac: string;
  brand: string;
  model: string;
  /**
   * The manufacturer's part number when the source carries one — Samsung's
   * GSMA answer says "Galaxy Z Flip5" in `model` and "SM-F731W" here. A
   * catalogue matched on model codes needs this, not the marketing name.
   * null when the source has none (TAC, stub, ESN, Apple's repeated name).
   */
  modelNumber: string | null;
  blacklist: "clean" | "blacklisted" | "unknown";
  lock: "unlocked" | "locked" | "unknown";
  /** iCloud / Find My / activation lock (Apple), when the source reports it. */
  fmip: "off" | "on" | "unknown";
  // Some providers return a market/condition grade — surfaced if present.
  reportedGrade?: string;
  source: ImeiSource;
  /**
   * Set when the paid lookup was deliberately NOT made for this caller
   * (lib/lookupBudget.ts): "daily-cap" — this IP used up its anonymous lookups
   * for the day; "total-cap" — all anonymous callers together did;
   * "no-channel" — an anonymous caller from no known channel.
   * The answer is then the free TAC one, and the identity reads as unverified.
   */
  skipped?: "daily-cap" | "total-cap" | "no-channel";
};

// Offline TAC → model database (~97k major-brand entries), loaded once and
// cached. Lets us resolve make/model straight from the IMEI's TAC (first 8
// digits) with no external API — the same approach aikon's free tool uses, but
// with a real database behind it. Loaded lazily via fs (never bundled).
let TACDB: Record<string, string> | null = null;
function tacDb(): Record<string, string> {
  if (TACDB) return TACDB;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    TACDB = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "lib", "tacdb.json"), "utf8")
    );
  } catch {
    TACDB = {};
  }
  return TACDB!;
}

// "Apple Iphone Air" → { brand: "Apple", model: "iPhone Air" } (fix casing).
function splitName(name: string): { brand: string; model: string } {
  const fixed = name
    .replace(/\bIphone\b/g, "iPhone")
    .replace(/\bIpad\b/g, "iPad")
    .replace(/\bIpod\b/g, "iPod");
  const parts = fixed.split(" ");
  const brand = parts[0] || "";
  const model = parts.slice(1).join(" ") || fixed;
  return { brand, model };
}

// Resolve make/model from the TAC via the offline database. No blacklist/carrier
// (those genuinely need Phonecheck) — honest "unknown" for those.
export function tacLookup(imei: string): ImeiInfo | null {
  const tac = imei.slice(0, 8);
  const name = tacDb()[tac];
  if (!name) return null;
  const { brand, model } = splitName(name);
  return {
    imei,
    valid: luhnValid(imei),
    tac,
    brand,
    model,
    modelNumber: null,
    blacklist: "unknown",
    lock: "unknown",
    fmip: "unknown",
    source: "tac",
  };
}

// IMEI carries a Luhn checksum — free, offline validity check. Lives in the
// dependency-free lib/luhn.ts so client components (the scanner) can use it too;
// re-exported here for existing server-side importers.
export { luhnValid } from "./luhn";
import { luhnValid } from "./luhn";

// Illustrative TAC → model map for the offline stub (real APIs cover the full
// GSMA TAC database). Keyed by the first 8 IMEI digits.
const TAC_MAP: Record<string, { brand: string; model: string }> = {
  "35342111": { brand: "Apple", model: "iPhone 13 Pro" },
  "35674108": { brand: "Apple", model: "iPhone 14" },
  "35328111": { brand: "Apple", model: "iPhone 12" },
  "35316609": { brand: "Samsung", model: "Galaxy S21 5G" },
  "35847709": { brand: "Samsung", model: "Galaxy S22 Ultra" },
  "86234705": { brand: "Google", model: "Pixel 7" },
  "35480108": { brand: "OnePlus", model: "11 5G" },
};


function stubLookup(imei: string): ImeiInfo {
  const tac = imei.slice(0, 8);
  const valid = luhnValid(imei);
  const hit = TAC_MAP[tac];
  // Only claim a make/model for TACs we actually know. For anything else, be
  // honest: "Unknown" — never invent a brand (a real make/model needs the ESN /
  // Phonecheck lookup). Status is likewise unknown for unmapped devices.
  if (!hit) {
    return {
      imei,
      valid,
      tac,
      brand: "",
      model: `Unknown device (TAC ${tac})`,
      modelNumber: null,
      blacklist: "unknown",
      lock: "unknown",
      fmip: "unknown",
      source: "stub",
    };
  }
  return {
    imei,
    valid,
    tac,
    brand: hit.brand,
    model: hit.model,
    modelNumber: null,
    // A seed TAC can identify a demo model, but it contains no live status.
    // Never turn the IMEI suffix into blacklist, carrier-lock or Find My facts.
    blacklist: "unknown",
    lock: "unknown",
    fmip: "unknown",
    source: "stub",
  };
}

/**
 * IMEI → make/model from the offline TAC database (or the seed stub) only.
 * Spends nothing and calls nothing: the answer for a caller who may not spend a
 * paid lookup. Status (blacklist, lock, Find My) stays "unknown".
 */
export function freeLookup(rawImei: string): ImeiInfo {
  const imei = String(rawImei ?? "").replace(/\D/g, "").slice(0, 15);
  return tacLookup(imei) ?? stubLookup(imei);
}

/**
 * A Phonecheck answer → ImeiInfo, or null when it identified nothing.
 *
 * Pure, so a caller that already holds the ONE Phonecheck report for an IMEI
 * (session create, the lookup cache) derives the identity from it instead of
 * paying for the same lookup a second time.
 */
export function imeiInfoFromReport(imei: string, pc: PhonecheckReport | null | undefined): ImeiInfo | null {
  if (!pc?.found || !pc.model) return null;
  // Only a station record ("api") or the GSMA registry ("gsma") is a lookup;
  // a demo report is labelled and never reaches here (found: false).
  if (pc.source !== "api" && pc.source !== "gsma") return null;
  return {
    imei,
    valid: luhnValid(imei),
    tac: imei.slice(0, 8),
    brand: pc.make ?? "",
    model: pc.model,
    modelNumber: pc.modelNumber || null,
    blacklist: pc.blacklist,
    lock: pc.simLock,
    fmip: pc.fmip,
    source: pc.source === "gsma" ? "gsma" : "station",
  };
}

/**
 * IMEI → make/model/status, best source first.
 *
 * `opts.phonecheck` is the caller's own getPhonecheck() answer for this IMEI.
 * When it is passed, Phonecheck is NOT called again — that is how session
 * create and the lookup cache keep a trade-in to one paid lookup.
 */
export async function lookupImei(
  rawImei: string,
  opts: { phonecheck?: PhonecheckReport | null } = {}
): Promise<ImeiInfo> {
  const { getSetting } = await import("./settings");
  const imei = rawImei.replace(/\D/g, "").slice(0, 15);

  // 1) Pure-IMEI ESN check (api.phonecheck.com v2 most-accurate) — works for ANY
  //    IMEI without a physical test. Best source for model + blacklist. Makes no
  //    call at all unless a v2 credential is configured (production has none).
  if (imei.length === 15) {
    try {
      const { esnCheck } = await import("./phonecheck");
      const esn = await esnCheck(imei);
      if (esn?.found && esn.model) {
        return {
          imei,
          valid: luhnValid(imei),
          tac: imei.slice(0, 8),
          brand: esn.make ?? "",
          model: esn.model,
          modelNumber: null,
          blacklist: esn.blacklist,
          lock: esn.simLock,
          fmip: esn.fmip,
          source: "esn",
        };
      }
    } catch {
      /* fall through */
    }
  }

  // 2) Phonecheck, ONCE: getPhonecheck asks the station database and, when the
  //    device was never on a station (the ordinary consumer case), the GSMA
  //    registry via CheckEsn — same Cloud DB credentials. That registry answer
  //    is what resolves a consumer trade-in: make, model, model number and
  //    lost/stolen status. It cannot see SIM lock or Find My, so those stay
  //    honestly "unknown" — tier (1) is the only source for those.
  //
  //    This used to be followed by a SEPARATE CheckEsn tier, which repeated the
  //    registry call getPhonecheck had just made whenever it found nothing.
  const pcKey = getSetting("phonecheck_key", "PHONECHECK_API_KEY");
  const pcUser = getSetting("phonecheck_username", "PHONECHECK_USERNAME");
  if (imei.length === 15 && (opts.phonecheck !== undefined || (pcKey && pcUser))) {
    try {
      let pc = opts.phonecheck;
      if (pc === undefined) {
        const { getPhonecheck } = await import("./phonecheck");
        pc = await getPhonecheck(imei);
      }
      const fromPc = imeiInfoFromReport(imei, pc);
      if (fromPc) return fromPc;
      // A station record without a model is the one case the registry was not
      // already asked for a name.
      if (pc?.found && pc.source === "api" && pcKey && pcUser) {
        const { gsmaCheck } = await import("./phonecheck");
        const fromGsma = imeiInfoFromReport(imei, await gsmaCheck(imei));
        if (fromGsma) return fromGsma;
      }
    } catch {
      /* fall through */
    }
  }

  const key = getSetting("imei_key", "IMEI_API_KEY");
  const url = getSetting("imei_url", "IMEI_API_URL"); // e.g. imeicheck.com

  // No external IMEI API configured → resolve model from the offline TAC DB
  // (real, IMEI-based); only if that misses fall to the seed stub.
  if (!key || !url || imei.length !== 15)
    return tacLookup(imei) ?? stubLookup(imei);

  try {
    // Providers differ; this targets a common "?imei=&key=" JSON shape and maps
    // defensively, falling back to the stub on anything unexpected.
    const res = await fetch(
      `${url}${url.includes("?") ? "&" : "?"}imei=${imei}&key=${key}`,
      { headers: { Accept: "application/json" } }
    );
    if (!res.ok) throw new Error(`IMEI API ${res.status}`);
    const j: any = await res.json();
    const o = j.object ?? j.result ?? j.data ?? j;
    const model = o.model ?? o.modelName ?? o.device ?? "";
    if (!model) throw new Error("no model in response");
    const black = String(o.blacklist ?? o.gsmaBlacklisted ?? "").toLowerCase();
    const lockRaw = String(o.simlock ?? o.lockStatus ?? o.carrierLock ?? "").toLowerCase();
    return {
      imei,
      valid: luhnValid(imei),
      tac: imei.slice(0, 8),
      brand: o.brand ?? o.manufacturer ?? "",
      model,
      modelNumber: String(o.modelNumber ?? o.model_number ?? "").trim() || null,
      blacklist: black.includes("black") || black === "true" || black === "yes"
        ? "blacklisted"
        : black
          ? "clean"
          : "unknown",
      lock: lockRaw.includes("lock") || lockRaw === "locked"
        ? "locked"
        : lockRaw.includes("unlock")
          ? "unlocked"
          : "unknown",
      fmip: (() => {
        const f = String(o.fmip ?? o.icloud ?? o.findMy ?? o.iCloudLock ?? "").toLowerCase();
        return /off|clean|unlock|disabled/.test(f) ? "off" : /on|lock|enabled/.test(f) ? "on" : "unknown";
      })(),
      reportedGrade: o.grade ?? o.condition ?? undefined,
      source: "provider",
    };
  } catch {
    return tacLookup(imei) ?? stubLookup(imei);
  }
}
