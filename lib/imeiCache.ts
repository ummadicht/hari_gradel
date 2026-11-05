import { db } from "./db";
import { getPhonecheck, stationCheck, type PhonecheckReport } from "./phonecheck";
import { freeLookup, imeiInfoFromReport, lookupImei, type ImeiInfo } from "./imei";
import { isLiveImeiSource } from "./imeiSource";
import { releasePaidLookup, reservePaidLookup, type LookupGrant, type SkipReason } from "./lookupBudget";

/**
 * ONE PAID LOOKUP PER IMEI PER DAY.
 *
 * An IMEI is resolved again and again — SwapUp resolves it when the advisor
 * scans, a session is created for it, a page is reloaded, a case is reissued —
 * and every resolve used to spend fresh Phonecheck calls. This keeps the answer
 * (identity + the one Phonecheck report behind it) per IMEI for 24 hours: long
 * enough to cover a trade-in from scan to hand-over, short enough that a phone
 * reported lost or stolen today reads as blacklisted tomorrow.
 *
 * A hit makes no Phonecheck call at all.
 *
 * A MISS is a paid lookup, and who may spend one is decided by the caller's
 * grant (lib/lookupBudget.ts): server key and staff always, a known channel up
 * to its per-IP daily limit, anyone else never. A refused miss answers from the
 * free TAC data, marked `skipped`.
 */
export const IMEI_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export type ImeiResolution = {
  info: ImeiInfo;
  /** The single Phonecheck answer `info` was derived from (null for a partial IMEI). */
  phonecheck: PhonecheckReport | null;
  /** When the lookup was made — the stored time on a hit. */
  at: string;
  cached: boolean;
  /** Set when the paid lookup was held back for this caller (see lib/lookupBudget.ts). */
  skipped?: SkipReason;
};

type Row = { info: string; phonecheck: string; at: string };

/**
 * Keep only answers that cost something and mean something. A vendor outage
 * ("error") must be retried on the next ask, and with no credentials
 * ("unconfigured", "demo") nothing was paid for — caching those would only
 * hide a fix for a day.
 */
function worthKeeping(info: ImeiInfo, pc: PhonecheckReport | null): boolean {
  if (isLiveImeiSource(info.source)) return true;
  return !!pc && (pc.source === "api" || pc.source === "gsma" || pc.source === "not_found");
}

/**
 * The answer carries the time it was looked up, so a copy stored on a session
 * (create, /offer, a re-grade) still says when — the report shows it. Rows
 * written before this have no stamp; a hit fills it from the row's own time.
 */
function stamped(pc: PhonecheckReport | null, at: string): PhonecheckReport | null {
  if (pc && !pc.lookedUpAt) pc.lookedUpAt = at;
  return pc;
}

function parse<T>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

/** Did this answer cost a call? Nothing is paid with no credentials configured. */
function wasPaid(info: ImeiInfo, pc: PhonecheckReport | null): boolean {
  if (isLiveImeiSource(info.source)) return true;
  return !!pc && pc.source !== "unconfigured" && pc.source !== "demo";
}

/** An answer already held in the lookup table, with the time it was paid for. */
export type StoredLookup = {
  info: ImeiInfo | null;
  phonecheck: PhonecheckReport | null;
  /** ISO time of the paid lookup that produced it. */
  at: string;
};

/**
 * What GradeIQ already knows about an IMEI — read from the table, never asked
 * of anyone.
 *
 * For DISPLAY. SwapUp resolves an IMEI (its paid call A) before it creates the
 * session, and creates that session without an IMEI on purpose; /device fills
 * the IMEI in later without a lookup. So the session's own imei_info stays
 * empty while the answer it needs sits here. A report reads it from here: no
 * call, no reservation, no write.
 *
 * Any age is returned. The caller shows `at`, so an old answer reads as old —
 * the 24 h TTL decides when to PAY again (resolveImei), not what is true.
 */
export function storedLookup(rawImei: string): StoredLookup | null {
  const imei = String(rawImei ?? "").replace(/\D/g, "").slice(0, 15);
  if (imei.length !== 15) return null;
  const hit = db.prepare("SELECT info, phonecheck, at FROM imei_lookups WHERE imei = ?").get(imei) as Row | undefined;
  if (!hit) return null;
  return { info: parse<ImeiInfo>(hit.info), phonecheck: parse<PhonecheckReport>(hit.phonecheck), at: hit.at };
}

