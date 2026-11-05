// Trusted diagnostics via the real Phonecheck Cloud API — same endpoint, auth
// and field mapping GradeIQ's sibling ERP (refurbIQ / denovo-refurb) uses:
//   POST {base}/cloud/cloudDB/GetDeviceInfo, x-www-form-urlencoded
//   with apiKey + username (+ imei). Returns make/model, battery health,
//   blacklist (ESN), carrier lock, iCloud/FMiP, erasure, failed components.
// Falls back to a deterministic stub when creds aren't configured.

export type PhonecheckReport = {
  imei: string;
  found: boolean;
  make?: string;
  model?: string;
  /** Finish/colour as the vendor records it, e.g. "Phantom Black". */
  colour?: string;
  /** Capacity as recorded, e.g. "256GB". */
  capacity?: string;
  /** Manufacturer part number, e.g. "SM-S918U1" / "A2650". */
  modelNumber?: string;
  carrier?: string;
  /** Serial / UDID — a second identity anchor independent of the IMEI. */
  serial?: string;
  /** Phonecheck's own grade and cosmetic note, where the station recorded one. */
  vendorGrade?: string;
  cosmetics?: string;
  /** Battery detail beyond the headline percentage. */
  batteryCycles?: number;
  /** Root/jailbreak status as the station found it. */
  rooted?: string;
  batteryHealth: number; // %
  /**
   * Fields the parser did not recognise, kept verbatim.
   *
   * The parser normalises a vendor payload into this fixed shape and DROPS
   * everything else — which is why nobody could tell what Phonecheck actually
   * returns without making a fresh call. Keeping the remainder means the next
   * field we want (colour, capacity, part number, grade) is already on the
   * session instead of needing another API round trip, and a payload whose
   * key names change is diagnosable from stored data rather than guesswork.
   */
  extra?: Record<string, string>;
  fmip: "off" | "on" | "unknown"; // iCloud / activation lock
  /**
   * MDM (device-management) enrolment, as a station reports it. A SEPARATE fact
   * from Find My: a station record carries both, and reading Find My off the
   * MDM field showed "Find My: Off" on activation-locked phones.
   */
  mdm?: "on" | "off" | "unknown";
  /**
   * When the station tested the phone, ISO UTC — only from a time stamp that
   * carries its own zone (`UpdatedTimeStamp`). A zone-less date is not read.
   */
  testedAt?: string;
  /** When GradeIQ looked this answer up (ISO), stamped by lib/imeiCache.ts. */
  lookedUpAt?: string;
  /**
   * When a staff re-grade last asked the station database for this IMEI and it
   * had no record (ISO) — see resolveImeiForRegrade in lib/imeiCache.ts.
   */
  stationCheckedAt?: string;
  erased: boolean; // data cleared
  /** Whether the provider actually returned an erasure/wipe field. */
  erasedKnown?: boolean;
  blacklist: "clean" | "blacklisted" | "unknown";
  simLock: "unlocked" | "locked" | "unknown";
  failedComponents: string[];
  reportUrl?: string;
  /**
   * WHERE the answer came from — and when there isn't one, why.
   *
   * "stub" used to cover four different situations at once, which is how
   * fabricated values ended up indistinguishable from lookups. Each now says
   * what actually happened, so a blank field can be explained instead of
   * guessed at.
   */
  source: "api" | "gsma" | "not_found" | "unconfigured" | "error" | "demo";
};

const norm = (s: any) => String(s ?? "").trim();
const digits = (s: any) => norm(s).replace(/\D/g, "");
function pick(o: any, ...keys: string[]): any {
  if (!o) return undefined;
  const lower: Record<string, any> = {};
  for (const k of Object.keys(o)) lower[k.toLowerCase()] = o[k];
  for (const k of keys) if (lower[k.toLowerCase()] != null) return lower[k.toLowerCase()];
  return undefined;
}
const toList = (v: any): string[] =>
  Array.isArray(v)
    ? v.map(norm).filter(Boolean)
    : norm(v).split(/[,;|\n]/).map((s) => s.trim()).filter(Boolean);

function unwrap(data: any): any[] {
  if (Array.isArray(data)) return data;
  return data?.devices ?? data?.data ?? data?.result ?? data?.master ?? (data ? [data] : []);
}

/**
 * Shape of the most recent GetDeviceInfo response — a diagnostic, not state.
 * Read by the settings/integrations view so "what does Phonecheck actually
 * send?" is answerable from the app instead of by adding a console.log and
 * redeploying.
 */
export let lastProbe: { rows: number; keys: string[] } | null = null;

