import crypto from "node:crypto";
import type { Session } from "./db";
import { gradeFunctional } from "./grading";
import { FUNCTIONAL_TESTS } from "./tests";
import { DEFAULT_CAPTURE_STEPS } from "./journeyTypes";
import { checkIdentity, type IdentityCheck } from "./identity";
import { sessionAlias } from "./sessionAlias";
import { storedLookup, type StoredLookup } from "./imeiCache";

// DeviceFax — the single "one verified record" artefact per device: identity +
// per-component cosmetic evidence + functional results + one final grade, with
// a real SHA-256 signature over the record (auditable, no blockchain theatre).

export type PassportField = { label: string; value: string; mono?: boolean };
// A located cosmetic defect (scratch/crack/chip…) — carried through so the report
// can TAG and HIGHLIGHT it on the photo, not just count it.
export type PassportFinding = {
  type: string; // scratch | crack | chip | dent | scuff | wear | discoloration | deadpixel
  label: string;
  severity: string; // minor | moderate | major (or "")
  box?: [number, number, number, number]; // [ymin,xmin,ymax,xmax] 0..1 on its photo
};
export type PassportComponent = {
  name: string;
  grade: string;
  confidence: number;
  findings: number;
  defects: PassportFinding[]; // the actual located findings for this component
  score: number; // 0..100 derived from the grade
  note: string; // one-line specialist note
};
export type PassportFunctional = {
  name: string;
  state: "pass" | "fail" | "skip" | "untested";
  critical: boolean;
  /**
   * One line of substance behind a pass/fail, where the test has any.
   *
   * "Cameras" is a single row here, but a Pro iPhone has four lenses and the
   * browser can only select one of them — so a bare ✕ on this row can mean
   * anything from "the telephoto is cracked" to "a person ticked a box". The
   * detail is already recorded per lens; not surfacing it is what made this
   * record read thinner than a vendor diagnostic sheet.
   */
  detail?: string;
};

export type PassportAngle = {
  label: string; // FRONT · BACK · LEFT · RIGHT · …
  photo: string | null;
  grade: string;
  confidence: number;
  findings: PassportFinding[]; // located defects seen on THIS photo (for box overlay)
};

export type Passport = {
  id: string;
  imei: string;
  issuedAt: string;
  verified: boolean;
  identification: PassportField[];
  cosmetic: {
    photos: string[];
    components: PassportComponent[];
    angles: PassportAngle[];
    findings: number;
    source: string;
  };
  functional: {
    verdict: string;
    passed: number;
    failed: number;
    /** Tests actually attempted — the honest denominator for "8/8 pass". */
    total: number;
    /** Catalog tests never attempted on this device (Face ID on an Android, etc.). */
    notRun: number;
    catalogTotal: number;
    items: PassportFunctional[];
  };
  diagnostics: Diagnostics;
  parts: {
    checked: boolean;
    anyNonGenuine: boolean;
    items: { name: string; status: string; note?: string }[];
  };
  finalGrade: string;
  score: number | null;
  reliable: boolean; // cosmetic grade trustworthy (photos usable, all assessed)
  retakeReasons: string[];
  obstruction: { present: boolean; type: string; note: string } | null;
  identity: IdentityCheck;
  narrative: string;
  issuer: string;
  specialistCount: number;
  processedAt: string;
  signature: string;
};

/**
 * One line of the Diagnostics section: a value and WHO answered it, or — when
 * nobody did — why not, said for that item alone.
 *
 * The section used to carry one blanket banner ("Phonecheck / ESN API not
 * connected — battery health, Find My, blacklist and carrier-lock can't be
 * verified") whenever the session's own phonecheck column was not a station
 * record. Every SwapUp session hit it, including ones whose IMEI the GSMA
 * registry had already cleared: a real answer reported as no connection.
 */
export type DiagnosticRow = {
  key:
    | "blacklist"
    | "registryModel"
    | "batteryCharge"
    | "batteryHealth"
    | "batteryCycles"
    | "fmip"
    | "mdm"
    | "carrierLock"
    | "erased"
    | "stationFailed"
    | "stationReport";
  label: string;
  /** null = nobody answered; `note` says why. */
  value: string | null;
  note?: string;
  /** Who answered — one of DIAG_SOURCE. */
  source?: string;
  /** "yyyy-mm-dd hh:mm UTC"; null when not recorded. What the time IS is `timeLabel`. */
  checkedAt?: string | null;
  /**
   * What `checkedAt` measures: "tested" — the station's own test time;
   * "looked up" — when GradeIQ fetched the answer (a station test fetched today
   * may be weeks old); "checked" — when the registry was asked.
   */
  timeLabel?: "tested" | "looked up" | "checked";
  tone?: "good" | "warn" | "bad";
  href?: string;
};

export type Diagnostics = {
  batteryLevel: number | null; // live charge %
  charging: boolean | null;
  batteryHealth: number | null; // max-capacity health %
  batteryCycles: number | null;
  fmip: "on" | "off" | null;
  blacklist: "clean" | "blacklisted" | "unknown";
  lock: "unlocked" | "locked" | "unknown";
  /** The sources that answered, short form ("Phonecheck station · GSMA registry"), or why none did. */
  source: string;
  imeiRecorded: boolean;
  rows: DiagnosticRow[];
};