/**
 * IMEI → identity + Phonecheck answer, from the cache when it is fresh.
 *
 * `grant` says who is asking (lookupGrant). Without one the caller is internal
 * code that has already decided — the lookup is made and counted as "internal".
 */
export async function resolveImei(rawImei: string, now: number = Date.now(), grant?: LookupGrant): Promise<ImeiResolution> {
  const imei = String(rawImei ?? "").replace(/\D/g, "").slice(0, 15);
  // A partial IMEI can't be looked up anywhere paid — the free TAC answer only.
  if (imei.length !== 15) {
    return { info: await lookupImei(imei), phonecheck: null, at: new Date(now).toISOString(), cached: false };
  }

  const hit = db.prepare("SELECT info, phonecheck, at FROM imei_lookups WHERE imei = ?").get(imei) as Row | undefined;
  if (hit) {
    const age = now - Date.parse(hit.at);
    const info = parse<ImeiInfo>(hit.info);
    if (info && age >= 0 && age < IMEI_CACHE_TTL_MS) {
      return { info, phonecheck: stamped(parse<PhonecheckReport>(hit.phonecheck), hit.at), at: hit.at, cached: true };
    }
  }

  const at = new Date(now).toISOString();
  const who: LookupGrant = grant ?? { caller: "internal", ip: "" };
  // Reserve before calling, so a burst from one IP cannot overrun its limit.
  const slot = reservePaidLookup(who, now);
  if (!slot.ok) {
    return { info: { ...freeLookup(imei), skipped: slot.reason }, phonecheck: null, at, cached: false, skipped: slot.reason };
  }

  // The ONE Phonecheck answer (station record, else the GSMA registry) — the
  // identity is derived from it rather than asked for a second time.
  const phonecheck = stamped(await getPhonecheck(imei).catch(() => null), at);
  const info = await lookupImei(imei, { phonecheck });
  // No credentials configured: nothing was spent, so the reservation goes back.
  if (!wasPaid(info, phonecheck)) releasePaidLookup(who, now);
  if (worthKeeping(info, phonecheck)) {
    db.prepare(
      `INSERT INTO imei_lookups (imei, info, phonecheck, at) VALUES (?, ?, ?, ?)
       ON CONFLICT(imei) DO UPDATE SET info = excluded.info, phonecheck = excluded.phonecheck, at = excluded.at`
    ).run(imei, JSON.stringify(info), JSON.stringify(phonecheck), at);
  }
  return { info, phonecheck, at, cached: false };
}

/** A Phonecheck answer that is a station record — the phone was physically tested. */
export function isStationReport(pc: Partial<PhonecheckReport> | null | undefined): boolean {
  return !!pc && pc.source === "api" && pc.found !== false;
}

/**
 * A STAFF RE-GRADE'S ONE LOOKUP — the cache, plus a station re-check.
 *
 * SwapUp pays for its call A when the advisor saves the IMEI on the case,
 * BEFORE the phone goes on a Phonecheck station. The answer cached for 24 h is
 * then the GSMA registry's, with no station record in it, and a re-grade
 * answered purely from that cache could never see the station test that
 * followed — the report kept saying no station had tested the phone.
 *
 * So when the cached answer holds no station record, the re-grade asks the
 * station database ONCE (GetDeviceInfo only, lib/phonecheck.ts stationCheck),
 * counted under the caller's grant like any paid lookup. The registry part of
 * the cached answer is still good and is NOT paid for again: a station record
 * that carries no lost/stolen status takes the registry's from the cache.
 *
 * At most one paid call per re-grade either way:
 *   • cache miss          → resolveImei's one lookup (station DB, then registry);
 *   • cached station record → none;
 *   • cached anything else  → one GetDeviceInfo.
 */