/** One Cloud DB call: the HTTP status and the parsed JSON. Throws on a network error or a non-JSON body. */
async function pcPostStatus(
  base: string,
  apiKey: string,
  username: string,
  path: string,
  fields: Record<string, string>
): Promise<{ status: number; body: any }> {
  const body = new URLSearchParams({ apiKey, username, ...fields });
  const res = await fetch(`${base.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    throw new Error(`Phonecheck ${path}: non-JSON (HTTP ${res.status})`);
  }
}

async function pcPost(
  base: string,
  apiKey: string,
  username: string,
  path: string,
  fields: Record<string, string>
): Promise<any> {
  return (await pcPostStatus(base, apiKey, username, path, fields)).body;
}

/** Keys the parser already understands — everything else is worth keeping. */
const KNOWN = new Set(
  [
    "imei", "imei1", "deviceimei", "make", "manufacturer", "brand", "model", "modelname",
    "devicename", "device", "color", "colour", "devicecolor", "devicecolour", "housingcolor",
    "capacity", "memory", "storage", "size", "devicecapacity", "hdd", "modelnumber",
    "model_no", "modelno", "partnumber", "sku", "skucode", "serial", "serialnumber", "udid",
    "grade", "devicegrade", "cosmetics", "cosmetic", "cosmeticgrade", "batterycycle",
    "batterycycles", "cyclecount", "rooted", "jailbroken", "rootstatus", "carrier", "network", "operator",
    "originalcarrier", "esnresponse", "blackliststatus", "esnstatus", "blacklist",
    "gsmastatus", "devicestate", "mdm", "icloudstatus", "fmip", "findmyiphone", "findmy",
    "activationlock", "devicelock", "appleid", "icloud", "updatedtimestamp", "unlockstatus",
    "carrierlockresponse", "simlockresponse", "simlock", "carrierlock", "lockstatus",
    "erasure", "erased", "dataerased", "wipestatus",
    "batteryhealthpercentage", "batteryhealth", "batterypercentage", "a4reportlink",
    "reportlink", "reporturl", "erasurereportlink", "failed", "failedtests", "failures",
    "defects",
  ].map((k) => k.toLowerCase()),
);

/**
 * Everything the vendor sent that we do not already map, flattened to strings.
 * Bounded so a chatty payload cannot bloat every session row.
 */
function keepUnrecognised(o: any): Record<string, string> | undefined {
  if (!o || typeof o !== "object") return undefined;
  const out: Record<string, string> = {};
  let n = 0;
  for (const k of Object.keys(o)) {
    if (KNOWN.has(k.toLowerCase())) continue;
    const v = o[k];
    if (v == null || v === "" || typeof v === "object") continue;
    out[k.slice(0, 40)] = String(v).slice(0, 120);
    if (++n >= 40) break;
  }
  return n ? out : undefined;
}

/**
 * A status word that is NOT an answer: the vendor saying it could not tell.
 * Checked before anything else, so "No Response" can never read as the "No" of
 * "not blacklisted", nor "Not Available" as anything at all.
 */
const NO_ANSWER =
  /\b(no ?response|no ?data|no ?record|not ?found|not ?available|unavailable|n\/?a|unknown|pending|error|timeout|timed ?out|not ?checked|none|null|undefined)\b/;

/** Lower-cased, whitespace/underscore/hyphen runs collapsed to one space. */
const word = (v: unknown) => norm(v).toLowerCase().replace(/[\s_\-]+/g, " ").trim();

/**
 * A lost/stolen status word → clean | blacklisted | unknown.
 *
 * CLEAN ONLY ON AN EXPLICIT TOKEN. The old test — /clean|pass|good|no\b/ — read
 * "No Response" and "No Data" as clean, and a station record that is not
 * "unknown" also switches off the GSMA backfill in getPhonecheck: a phone nobody
 * cleared reached the report as Clean, which is the payout decision. Anything
 * not recognised is unknown; "unknown" is never shown as clean.
 */
export function readBlacklist(raw: unknown): "clean" | "blacklisted" | "unknown" {
  const s = word(raw);
  if (!s || NO_ANSWER.test(s)) return "unknown";
  // "ESN: Clean", "GSMA status - clean" → "clean".
  const bare = s.replace(/^(esn|gsma|imei|blacklist|status|result)\b( (status|result|check)\b)?\s*:?\s*/, "").trim();
  if (/^(clean|clear|no|pass|passed|good|not blacklisted|not black listed|not lost or stolen|not reported( lost or stolen)?)$/.test(bare))
    return "clean";
  if (/^(yes|true|bad|fail|failed|barred|blocked)$/.test(bare) || /\b(black ?listed|blacklist|lost|stolen|barred|bad esn)\b/.test(bare))
    return "blacklisted";
  return "unknown";
}

/** "On"/"Off"-style status word → on | off | unknown (SwapUp's onOff, plus "locked"/"unlocked"). */
function readOnOff(raw: unknown): "on" | "off" | "unknown" {
  const s = word(raw);
  if (!s || NO_ANSWER.test(s)) return "unknown";
  if (/^(on|yes|true|1|enabled|locked|fmi ?on|fmip ?on|activation ?locked|icloud ?locked)$/.test(s)) return "on";
  if (/^(off|no|false|0|disabled|unlocked|clean|clear|fmi ?off|fmip ?off|not locked)$/.test(s)) return "off";
  return "unknown";
}

/**
 * Find My / activation lock, from the fields that ARE it — never MDM.
 *
 * Phonecheck's activation lock is `DeviceLock` (SwapUp's reading of 3,227 real
 * DeNovo records: "The activation lock is DeviceLock, not MDM"). MDM enrolment
 * is a different fact, and reading it first put a green "Find My: Off" on a
 * phone with MDM Off and DeviceLock On. When several Find My fields are present
 * and disagree, ON wins: a false "on" holds a payout, a false "off" pays out on
 * an iCloud-locked phone.
 */
export function readFindMy(o: any): "on" | "off" | "unknown" {
  const vals = ["fmip", "findmyiphone", "findmy", "fmi", "icloudstatus", "icloud", "activationlock", "devicelock"]
    .map((k) => pick(o, k))
    .filter((v) => v != null)
    .map(readOnOff);
  return vals.includes("on") ? "on" : vals.includes("off") ? "off" : "unknown";
}

/**
 * Carrier / SIM lock status word → unlocked | locked | unknown. A bare "No" is
 * NOT read: on a field called UnlockStatus it means locked, on one called
 * CarrierLock it means unlocked.
 */
function readCarrierLock(raw: unknown): "unlocked" | "locked" | "unknown" {
  const s = word(raw);
  if (!s || NO_ANSWER.test(s)) return "unknown";
  if (/\bunlock(ed)?\b|\bnot locked\b/.test(s)) return "unlocked";
  if (/\block(ed)?\b|^yes$|^true$/.test(s)) return "locked";
  return "unknown";
}

/**
 * The station's own test time, ISO UTC — ONLY from `UpdatedTimeStamp` with a
 * zone ("2026-03-12T17:51:00.00+04:00" in every record SwapUp has seen). The
 * zone-less `DeviceUpdatedDate` is not read: guessing its zone shifted real
 * test times by hours in DeNovo's data.
 */
function readTestedAt(raw: unknown): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})$/i.exec(norm(raw));
  if (!m) return undefined;
  let off = 0;
  if (!/^z$/i.test(m[7])) {
    const z = /^([+-])(\d{2}):?(\d{2})$/.exec(m[7])!;
    off = (z[1] === "-" ? -1 : 1) * (Number(z[2]) * 60 + Number(z[3]));
  }
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0)) - off * 60_000;
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
}

// Map a raw Phonecheck record → our report (aliases copied from refurbIQ).
export function parsePcReport(o: any, imei: string): PhonecheckReport {
  const bl = pick(o, "esnresponse", "blackliststatus", "esnstatus", "blacklist", "gsmastatus", "devicestate");
  const lock = pick(o, "unlockstatus", "carrierlockresponse", "simlockresponse", "simlock", "carrierlock", "lockstatus");
  const erasedRaw = pick(o, "erasure", "erased", "dataerased", "wipestatus");
  const yes = (v: any) => /^(1|true|yes|y|on|erased|complete|completed|clean|pass|passed)$/i.test(norm(v));
  const no = (v: any) => /^(0|false|no|n|off|not erased|incomplete|fail|failed)$/i.test(norm(v));
  const battM = norm(pick(o, "batteryhealthpercentage", "batteryhealth", "batterypercentage")).match(/(\d+)/);
  const reportUrl = norm(pick(o, "a4reportlink", "reportlink", "reporturl", "erasurereportlink")) || undefined;

  return {
    imei,
    found: true,
    make: norm(pick(o, "make", "manufacturer", "brand")) || undefined,
    model: norm(pick(o, "model", "modelname", "devicename")) || undefined,
    // A TAC lookup gives make and model but never finish or capacity. Phonecheck
    // reads them off the device itself, which makes it the only authoritative
    // source for the colour/storage cross-checks — better than the seller's
    // typed answer, because it is not the party being paid.
    colour: norm(pick(o, "color", "colour", "devicecolor", "devicecolour", "housingcolor")) || undefined,
    capacity:
      norm(pick(o, "capacity", "memory", "storage", "size", "devicecapacity", "hdd")) || undefined,
    modelNumber: norm(pick(o, "modelnumber", "model_no", "modelno", "partnumber", "sku", "skucode")) || undefined,
    // A live GetDeviceInfo response carries 60 fields; these were being dropped.
    // Serial is a second identity anchor, and a station's own grade/cosmetic
    // note is a human's verdict on the same device — both worth more than most
    // of what we were already keeping.
    serial: norm(pick(o, "serial", "serialnumber", "udid")) || undefined,
    vendorGrade: norm(pick(o, "grade", "devicegrade")) || undefined,
    cosmetics: norm(pick(o, "cosmetics", "cosmetic", "cosmeticgrade")) || undefined,
    batteryCycles: (() => {
      const m = norm(pick(o, "batterycycle", "batterycycles", "cyclecount")).match(/(\d+)/);
      return m ? +m[1] : undefined;
    })(),
    rooted: norm(pick(o, "rooted", "jailbroken", "rootstatus")) || undefined,
    carrier: norm(pick(o, "carrier", "network", "operator", "originalcarrier")) || undefined,
    extra: keepUnrecognised(o),
    batteryHealth: battM ? +battM[1] : 0,
    // Find My from DeviceLock / iCloud / FMiP fields only; MDM is its own fact.
    fmip: readFindMy(o),
    mdm: pick(o, "mdm") != null ? readOnOff(pick(o, "mdm")) : undefined,
    testedAt: readTestedAt(pick(o, "updatedtimestamp")),
    // "NA" is not an erase result: known only when it reads as yes or no.
    erased: erasedRaw !== undefined ? yes(erasedRaw) : false,
    erasedKnown: erasedRaw !== undefined && (yes(erasedRaw) || no(erasedRaw)),
    blacklist: readBlacklist(bl),
    simLock: readCarrierLock(lock),
    failedComponents: toList(pick(o, "failed", "failedtests", "failures", "defects")),
    reportUrl: /^https?:\/\//i.test(String(reportUrl)) ? reportUrl : undefined,
    source: "api",
  };
}

/**
 * NO ANSWER IS AN ANSWER. It is not a set of plausible-looking values.
 *
 * This function used to fabricate an entire report from the last three digits
 * of the IMEI: `blacklist: n % 9 === 0 ? "blacklisted" : "clean"`,
 * `simLock: n % 6 === 0 ? "locked" : "unlocked"`, battery always 78–99%, even
 * invented failed components. On production that path produced 58 of 64
 * records, so "Blacklist: clean · SIM: unlocked · Battery 86%" was arithmetic
 * on an IMEI, and nothing in the UI distinguished it from a real lookup.
 *
 * In a product whose entire proposition is evidence, a confident fabrication is
 * strictly worse than a blank: a blank prompts someone to check.
 *
 * Phonecheck's cloud only knows IMEIs that have been through a Phonecheck
 * station, so `not_found` is the ORDINARY answer for a consumer trade-in — and
 * it means unknown, not clean.
 */
function noAnswer(imei: string, source: PhonecheckReport["source"]): PhonecheckReport {
  return {
    imei,
    found: false,
    batteryHealth: 0, // 0 already means "no reading" everywhere downstream
    fmip: "unknown",
    erased: false,
    erasedKnown: false,
    blacklist: "unknown",
    simLock: "unknown",
    failedComponents: [],
    source,
  };
}

/**
 * The old fabricated report, kept ONLY behind an explicit flag.
 *
 * Populated demo data is a real need — an empty console demos badly. It is not
 * a default, and it is labelled `demo` in `source` so it can never be mistaken
 * for a lookup.
 */
function demoReport(imei: string): PhonecheckReport {
  const n = Number(imei.slice(-3)) || 0;
  const faultPool = ["Face ID", "Rear camera", "Wi-Fi", "Proximity sensor"];
  return {
    imei,
    found: false,
    batteryHealth: 78 + (n % 22),
    fmip: n % 5 === 0 ? "on" : "off",
    erased: n % 4 !== 0,
    erasedKnown: true,
    blacklist: n % 9 === 0 ? "blacklisted" : "clean",
    simLock: n % 6 === 0 ? "locked" : "unlocked",
    failedComponents: n % 3 === 0 ? [faultPool[n % faultPool.length]] : [],
    source: "demo",
  };
}

/**
 * GSMA lookup for ANY IMEI — `/cloud/cloudDB/CheckEsn/`, the SAME Cloud DB
 * credentials we already have.
 *
 * THIS IS THE ANSWER TO "58 OF 64 LOOKUPS RETURN NOTHING". `GetDeviceInfo`
 * searches the station database — devices this account physically tested —
 * so a consumer trade-in is legitimately absent from it. `CheckEsn` goes out
 * to the GSMA device registry instead and resolves make, marketing name, model
 * number, OS and lost/stolen status for an IMEI nobody has ever seen before.
 *
 * It needed no new credential. It was never called.
 *
 * TWO THINGS MAKE IT LOOK BROKEN when they are wrong, and both cost real time:
 *   • The body MUST be form-encoded. A JSON body — the obvious thing to send to
 *     a JSON API — returns 401 "Post Data is missing", which reads as an auth
 *     failure and sends you off rotating perfectly good keys.
 *   • `carrier` is REQUIRED. Omit it and you get the same 401/"Post Data is
 *     missing", again indistinguishable from bad credentials.
 * Parameter names are case-insensitive, so `pcPost`'s existing casing is fine.
 *
 * `carrier` selects which downstream service answers. "Blacklist" is the GSMA
 * registry (API code G001) and is the only one that works for an arbitrary
 * IMEI; the carrier-named values route to per-carrier services (S001…) that
 * reject devices which aren't theirs. So this always asks for Blacklist.
 *
 * WHAT IT DOES NOT RETURN: SIM/carrier lock, iCloud/FMiP, battery, colour or
 * capacity. Those stay "unknown" here — see `esnCheck` for the endpoint that
 * carries them, and the note there about what it costs to switch on.
 */
export async function gsmaCheck(imei: string): Promise<PhonecheckReport | null> {
  const r = await gsmaAsk(imei);
  return r.kind === "answer" ? r.report : null;
}

/**
 * What asking the registry produced: an answer, a real "no record", or a
 * failure to ask at all.
 *
 * gsmaCheck folds the last two into null, and getPhonecheck used to turn that
 * null into "not_found" — which the lookup cache keeps for 24 h, and the report
 * printed as "No GSMA registry record for this IMEI". An HTTP 500, a 401 from
 * bad credentials or a timeout is not the registry saying anything, so those
 * are told apart here and never cached as an answer.
 */
export type GsmaAsk =
  | { kind: "answer"; report: PhonecheckReport }
  | { kind: "no-record" }
  | { kind: "failed" };

/** A CheckEsn envelope that IS the registry saying it has nothing for this IMEI. */
const GSMA_NO_RECORD = /no ?data|not ?found|no ?record|invalid/i;

export async function gsmaAsk(imei: string): Promise<GsmaAsk> {
  const { getSetting } = await import("./settings");
  const clean = digits(imei).slice(0, 15);
  const key = getSetting("phonecheck_key", "PHONECHECK_API_KEY");
  const username = getSetting("phonecheck_username", "PHONECHECK_USERNAME");
  const base =
    getSetting("phonecheck_url", "PHONECHECK_API_URL") || "https://clientapiv2.phonecheck.com";
  if (!key || !username || clean.length !== 15) return { kind: "failed" };

  let res: { status: number; body: any };
  try {
    res = await pcPostStatus(base, key, username, "/cloud/cloudDB/CheckEsn/", {
      imei: clean,
      // Apple vs Android only changes which carrier services are offered; the
      // GSMA registry answers the same either way, and we do not yet know the
      // make — that is what we are asking.
      devicetype: "Android",
      carrier: "Blacklist",
    });
  } catch {
    return { kind: "failed" }; // network error, timeout, an HTML error page
  }
  if (res.status < 200 || res.status >= 300) return { kind: "failed" }; // 401 "Post Data is missing", 5xx

  const report = parseGsmaResponse(res.body, clean);
  if (report) return { kind: "answer", report };

  // No device in it. Only a recognisable "nothing for this IMEI" counts as the
  // registry's answer; any other envelope is a failure to ask.
  const row = Array.isArray(res.body) ? res.body[0] : res.body;
  const raw = row?.RawResponse;
  if (raw && typeof raw === "object") return { kind: "no-record" }; // a registry row with no name in it
  const said = typeof raw === "string" ? raw : String(row?.msg ?? row?.message ?? "");
  return GSMA_NO_RECORD.test(said) ? { kind: "no-record" } : { kind: "failed" };
}

/**
 * Pure parse of a CheckEsn response — split out so the field mapping can be
 * tested without calling the vendor, which is the part most likely to rot when
 * they change a key name.
 */
export function parseGsmaResponse(j: any, imei: string): PhonecheckReport | null {
  // Carrier services answer as an array; GSMA answers as an object. A string
  // RawResponse ("IMEI or SN is Invalid") is a refusal, not a device.
  const row = Array.isArray(j) ? j[0] : j;
  const r = row?.RawResponse;
  if (!r || typeof r !== "object") return null;

  const marketing = norm(pick(r, "marketingname"));
  const modelName = norm(pick(r, "modelname"));
  const brand = norm(pick(r, "brandname", "manufacturer"));
  if (!marketing && !modelName) return null;

  // "No"/"Yes" ONLY. Anything else — null, empty, an unexpected word — stays
  // unknown: a device the registry declines to answer for must never read as
  // clean, which is the whole reason the fabricating stub was removed.
  const bl = norm(pick(r, "blackliststatus")).toLowerCase();
  const blacklist: PhonecheckReport["blacklist"] =
    bl === "no" ? "clean" : bl === "yes" ? "blacklisted" : "unknown";

  // Samsung answers marketingname "Galaxy Z Flip5" + modelname "SM-F731W", so
  // the two fields carry different things. Apple repeats the same string in
  // both — keep modelNumber only when it is genuinely a part number.
  const isPartNumber = /^[A-Z]{1,3}[-_]?[A-Z0-9]{3,}$/i.test(modelName) && modelName !== marketing;

  return {
    imei,
    found: true,
    // The registry writes "NA" where it has no brand; that is an absence, not a
    // manufacturer called NA.
    make: brand && brand.toUpperCase() !== "NA" ? brand : undefined,
    model: marketing || modelName,
    modelNumber: isPartNumber ? modelName : undefined,
    batteryHealth: 0, // GSMA holds no battery reading — 0 means "no reading"
    fmip: "unknown",
    erased: false,
    erasedKnown: false,
    blacklist,
    simLock: "unknown", // not carried by the GSMA registry
    failedComponents: [],
    extra: keepUnrecognised(r),
    source: "gsma",
  };
}

// Pure-IMEI ESN check — api.phonecheck.com v2 "most-accurate" endpoint. Unlike
// the Cloud DB (which only returns devices YOU physically tested), this resolves
// make/model + blacklist/ESN for ANY IMEI, AND adds the two things `gsmaCheck`
// cannot see: SIM/carrier lock and iCloud/activation lock.
//
// It authenticates differently from everything else in this file, which is why
// it has never once returned a result. See `v2Token()`.
export type EsnResult = {
  imei: string;
  found: boolean;
  make?: string;
  model?: string;
  blacklist: "clean" | "blacklisted" | "unknown";
  gsmaStatus?: string;
  /** iCloud / Find My / activation lock, when the response carries it. */
  fmip: "off" | "on" | "unknown";
  /** SIM / carrier lock, when present. */
  simLock: "unlocked" | "locked" | "unknown";
  raw?: any;
  source: "esn";
};

/**
 * A minted v2 credential, held in memory until it expires.
 *
 * WHY THIS EXISTS. `api.phonecheck.com` does not accept the Cloud DB API key
 * at all — confirmed against the live service, which answers every variant
 * with 401 "Missing authentication token". Its tokens are SHORT-LIVED: you
 * exchange a long-lived secret for a JWT that dies after 24 hours. So there
 * was never a value that could sit in `PHONECHECK_V2_TOKEN` and keep working;
 * anything pasted there stops resolving by the next day, silently, because
 * `esnCheck` returns null on failure and the report just goes quiet.
 *
 * The header is also NOT `token` (what the old code sent) — it is
 * `token_master` or `token_user`, depending on which login minted it. Sending
 * the wrong one fails exactly like a bad token.
 */
let v2Cached: { header: string; token: string; expires: number } | null = null;

/**
 * Get a live v2 token, minting one if needed. Returns null when v2 is not
 * configured — which is the current production state, and is why SIM-lock and
 * iCloud status are blank while make/model/blacklist now populate via
 * `gsmaCheck`.
 *
 * Three ways in, best first:
 *   1. `phonecheck_v2_api_token` — a long-lived API token from the Cloud
 *      Portal, exchanged for a JWT. PREFERRED: it is revocable on its own and
 *      means we never store an account password.
 *   2. `phonecheck_v2_password` (+ username) — the account password. Works,
 *      but it is the login to the whole Phonecheck account.
 *   3. `phonecheck_v2_token` — a JWT pasted by hand. Useful for a one-off
 *      test; it WILL expire within 24h.
 */
async function v2Token(): Promise<{ header: string; token: string } | null> {
  const { getSetting } = await import("./settings");
  const base =
    getSetting("phonecheck_v2_url", "PHONECHECK_V2_URL") || "https://api.phonecheck.com";
  const root = base.replace(/\/$/, "");

  // Re-use until a minute before expiry, so a call can't start on a token that
  // dies mid-flight.
  if (v2Cached && v2Cached.expires > Date.now() + 60_000) return v2Cached;

  const post = async (path: string, body: Record<string, string>) => {
    const res = await fetch(`${root}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return (await res.json().catch(() => null)) as any;
  };

  const apiToken = getSetting("phonecheck_v2_api_token", "PHONECHECK_V2_API_TOKEN");
  if (apiToken) {
    const j = await post("/v2/auth/api-token/login", { apiToken });
    if (j?.token) {
      // The exchange reports its own header name and lifetime; trust those over
      // our assumptions, and fall back to a conservative 23h.
      const header = norm(j?.usage?.header) || "token_master";
      const ttl = Number(j?.expiresIn) > 0 ? Number(j.expiresIn) * 1000 : 23 * 3600_000;
      v2Cached = { header, token: j.token, expires: Date.now() + ttl };
      return v2Cached;
    }
  }

  const password = getSetting("phonecheck_v2_password", "PHONECHECK_V2_PASSWORD");
  const username =
    getSetting("phonecheck_v2_username", "PHONECHECK_V2_USERNAME") ||
    getSetting("phonecheck_username", "PHONECHECK_USERNAME");
  if (password && username) {
    // A master account and a station user log in at different paths and yield
    // differently-named headers. Try master, then user.
    for (const [path, header] of [
      ["/v2/auth/master/login", "token_master"],
      ["/v2/auth/user/login", "token_user"],
    ] as const) {
      const j = await post(path, { username, password });
      if (j?.token) {
        v2Cached = { header, token: j.token, expires: Date.now() + 23 * 3600_000 };
        return v2Cached;
      }
    }
  }

  const stat = getSetting("phonecheck_v2_token", "PHONECHECK_V2_TOKEN");
  if (stat) {
    const header =
      getSetting("phonecheck_v2_header", "PHONECHECK_V2_HEADER") || "token_master";
    // Hand-pasted: no expiry is known, so re-read the setting every 5 minutes
    // rather than caching a value the operator may have just replaced.
    return { header, token: stat };
  }

  return null;
}