/** Who answered a diagnostic, as the report names it. */
export const DIAG_SOURCE = {
  station: "Phonecheck station",
  registry: "GSMA registry via Phonecheck",
  esn: "Phonecheck ESN check",
  provider: "IMEI provider",
  legacy: "Phonecheck lookup",
  ocr: "Settings screenshot",
  browser: "Device browser",
} as const;

/**
 * The per-item reasons, when nobody answered.
 *
 * Each says what GradeIQ KNOWS, never more. GradeIQ cannot know whether a phone
 * was tested on a station — SwapUp pulls station records through its own
 * Phonecheck login and they do not reach GradeIQ — only whether a station
 * record is on THIS report, and when it last looked.
 */
export const DIAG_MISSING = {
  noImei: "IMEI not recorded on this report",
  /** No station record, and no Phonecheck lookup on this report to have found one. */
  noStationRecord: "No Phonecheck station record on this report",
  /** GradeIQ looked the IMEI up (time in checkedAt) and the answer held no station record. */
  noStationInLookup: "No Phonecheck station record when GradeIQ looked up this IMEI",
  stationSilent: "Not reported by the Phonecheck station",
  registryNoStatus: "The GSMA registry gave no lost/stolen answer — not the same as clean",
  /** source "not_found". Worded neutrally: rows cached before failures were told apart may be failures. */
  registryNoRecord: "Phonecheck's station database and the GSMA registry gave no answer for this IMEI",
  lookupFailed: "Not checked — the Phonecheck lookup failed",
  notChecked: "Not checked — no lost/stolen answer is stored for this report",
  batteryCharge: "Not reported by the phone's browser",
} as const;

const SHORT_SOURCE: Record<string, string> = {
  [DIAG_SOURCE.station]: "Phonecheck station",
  [DIAG_SOURCE.registry]: "GSMA registry",
  [DIAG_SOURCE.esn]: "Phonecheck ESN",
  [DIAG_SOURCE.provider]: "IMEI provider",
  [DIAG_SOURCE.legacy]: "Phonecheck",
  [DIAG_SOURCE.ocr]: "Settings screenshot",
};