export async function resolveImeiForRegrade(
  rawImei: string,
  now: number = Date.now(),
  grant?: LookupGrant,
): Promise<ImeiResolution & { station?: "found" | "none" | "failed" | "skipped" }> {
  const r = await resolveImei(rawImei, now, grant);
  const imei = String(rawImei ?? "").replace(/\D/g, "").slice(0, 15);
  if (!r.cached || imei.length !== 15 || isStationReport(r.phonecheck)) return r;

  const who: LookupGrant = grant ?? { caller: "internal", ip: "" };
  const slot = reservePaidLookup(who, now);
  if (!slot.ok) return { ...r, station: "skipped" };
  const st = await stationCheck(imei).catch(() => ({ kind: "failed" as const }));
  if (st.kind === "unconfigured") {
    releasePaidLookup(who, now);
    return { ...r, station: "skipped" };
  }
  const at = new Date(now).toISOString();

  if (st.kind !== "record") {
    if (st.kind === "none" && r.phonecheck) {
      // Say when the station database was last asked — without moving the
      // row's own time, which is what decides when the registry is paid again.
      r.phonecheck.stationCheckedAt = at;
      db.prepare("UPDATE imei_lookups SET phonecheck = ? WHERE imei = ?").run(JSON.stringify(r.phonecheck), imei);
    }
    return { ...r, station: st.kind };
  }

  const rec = st.report;
  const reg = r.phonecheck;
  if (rec.blacklist === "unknown" && reg && reg.source === "gsma" && reg.found && reg.blacklist !== "unknown") {
    rec.blacklist = reg.blacklist;
    rec.extra = { ...(rec.extra ?? {}), blacklistSource: "gsma" };
  }
  rec.lookedUpAt = at;
  // Identity from the station record when it names the device; else keep the
  // registry's (a station row without a model is not worth a second registry call).
  const info = imeiInfoFromReport(imei, rec) ?? r.info;
  db.prepare(
    `INSERT INTO imei_lookups (imei, info, phonecheck, at) VALUES (?, ?, ?, ?)
     ON CONFLICT(imei) DO UPDATE SET info = excluded.info, phonecheck = excluded.phonecheck, at = excluded.at`
  ).run(imei, JSON.stringify(info), JSON.stringify(rec), at);
  return { info, phonecheck: rec, at, cached: false, station: "found" };
}

/** How much a stored Phonecheck answer says: station record > registry > "nobody knows it" > nothing. */
export function pcRank(pc: Partial<PhonecheckReport> | null | undefined): number {
  if (!pc) return 0;
  if (pc.source === "api" && pc.found !== false) return 3;
  if (pc.source === "gsma" && pc.found !== false) return 2;
  if (pc.source === "not_found") return 1;
  return 0; // error, unconfigured, demo, an empty column
}

/** How much a stored identity answer says: station / ESN check > registry / provider > TAC or nothing. */
export function infoRank(info: Partial<ImeiInfo> | null | undefined): number {
  const src = String(info?.source ?? "");
  if (src === "station" || src === "esn" || src === "api") return 3; // "api": rows from before the source split
  if (src === "gsma" || src === "provider") return 2;
  return 0;
}

/**
 * What a re-grade may write back to the session, given what it already holds.
 *
 * NEVER DOWNGRADE. A station record carries battery, cycles, Find My, carrier
 * lock and erase status; the registry carries none of them. A re-grade that
 * got a registry answer — from the cache (call A predates the station test),
 * or because GetDeviceInfo failed and CheckEsn answered — used to overwrite the
 * stored station record with it, and the report then said the phone had no
 * station record. An answer is written only when it ranks the same or higher.
 *
 * The one exception is lost/stolen: a fresher answer saying BLACKLISTED is
 * carried onto the kept record (credited to its source), because that fact
 * blocks a payout and must not be lost to a ranking. A fresher "clean" never
 * clears a stored "blacklisted".
 */
export function regradeWrites(
  stored: { imeiInfo: Partial<ImeiInfo> | null | undefined; phonecheck: Partial<PhonecheckReport> | null | undefined },
  fresh: { info: ImeiInfo; phonecheck: PhonecheckReport | null },
): { imeiInfo?: ImeiInfo; phonecheck?: PhonecheckReport } {
  const out: { imeiInfo?: ImeiInfo; phonecheck?: PhonecheckReport } = {};
  if (infoRank(fresh.info) >= infoRank(stored.imeiInfo)) out.imeiInfo = fresh.info;
  const pc = fresh.phonecheck;
  if (pc) {
    if (pcRank(pc) >= pcRank(stored.phonecheck)) {
      out.phonecheck = pc;
    } else if (pc.blacklist === "blacklisted" && stored.phonecheck && stored.phonecheck.blacklist !== "blacklisted") {
      out.phonecheck = {
        ...(stored.phonecheck as PhonecheckReport),
        blacklist: "blacklisted",
        extra: { ...(stored.phonecheck.extra ?? {}), blacklistSource: pc.source === "gsma" ? "gsma" : String(pc.source) },
      };
    }
  }
  return out;
}