export async function esnCheck(
  imei: string,
  opts?: { fromCache?: boolean }
): Promise<EsnResult | null> {
  const { getSetting } = await import("./settings");
  const clean = digits(imei).slice(0, 15);
  if (clean.length !== 15) return null;
  const auth = await v2Token();
  if (!auth) return null;
  const base =
    getSetting("phonecheck_v2_url", "PHONECHECK_V2_URL") || "https://api.phonecheck.com";
  // `fromCache=true` returns a prior lookup WITHOUT consuming another license.
  // An explicit opt wins; otherwise the PHONECHECK_V2_FROM_CACHE setting decides
  // (default off = a fresh, authoritative GSMA/ESN read — the right default for a
  // first identify; flip it on for cheap re-checks / re-grades).
  const fromCache =
    opts?.fromCache ??
    /^(1|true|yes|on)$/i.test(String(getSetting("phonecheck_v2_from_cache", "PHONECHECK_V2_FROM_CACHE") || ""));
  const qs = fromCache ? "?fromCache=true" : "";
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/v2/imei/most-accurate/${clean}${qs}`, {
      // The header name comes from whichever login minted the token —
      // `token_master` for a master account, `token_user` for a station user.
      headers: { [auth.header]: auth.token, Accept: "application/json" },
    });
    if (!res.ok) return null;
    const j: any = await res.json();
    const o = j?.data ?? j?.result ?? j ?? {};
    const bl = norm(pick(o, "gsmastatus", "blackliststatus", "esnresponse", "blacklist", "status")).toLowerCase();
    const model = norm(pick(o, "model", "modelname", "devicename", "device")) || undefined;
    // iCloud / Find My / activation lock + SIM lock, if the response carries them
    // (Apple IMEIs usually do). The same readers as a station record: Find My
    // never from MDM, and a "no response" is unknown — never clean or off.
    const fmip: EsnResult["fmip"] = readFindMy(o);
    const simLock: EsnResult["simLock"] = readCarrierLock(
      pick(o, "unlockstatus", "carrierlockresponse", "simlockresponse", "simlock", "carrierlock", "lockstatus"),
    );
    if (!model && !bl && fmip === "unknown")
      return { imei: clean, found: false, blacklist: "unknown", fmip, simLock, source: "esn" };
    return {
      imei: clean,
      found: true,
      make: norm(pick(o, "make", "brand", "manufacturer")) || undefined,
      model,
      gsmaStatus: bl || undefined,
      blacklist: readBlacklist(bl),
      fmip,
      simLock,
      raw: o,
      source: "esn",
    };
  } catch {
    return null;
  }
}

/**
 * The device row in a GetDeviceInfo answer, or null when there is none.
 *
 * Also keeps a bounded fingerprint of what GetDeviceInfo actually returned.
 * `/cloud/cloudDB/GetDeviceInfo` searches Phonecheck's CLOUD DB — devices that
 * have been through one of their stations — so a consumer trade-in legitimately
 * returns nothing. Distinguishing "the endpoint answered and the device isn't in
 * it" from "we called it wrong" or "the field names changed" was impossible,
 * because the response was parsed and discarded.
 *
 * Field NAMES only, never values: enough to see whether colour/capacity are on
 * offer and under what key, without copying vendor data into our logs.
 */
function stationRow(body: any, clean: string): any | null {
  const rows = unwrap(body);
  lastProbe = {
    rows: rows.length,
    keys: rows.length && rows[0] && typeof rows[0] === "object" ? Object.keys(rows[0]).slice(0, 60) : [],
  };
  const o = rows.find((r) => digits(pick(r, "imei", "imei1", "deviceimei")) === clean) ?? rows[0];
  // "No Data Found" comes back as {status:0, msg:...} — not a device record.
  const isDevice =
    o && (pick(o, "model", "modelname", "devicename") || digits(pick(o, "imei", "imei1", "deviceimei")));
  return isDevice ? o : null;
}

export async function getPhonecheck(imei: string): Promise<PhonecheckReport> {
  const { getSetting } = await import("./settings");
  const clean = digits(imei).slice(0, 15);
  const key = getSetting("phonecheck_key", "PHONECHECK_API_KEY");
  const username = getSetting("phonecheck_username", "PHONECHECK_USERNAME");
  const base = getSetting("phonecheck_url", "PHONECHECK_API_URL") || "https://clientapiv2.phonecheck.com";
  // Demo data is opt-in and never the fallback for a failed lookup.
  const demo = (getSetting("phonecheck_demo", "PHONECHECK_DEMO") || "").toLowerCase().trim() === "true";
  if (!key || !username || clean.length !== 15) {
    return demo ? demoReport(clean) : noAnswer(clean, "unconfigured");
  }

  let o: any;
  try {
    o = stationRow(
      await pcPost(base, key, username, "/cloud/cloudDB/GetDeviceInfo", {
        imei: clean,
        IMEI: clean,
      }),
      clean,
    );
  } catch {
    // A network or vendor failure is NOT "not found" — conflating them hides an
    // outage behind a routine-looking empty result.
    const g = await gsmaAsk(clean).catch((): GsmaAsk => ({ kind: "failed" }));
    if (g.kind === "answer") return g.report;
    return demo ? demoReport(clean) : noAnswer(clean, "error");
  }

  // The device is simply not in Phonecheck's database — the common case for a
  // consumer phone that has never been through one of their stations.
  if (!o) {
    // Not in the station database — the ORDINARY case for a consumer phone,
    // and until now the end of the road. Ask the GSMA registry instead, which
    // knows the device regardless of who has tested it. Thinner than a station
    // record (no battery, colour or capacity) but it carries the two facts
    // that actually gate a payout: what the device is, and whether it is
    // reported lost or stolen.
    const g = await gsmaAsk(clean).catch((): GsmaAsk => ({ kind: "failed" }));
    if (g.kind === "answer") return g.report;
    if (demo) return demoReport(clean);
    // "not_found" only when the registry really answered that it has nothing;
    // a registry that could not be asked is an "error" — never cached, retried.
    return noAnswer(clean, g.kind === "no-record" ? "not_found" : "error");
  }

  const rec = parsePcReport(o, clean);
  /**
   * A station record wins on richness — battery, colour, capacity, grade —
   * but it does NOT always carry lost/stolen status, because that is a GSMA
   * question and not something the station measured. Leaving it "unknown"
   * while a working registry would answer it is the one gap worth a second
   * call: blacklist is the fact that gates a payout, and "unknown" quietly
   * reads as "fine" to anyone glancing at a report.
   *
   * Only fires when the station record is actually missing it, so the common
   * path stays a single call.
   */
  if (rec.blacklist === "unknown") {
    const g = await gsmaCheck(clean).catch(() => null);
    if (g && g.blacklist !== "unknown") {
      rec.blacklist = g.blacklist;
      // Keep provenance visible: this field came from a different source than
      // the rest of the record.
      rec.extra = { ...(rec.extra ?? {}), blacklistSource: "gsma" };
    }
  }
  return rec;
}

/** What asking ONLY the station database produced. */
export type StationCheck =
  | { kind: "record"; report: PhonecheckReport }
  | { kind: "none" }
  | { kind: "failed" }
  | { kind: "unconfigured" };

/**
 * ONE GetDeviceInfo — the station database only, no registry call.
 *
 * For a staff re-grade whose cached answer is the registry's (lib/imeiCache.ts
 * resolveImeiForRegrade): the registry part of that answer is still good, so
 * only the station question is asked again. The station record comes back as
 * parsed, its lost/stolen status NOT backfilled here — the caller holds the
 * registry answer and fills it without paying for it twice.
 */
export async function stationCheck(imei: string): Promise<StationCheck> {
  const { getSetting } = await import("./settings");
  const clean = digits(imei).slice(0, 15);
  const key = getSetting("phonecheck_key", "PHONECHECK_API_KEY");
  const username = getSetting("phonecheck_username", "PHONECHECK_USERNAME");
  const base = getSetting("phonecheck_url", "PHONECHECK_API_URL") || "https://clientapiv2.phonecheck.com";
  if (!key || !username || clean.length !== 15) return { kind: "unconfigured" };

  let res: { status: number; body: any };
  try {
    res = await pcPostStatus(base, key, username, "/cloud/cloudDB/GetDeviceInfo", { imei: clean, IMEI: clean });
  } catch {
    return { kind: "failed" };
  }
  const o = stationRow(res.body, clean);
  if (o) return { kind: "record", report: parsePcReport(o, clean) };
  // 404 / "No Data Found": never tested on this account. Anything else — a 401
  // (a login that may not read station records), a 5xx, an envelope we do not
  // know — is a failure to ask, not an answer.
  const row = Array.isArray(res.body) ? res.body[0] : res.body;
  const msg = String(row?.msg ?? row?.message ?? "");
  return res.status === 404 || /no data found/i.test(msg) ? { kind: "none" } : { kind: "failed" };
}