/** ISO → "yyyy-mm-dd hh:mm UTC"; anything unparseable → null. */
function fmtCheckedAt(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC` : null;
}

/** A session time as SQLite writes it ("2026-10-29 05:22:37", UTC, no zone) or ISO → epoch ms. */
function sessionTime(v: string | null | undefined): number {
  const t = String(v ?? "").trim();
  if (!t) return NaN;
  return /[zZ]$|[+-]\d{2}:?\d{2}$/.test(t) ? Date.parse(t) : Date.parse(`${t.replace(" ", "T")}Z`);
}

/**
 * Slack between a lookup and the session write that follows it: SQLite's
 * datetime('now') drops the milliseconds the lookup's ISO time keeps, and the
 * create / re-grade routes stamp the session a moment after they look up.
 */
const LOOKUP_MARGIN_MS = 2 * 60 * 1000;

/**
 * The lookup-table answer, if it may speak for THIS report.
 *
 * The table holds ONE row per IMEI and every later paid lookup overwrites it.
 * Read unconditionally, it rewrote an older report — battery, colour, the
 * SuperIQ export — the next time the same phone was traded or re-tested, with
 * the signature unchanged. So a row counts only when it was looked up no later
 * than the report was last written. SwapUp's call A comes before the IMEI
 * reaches the session (/device writes updated_at), so it still counts.
 */
export function lookupForReport(s: Pick<Session, "updated_at">, lookup: StoredLookup | null): StoredLookup | null {
  if (!lookup) return null;
  const at = Date.parse(lookup.at);
  const upd = sessionTime(s.updated_at);
  return Number.isFinite(at) && Number.isFinite(upd) && at <= upd + LOOKUP_MARGIN_MS ? lookup : null;
}

type AnyRec = Record<string, any>;
type Registry = {
  found: boolean;
  make: string;
  model: string;
  modelNumber: string;
  blacklist: "clean" | "blacklisted" | "unknown";
  at: string | null;
};

const tri = <T extends string>(v: unknown, ok: readonly T[]): T | null =>
  (ok as readonly unknown[]).includes(v) ? (v as T) : null;

/** A Phonecheck answer that is a station record: the device was physically tested. */
function asStation(pc: unknown): AnyRec | null {
  const r = pc as AnyRec | null;
  return r && r.source === "api" && r.found !== false ? r : null;
}

/** The same answer, ignoring the time stamps GradeIQ adds to it. */
function sameAnswer(a: unknown, b: unknown): boolean {
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const strip = (x: AnyRec) => JSON.stringify({ ...x, lookedUpAt: undefined, stationCheckedAt: undefined });
  return strip(a as AnyRec) === strip(b as AnyRec);
}

/** A GSMA registry answer (or the registry's "no record"), from a Phonecheck report. */
function registryFromReport(pc: unknown, at: string | null): Registry | null {
  const r = pc as AnyRec | null;
  if (!r) return null;
  if (r.source === "gsma" && r.found !== false) {
    return {
      found: true,
      make: String(r.make || ""),
      model: String(r.model || ""),
      modelNumber: String(r.modelNumber || ""),
      blacklist: tri(r.blacklist, ["clean", "blacklisted"] as const) ?? "unknown",
      at,
    };
  }
  // Station database AND registry both asked, neither had an answer.
  if (r.source === "not_found") {
    return { found: false, make: "", model: "", modelNumber: "", blacklist: "unknown", at };
  }
  return null;
}

/** A GSMA registry answer, from an ImeiInfo derived from one. */
function registryFromInfo(info: unknown, at: string | null): Registry | null {
  const i = info as AnyRec | null;
  if (!i || i.source !== "gsma") return null;
  return {
    found: true,
    make: String(i.brand || ""),
    model: String(i.model || ""),
    modelNumber: String(i.modelNumber || ""),
    blacklist: tri(i.blacklist, ["clean", "blacklisted"] as const) ?? "unknown",
    at,
  };
}

/** Live ImeiInfo sources other than the registry and the station (both handled on their own). */
const INFO_SOURCE: Record<string, string> = {
  esn: DIAG_SOURCE.esn,
  provider: DIAG_SOURCE.provider,
  station: DIAG_SOURCE.station,
  api: DIAG_SOURCE.legacy, // rows stored before the source split
};

/** The latest of some ISO times, or null. */
function latest(times: (string | null | undefined)[]): string | null {
  let best: string | null = null;
  for (const t of times) if (t && Number.isFinite(Date.parse(t)) && (!best || Date.parse(t) > Date.parse(best))) best = t;
  return best;
}

/**
 * DIAGNOSTICS, PER SOURCE.
 *
 * Three places can hold an answer for this device, and each is read without
 * spending anything:
 *   • the session's `phonecheck` column — written by create, /offer, re-grade;
 *   • the session's `imei_info` / `ocr` — identity lookups and the Settings
 *     screenshot;
 *   • GradeIQ's own lookup table (`lookup`, lib/imeiCache.ts) — the answer
 *     SwapUp's call A, session create or a re-grade paid for, with its time.
 *     SwapUp sessions are created WITHOUT an IMEI, so for them this is often the
 *     only place the answer lives.
 * The SESSION'S OWN answer comes first. The table is read only for a kind of
 * answer the session lacks (station record, registry answer, other live
 * identity), and only when it was looked up no later than the report was last
 * written (lookupForReport) — so a later trade of the same phone cannot
 * rewrite this report.
 *
 * What each source can say:
 *   • a Phonecheck STATION record (source "api") — battery health and cycles,
 *     Find My, MDM, carrier lock, erasure, failed tests, the report link;
 *   • the GSMA REGISTRY (source "gsma", via Phonecheck's CheckEsn) — make,
 *     model, model number and lost/stolen. Nothing else: no battery, no locks.
 * A field no source answered says why for THAT field — never one banner for
 * the lot, and never "clean" for a lost/stolen status nobody gave. A station
 * record missing from this report is said to be missing from the report:
 * GradeIQ cannot know whether the phone was tested somewhere it cannot see.
 */
export function buildDiagnostics(s: Session, rawLookup: StoredLookup | null): Diagnostics {
  const pc = (s.phonecheck || {}) as AnyRec;
  const info = (s.imei_info || {}) as AnyRec;
  const ocr = (s.ocr || {}) as AnyRec;
  const device = (s.device || {}) as AnyRec;
  const imeiRecorded = !!String(s.imei || "").trim();
  const lookup = lookupForReport(s, rawLookup);
  const lkPc = (lookup?.phonecheck ?? null) as AnyRec | null;

  /** When a session-stored answer was looked up: its own stamp, else the table's when it is the same answer. */
  const ownAt = (rec: AnyRec, tablePeer: unknown): string | null =>
    rec.lookedUpAt ?? (lookup && sameAnswer(rec, tablePeer) ? lookup.at : null);

  // The station record: the session's own, else the table's.
  const stationOwn = asStation(pc);
  const stationLk = stationOwn ? null : asStation(lkPc);
  const stationRec = stationOwn ?? stationLk;
  const station = stationRec
    ? (() => {
        // The station's own test time when it sent one with a zone; else when
        // GradeIQ fetched the record — labelled as such, never as a test time.
        if (stationRec.testedAt) return { rec: stationRec, checkedAt: fmtCheckedAt(stationRec.testedAt), timeLabel: "tested" as const };
        const fetched = stationOwn ? ownAt(stationOwn, lkPc) : stationLk!.lookedUpAt ?? lookup!.at;
        return { rec: stationRec, checkedAt: fmtCheckedAt(fetched), timeLabel: "looked up" as const };
      })()
    : null;
  const stationTime = station ? { checkedAt: station.checkedAt, timeLabel: station.timeLabel } : {};

  // The registry answer: the session's own, else the table's.
  const registry =
    registryFromReport(pc, ownAt(pc, lkPc)) ??
    registryFromInfo(info, lookup && sameAnswer(info, lookup.info) ? lookup.at : null) ??
    registryFromReport(lkPc, lkPc?.lookedUpAt ?? lookup?.at ?? null) ??
    registryFromInfo(lookup?.info, lookup?.at ?? null);

  // Other live identity sources (v2 ESN, an IMEI provider, legacy rows): the
  // session's, else the table's.
  const liveInfos = (INFO_SOURCE[info.source]
    ? [{ i: info, at: lookup && sameAnswer(info, lookup.info) ? lookup.at : null }]
    : [{ i: lookup?.info as AnyRec | null | undefined, at: lookup?.at ?? null }]
  ).filter((x) => x.i && INFO_SOURCE[x.i.source]);

  // No station record: did GradeIQ look this IMEI up (and when), or not at all?
  const lookedUp = [pc, lkPc].filter((x): x is AnyRec => !!x && ["gsma", "not_found", "error"].includes(x.source));
  const askedAt = latest([
    ...lookedUp.map((x) => x.stationCheckedAt ?? x.lookedUpAt),
    lkPc && lookedUp.includes(lkPc) ? lookup!.at : null,
  ]);
  const asked = imeiRecorded && (lookedUp.length > 0 || info.source === "gsma" || (lookup?.info as AnyRec | null)?.source === "gsma");
  const noStation: Pick<DiagnosticRow, "note" | "checkedAt" | "timeLabel"> = asked
    ? { note: DIAG_MISSING.noStationInLookup, checkedAt: fmtCheckedAt(askedAt), timeLabel: "looked up" }
    : { note: DIAG_MISSING.noStationRecord };
  const stationMissing: Pick<DiagnosticRow, "note" | "checkedAt" | "timeLabel"> = station
    ? { note: DIAG_MISSING.stationSilent, ...stationTime }
    : noStation;

  const rows: DiagnosticRow[] = [];

  /* ── Lost / stolen. Any source saying blacklisted wins; then clean; else unknown. */
  type Verdict = { v: "clean" | "blacklisted"; source: string; checkedAt: string | null; timeLabel?: DiagnosticRow["timeLabel"] };
  const verdicts: Verdict[] = [];
  if (station) {
    const v = tri(station.rec.blacklist, ["clean", "blacklisted"] as const);
    if (v) {
      // getPhonecheck fills a station record's missing status from the
      // registry and marks it — say so, rather than credit the station.
      const fromRegistry = station.rec.extra?.blacklistSource === "gsma";
      verdicts.push({
        v,
        source: fromRegistry ? DIAG_SOURCE.registry : DIAG_SOURCE.station,
        checkedAt: station.checkedAt,
        timeLabel: fromRegistry ? "checked" : station.timeLabel,
      });
    }
  }
  if (registry?.found && registry.blacklist !== "unknown")
    verdicts.push({ v: registry.blacklist, source: DIAG_SOURCE.registry, checkedAt: fmtCheckedAt(registry.at), timeLabel: "checked" });
  for (const x of liveInfos) {
    const v = tri(x.i!.blacklist, ["clean", "blacklisted"] as const);
    if (v) verdicts.push({ v, source: INFO_SOURCE[x.i!.source], checkedAt: fmtCheckedAt(x.at), timeLabel: "checked" });
  }
  const verdict = verdicts.find((x) => x.v === "blacklisted") ?? verdicts.find((x) => x.v === "clean") ?? null;
  const BL_LABEL = "Lost / stolen (blacklist)";
  if (verdict) {
    rows.push({
      key: "blacklist",
      label: BL_LABEL,
      value: verdict.v === "clean" ? "Clean" : "Blacklisted",
      tone: verdict.v === "clean" ? "good" : "bad",
      source: verdict.source,
      checkedAt: verdict.checkedAt,
      timeLabel: verdict.timeLabel,
    });
  } else if (!imeiRecorded) {
    rows.push({ key: "blacklist", label: BL_LABEL, value: null, note: DIAG_MISSING.noImei });
  } else if (registry) {
    // The registry WAS asked: its silence is an answer of "unknown" — shown as
    // such, never as clean.
    rows.push({
      key: "blacklist",
      label: BL_LABEL,
      value: "Unknown",
      note: registry.found ? DIAG_MISSING.registryNoStatus : DIAG_MISSING.registryNoRecord,
      source: DIAG_SOURCE.registry,
      checkedAt: fmtCheckedAt(registry.at),
      timeLabel: "checked",
    });
  } else if (station) {
    rows.push({ key: "blacklist", label: BL_LABEL, value: "Unknown", note: DIAG_MISSING.stationSilent, source: DIAG_SOURCE.station, ...stationTime });
  } else {
    rows.push({
      key: "blacklist",
      label: BL_LABEL,
      value: null,
      note: pc.source === "error" ? DIAG_MISSING.lookupFailed : DIAG_MISSING.notChecked,
    });
  }

  /* ── What the registry says the device is. */
  if (registry?.found && registry.model) {
    const makePrefix =
      registry.make && !registry.model.toLowerCase().startsWith(registry.make.toLowerCase()) ? `${registry.make} ` : "";
    rows.push({
      key: "registryModel",
      label: "Model (GSMA registry)",
      value: `${makePrefix}${registry.model}${registry.modelNumber ? ` · ${registry.modelNumber}` : ""}`,
      source: DIAG_SOURCE.registry,
      checkedAt: fmtCheckedAt(registry.at),
      timeLabel: "checked",
    });
  }

  /* ── Battery charge: the phone's own browser, live. */
  const battery = device.battery as { level?: number; charging?: boolean } | undefined;
  const batteryLevel = typeof battery?.level === "number" ? battery.level : null;
  const charging = typeof battery?.charging === "boolean" ? battery.charging : null;
  rows.push(
    batteryLevel != null
      ? { key: "batteryCharge", label: "Battery charge", value: `${batteryLevel}%${charging ? " ⚡" : ""}`, source: DIAG_SOURCE.browser }
      : { key: "batteryCharge", label: "Battery charge", value: null, note: DIAG_MISSING.batteryCharge }
  );

  /* ── Battery health: a station measures it; the Settings screenshot shows it. */
  const healthTone = (n: number): DiagnosticRow["tone"] => (n >= 90 ? "good" : n >= 80 ? "warn" : "bad");
  let batteryHealth: number | null = null;
  const stationHealth = station && typeof station.rec.batteryHealth === "number" && station.rec.batteryHealth > 0 ? station.rec.batteryHealth : null;
  const ocrHealth = typeof ocr.batteryHealth === "number" && ocr.batteryHealth > 0 ? ocr.batteryHealth : null;
  if (stationHealth != null) {
    batteryHealth = stationHealth;
    rows.push({ key: "batteryHealth", label: "Battery health", value: `${stationHealth}%`, tone: healthTone(stationHealth), source: DIAG_SOURCE.station, ...stationTime });
  } else if (ocrHealth != null) {
    batteryHealth = ocrHealth;
    rows.push({ key: "batteryHealth", label: "Battery health", value: `${ocrHealth}%`, tone: healthTone(ocrHealth), source: DIAG_SOURCE.ocr });
  } else {
    rows.push({ key: "batteryHealth", label: "Battery health", value: null, ...stationMissing });
  }
  const batteryCycles =
    station && typeof station.rec.batteryCycles === "number" && station.rec.batteryCycles >= 0 ? station.rec.batteryCycles : null;
  if (batteryCycles != null) {
    rows.push({ key: "batteryCycles", label: "Battery cycles", value: String(batteryCycles), source: DIAG_SOURCE.station, ...stationTime });
  }

  /* ── Find My / activation lock. Only "on"/"off" is an answer. */
  let fmip: "on" | "off" | null = null;
  let fmipFrom: Pick<DiagnosticRow, "source" | "checkedAt" | "timeLabel"> | null = null;
  const stFmip = station ? tri(station.rec.fmip, ["on", "off"] as const) : null;
  if (stFmip) {
    fmip = stFmip;
    fmipFrom = { source: DIAG_SOURCE.station, ...stationTime };
  } else {
    const x = liveInfos.find((y) => tri(y.i!.fmip, ["on", "off"] as const));
    if (x) {
      fmip = x.i!.fmip;
      fmipFrom = { source: INFO_SOURCE[x.i!.source], checkedAt: fmtCheckedAt(x.at), timeLabel: "checked" };
    } else if (ocr.findMy === "on" || ocr.findMy === "off") {
      fmip = ocr.findMy;
      fmipFrom = { source: DIAG_SOURCE.ocr, checkedAt: null };
    }
  }
  rows.push(
    fmip
      ? { key: "fmip", label: "Find My / activation lock", value: fmip === "off" ? "Off" : "On", tone: fmip === "off" ? "good" : "bad", ...fmipFrom! }
      : { key: "fmip", label: "Find My / activation lock", value: null, ...stationMissing }
  );

  /* ── MDM enrolment — a station's own, separate fact (never read as Find My). */
  const stMdm = station ? tri(station.rec.mdm, ["on", "off"] as const) : null;
  if (stMdm)
    rows.push({ key: "mdm", label: "Device management (MDM)", value: stMdm === "on" ? "On" : "Off", tone: stMdm === "on" ? "bad" : "good", source: DIAG_SOURCE.station, ...stationTime });

  /* ── Carrier lock. */
  let lock: "unlocked" | "locked" | "unknown" = "unknown";
  let lockFrom: Pick<DiagnosticRow, "source" | "checkedAt" | "timeLabel"> | null = null;
  const stLock = station ? tri(station.rec.simLock, ["unlocked", "locked"] as const) : null;
  if (stLock) {
    lock = stLock;
    lockFrom = { source: DIAG_SOURCE.station, ...stationTime };
  } else {
    const x = liveInfos.find((y) => tri(y.i!.lock, ["unlocked", "locked"] as const));
    if (x) {
      lock = x.i!.lock;
      lockFrom = { source: INFO_SOURCE[x.i!.source], checkedAt: fmtCheckedAt(x.at), timeLabel: "checked" };
    }
  }
  rows.push(
    lockFrom
      ? { key: "carrierLock", label: "Carrier lock", value: lock === "unlocked" ? "Unlocked" : "Locked", tone: lock === "unlocked" ? "good" : "warn", ...lockFrom }
      : { key: "carrierLock", label: "Carrier lock", value: null, ...stationMissing }
  );

  /* ── What only a station record carries. Absent without one — nobody else
   *    measures these, so there is nothing to call missing. ONE grade on this
   *    report: neither the station's letter (vendorGrade) nor its cosmetics
   *    field — which is as often a grade ("B Grade", "A-Stock") as a note — is
   *    shown; the station's own report link carries both. */
  if (station) {
    const r = station.rec;
    rows.push(
      r.erasedKnown
        ? { key: "erased", label: "Erase status", value: r.erased ? "Erased" : "Not erased", tone: r.erased ? "good" : "warn", source: DIAG_SOURCE.station, ...stationTime }
        : { key: "erased", label: "Erase status", value: null, note: DIAG_MISSING.stationSilent, ...stationTime }
    );
    const failed: string[] = Array.isArray(r.failedComponents) ? r.failedComponents.map(String).filter(Boolean) : [];
    if (failed.length)
      rows.push({ key: "stationFailed", label: "Failed on the station", value: failed.slice(0, 8).join(", "), tone: "bad", source: DIAG_SOURCE.station, ...stationTime });
    if (typeof r.reportUrl === "string" && /^https?:\/\//i.test(r.reportUrl))
      rows.push({ key: "stationReport", label: "Phonecheck report", value: "Open report", href: r.reportUrl, source: DIAG_SOURCE.station, ...stationTime });
  }

  const blacklistValue = rows.find((r) => r.key === "blacklist")?.value;
  const sources = Array.from(
    new Set(rows.map((r) => r.source).filter((x): x is string => !!x && x !== DIAG_SOURCE.browser).map((x) => SHORT_SOURCE[x] ?? x))
  );

  return {
    batteryLevel,
    charging,
    batteryHealth,
    batteryCycles,
    fmip,
    blacklist: blacklistValue === "Clean" ? "clean" : blacklistValue === "Blacklisted" ? "blacklisted" : "unknown",
    lock,
    source: sources.length ? sources.join(" · ") : imeiRecorded ? "No Phonecheck record yet" : "IMEI not recorded",
    imeiRecorded,
    rows,
  };
}

function yearOf(iso: string): number {
  const y = Number((iso || "").slice(0, 4));
  return y >= 2000 ? y : new Date().getUTCFullYear();
}

/** Normalize raw vision findings → the passport's taggable/highlightable shape. */
function mapFindings(raw: unknown): PassportFinding[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((f) => f && (f.type || f.label))
    .slice(0, 8)
    .map((f) => ({
      type: String(f.type || "wear"),
      label: String(f.label || f.type || "Defect"),
      severity: String(f.severity || ""),
      box:
        Array.isArray(f.box) && f.box.length === 4
          ? (f.box.map(Number) as [number, number, number, number])
          : undefined,
    }));
}

/**
 * `opts.lookup` is the answer GradeIQ's lookup table already holds for this
 * IMEI (lib/imeiCache.ts storedLookup). Left out, it is read here — a table
 * read, never a paid call — so every surface built on the passport (report,
 * printable passport, trust score, export) tells the same story. Pass `null`
 * to build from the session alone. Either way it counts only when it was
 * looked up no later than this report was last written (lookupForReport), and
 * only for what the session's own columns lack.
 */
export function buildPassport(s: Session, opts: { lookup?: StoredLookup | null } = {}): Passport {
  const cos = s.cosmetic as any;
  const imei = s.imei_info as any;
  const device = s.device as any;
  const ocr = s.ocr as any;
  const verdict = gradeFunctional(s.functional);
  const lookup = lookupForReport(s, opts.lookup !== undefined ? opts.lookup : s.imei ? storedLookup(s.imei) : null);
  const diagnostics = buildDiagnostics(s, lookup);

  // Identity details only a STATION record carries (it read them off the
  // device). Any other Phonecheck answer — the registry, a failed or demo
  // lookup — has none of them, and a demo one must never supply them. The
  // session's own record first; the table's only when it may speak for this
  // report (see above).
  const st = [s.phonecheck, lookup?.phonecheck].find(
    (x) => (x as any)?.source === "api" && (x as any)?.found !== false
  ) as any;
  // The registry's answer (make/model) for an IMEI-less-at-create session.
  const reg = [s.phonecheck, lookup?.phonecheck, lookup?.info].find(
    (x) => (x as any)?.source === "gsma" && (x as any)?.found !== false
  ) as any;

  const identification: PassportField[] = [
    {
      label: "Make",
      value: imei?.brand || reg?.make || reg?.brand || st?.make || device?.brand || s.model?.split(" ")[0] || "—",
    },
    { label: "Model", value: s.model || imei?.model || reg?.model || st?.model || "—" },
    {
      label: "Storage",
      value: device?.storageGB
        ? `${device.storageGB} GB`
        : st?.capacity || ocr?.storage || device?.storageText || "—",
    },
    { label: "Colour", value: device?.color || st?.colour || "—" },
    { label: "OS", value: ocr?.os || device?.os || "—" },
    { label: "Carrier", value: ocr?.carrier || st?.carrier || "—" },
    { label: "IMEI", value: s.imei || "—", mono: true },
    { label: "Serial", value: device?.serial || st?.serial || ocr?.serial || "—", mono: true },
  ];

  const GRADE_SCORE: Record<string, number> = {
    Premium: 100,
    A: 92,
    B: 78,
    C: 55,
    D: 30,
  };
  const components: PassportComponent[] = Array.isArray(cos?.specialists)
    ? cos.specialists
        .filter((x: any) => x.weight > 0)
        .map((x: any) => {
          const nFind = Array.isArray(x.findings) ? x.findings.length : 0;
          // Low confidence = the AI could NOT actually see/assess this component
          // (glare, blur, missing angle). Never present that as a grade.
          const assessed = (x.confidence ?? 0) >= 0.3;
          const note = !assessed
            ? x.notes || "Couldn't assess — retake this angle for a reliable grade."
            : typeof x.notes === "string" && x.notes
              ? x.notes
              : nFind > 0
                ? `${nFind} finding${nFind > 1 ? "s" : ""} detected.`
                : "No defects found — best grade.";
          return {
            name: String(x.name || "").replace(" Specialist", ""),
            grade: assessed ? x.grade : "—",
            confidence: x.confidence,
            findings: nFind,
            defects: assessed ? mapFindings(x.findings) : [],
            score: assessed ? GRADE_SCORE[x.grade] ?? 60 : 0,
            note,
          };
        })
    : [];

  // Device OS — so platform-specific tests (Face ID = iOS only) don't show on
  // the wrong device. Prefer the tested device's own fingerprint.
  const fpUa = String((s.verification as any)?.deviceFp?.ua || "");
  const idStr = `${imei?.brand || ""} ${s.model || ""}`;
  const deviceOs = /iphone|ipad|ipod/i.test(fpUa)
    ? "ios"
    : /android/i.test(fpUa)
      ? "android"
      : /apple|iphone|ipad/i.test(idStr)
        ? "ios"
        : /samsung|galaxy|pixel|android|xiaomi|oneplus|motorola|oppo|vivo/i.test(idStr)
          ? "android"
          : "";

  /* Per-lens summary for the Cameras row.
   *
   * Says how many lenses were verified, how many are still unchecked, and how
   * many of the verdicts came from a person rather than a measurement — the
   * distinction that matters when the browser cannot address the ultrawide or
   * telephoto at all and someone had to check them by hand. */
  const lenses: { state: string; by?: string }[] = Array.isArray((s.camera as any)?.lenses)
    ? (s.camera as any).lenses
    : [];
  let cameraDetail: string | undefined;
  if (lenses.length) {
    const verified = lenses.filter((l) => l.state === "pass").length;
    const failed = lenses.filter((l) => l.state === "fail").length;
    const pending = lenses.filter((l) => l.state === "manual").length;
    const byHand = lenses.filter((l) => l.by === "operator").length;
    const bits = [`${verified}/${lenses.length} lenses verified`];
    if (failed) bits.push(`${failed} faulty`);
    if (pending) bits.push(`${pending} not testable in-browser`);
    if (byHand) bits.push(`${byHand} checked by hand`);
    cameraDetail = bits.join(" · ");
  }

  const items: PassportFunctional[] = FUNCTIONAL_TESTS.filter(
    (t) => t.platform === "all" || !deviceOs || t.platform === deviceOs
  ).map((t) => ({
    name: t.name,
    state: (s.functional[t.id] as any) || "untested",
    critical: !!t.critical,
    detail: t.id === "camera" ? cameraDetail : undefined,
  }));

  // Per-angle cosmetic cards (FRONT / BACK / LEFT / RIGHT …): map each captured
  // photo to the angle it was shot at and to the component grade for that side.
  // Label each photo by the angle it was ACTUALLY shot at. The V2 capture flow
  // (V2Cam) guides the operator through DEFAULT_CAPTURE_STEPS — Front, Back,
  // Left, Right, Top, Bottom — and can persist the exact step labels it used on
  // the session (`screen.angleLabels`, incl. per-client journey overrides). Use
  // those when present; otherwise fall back to the default capture order.
  //
  // NB: do NOT reconstruct this from anglesFor()/a "screen OFF" prefix — that
  // model-aware order belongs to the legacy guided flow and drifts against V2's
  // fixed order by one-or-more slots, which is what mislabelled Back as "SCREEN",
  // Left as "BACK" and the Bottom/charge-port shot as "CAMERAS".
  const storedAngles = (s.screen as any)?.angleLabels;
  const angleSeq: string[] =
    Array.isArray(storedAngles) && storedAngles.length
      ? storedAngles.map(String)
      : DEFAULT_CAPTURE_STEPS.map((c) => c.label);
  // Side→grade lookup straight from the raw specialists.
  const specById: Record<string, { grade: string; confidence: number }> = {};
  if (Array.isArray(cos?.specialists))
    for (const x of cos.specialists)
      specById[x.id] = { grade: x.grade, confidence: x.confidence };
  const gradeForSide = (label: string) => {
    if (label === "FRONT") return specById.front ?? specById.display;
    if (label === "SCREEN") return specById.display ?? specById.front;
    if (label === "BACK") return specById.back ?? specById.cameras;
    if (label === "CAMERAS") return specById.cameras ?? specById.back;
    return specById.frame; // LEFT/RIGHT/TOP/BOTTOM/CORNERS → frame & body
  };
  const allFindings: any[] = Array.isArray(cos?.findings) ? cos.findings : [];
  const angles: PassportAngle[] = s.photos.map((photo, i) => {
    const label = shortAngle(angleSeq[i] ?? "Extra");
    const g = gradeForSide(label);
    return {
      label,
      photo,
      grade: g?.grade ?? "",
      confidence: g?.confidence ?? 0,
      findings: mapFindings(allFindings.filter((f) => f?.photoIndex === i)),
    };
  });

  // Diagnostics (battery health, Find My, lost/stolen, carrier lock) come from
  // buildDiagnostics above, per source: a Phonecheck station record, the GSMA
  // registry via Phonecheck, the Settings screenshot — each labelled, and each
  // missing item said missing on its own. Battery *charge* is the device's own
  // browser reading. Fabricated (demo) Phonecheck values are never used.

  const findings = Array.isArray(cos?.findings) ? cos.findings.length : 0;
  const score = typeof cos?.score === "number" ? cos.score : null;
  const finalGrade = s.overall_grade || s.cosmetic_grade || "—";
  const verified = !!(
    s.cosmetic_grade &&
    cos?.conclusive &&
    imei?.valid !== false &&
    verdict.grade !== "Faulty"
  );

  // The cosmetic grade is only RELIABLE if the AI's intake gate passed AND every
  // component was actually assessable. Otherwise the "grade" is over-claiming
  // (e.g. Premium off the back while the front glass was hidden by glare).
  const unassessed = components
    .filter((c) => c.grade === "—")
    .map((c) => c.name);

  // Critical-coverage floor. A component the AI couldn't see at all is dropped to
  // weight 0 and disappears from `components` entirely — so without this check a
  // report could read "reliable" off the back/frame while the front glass was
  // never actually captured. The three core surfaces MUST each be genuinely seen
  // (present, weighted, confidence ≥ 0.3) before any grade is trustworthy.
  const CORE: { id: string; label: string }[] = [
    { id: "front", label: "Front glass" },
    { id: "back", label: "Back glass" },
    { id: "frame", label: "Frame & body" },
  ];
  const rawSpecs: any[] = Array.isArray(cos?.specialists) ? cos.specialists : [];
  const coreGaps = CORE.filter((c) => {
    const sp = rawSpecs.find((x) => x.id === c.id);
    return !sp || !(sp.weight > 0) || (sp.confidence ?? 0) < 0.3;
  }).map((c) => `${c.label} not clearly captured — retake this side`);

  // A case / cover / screen protector hides the real surface — the grade can't
  // be trusted until it's removed and the photos retaken.
  const obs = (cos?.obstruction as any) || null;
  const obstruction =
    obs && obs.present
      ? { present: true, type: String(obs.type || "cover"), note: String(obs.note || "") }
      : null;

  const cosmeticReliable = !!(
    s.cosmetic_grade &&
    cos?.conclusive &&
    unassessed.length === 0 &&
    coreGaps.length === 0 &&
    !obstruction
  );
  const retakeReasons: string[] = Array.from(
    new Set([
      ...(obstruction
        ? [`Remove the ${obstruction.type} and retake — it hides the real condition.`]
        : []),
      ...(Array.isArray(cos?.intake?.issues) ? cos.intake.issues : []),
      ...(Array.isArray(cos?.intake?.missingAngles)
        ? cos.intake.missingAngles
        : []),
      ...unassessed.map((n) => `${n} couldn't be assessed`),
      ...coreGaps,
    ])
  );

  // Anti-fraud: does the tested/photographed device match the scanned IMEI?
  const identity = checkIdentity(s);

  const faults = verdict.criticalFailures;
  const narrative =
    finalGrade === "—"
      ? "Grading in progress — capture cosmetics and run the functional tests to complete the record."
      : `${gradeWord(s.cosmetic_grade)} cosmetic condition${
          findings ? ` with ${findings} finding${findings > 1 ? "s" : ""}` : ""
        }. ${
          verdict.grade === "Faulty"
            ? `Functional fault: ${faults.join(", ")}.`
            : verdict.grade === "Working"
              ? "All tested functions pass."
              : "Functional tests pending."
        }`;

  const specialistCount = components.length;
  const sigPayload = JSON.stringify({
    id: s.id,
    model: s.model,
    imei: s.imei,
    grade: finalGrade,
    score,
    functional: verdict.grade,
    assessments: s.assessments,
  });
  const signature = crypto.createHash("sha256").update(sigPayload).digest("hex");

  return {
    id: `DFX-${yearOf(s.created_at)}-${sessionAlias(s.id)}`,
    imei: s.imei || "",
    issuedAt: s.updated_at,
    verified,
    identification,
    cosmetic: {
      photos: s.photos,
      components,
      angles,
      findings,
      source: cos?.source || "—",
    },
    functional: {
      verdict: verdict.grade || "not tested",
      passed: verdict.passed,
      failed: verdict.failed,
      // ATTEMPTED tests, not the size of the catalog — see FunctionalVerdict.
      total: verdict.total,
      notRun: verdict.notRun,
      catalogTotal: verdict.catalogTotal,
      items,
    },
    diagnostics,
    parts: {
      checked: !!(s.parts as any)?.found,
      anyNonGenuine: !!(s.parts as any)?.anyNonGenuine,
      items: Array.isArray((s.parts as any)?.parts) ? (s.parts as any).parts : [],
    },
    finalGrade,
    score,
    reliable: cosmeticReliable,
    retakeReasons: retakeReasons.slice(0, 6),
    obstruction,
    identity,
    narrative,
    issuer: "GradeIQ Vision AI",
    specialistCount,
    processedAt: s.updated_at,
    signature,
  };
}

function shortAngle(a: string): string {
  const l = (a || "").toLowerCase();
  if (/off/.test(l)) return "FRONT"; // screen-OFF front shot
  if (/back|rear/.test(l)) return "BACK"; // before camera: "Back — 3 rear cameras"
  if (/camera|lens/.test(l)) return "CAMERAS";
  if (/left/.test(l)) return "LEFT";
  if (/right/.test(l)) return "RIGHT";
  if (/top/.test(l)) return "TOP";
  if (/bottom|port|usb|charg/.test(l)) return "BOTTOM";
  if (/corner/.test(l)) return "CORNERS"; // before screen: "Screen corners"
  if (/screen|display/.test(l)) return "SCREEN";
  if (/front/.test(l)) return "FRONT";
  return "EXTRA";
}

function gradeWord(g: string): string {
  return (
    {
      Premium: "Pristine",
      A: "Excellent",
      B: "Good",
      C: "Fair",
      D: "Poor",
    } as Record<string, string>
  )[g] || "Assessed";
}
