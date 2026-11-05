// The report's Diagnostics tell the truth PER SOURCE.
//
// SwapUp creates GradeIQ sessions without an IMEI (one paid lookup per case,
// its own call A), and /device fills the IMEI in later without a lookup. The
// session's imei_info therefore stays empty, and the report printed one fixed
// banner — "Phonecheck / ESN API not connected" — on every SwapUp session,
// even when GradeIQ's own lookup table held a real GSMA registry answer.
//
// These tests pin:
//   • no IMEI: "IMEI not recorded on this report", per item;
//   • an IMEI the table already answered: model + lost/stolen from the GSMA
//     registry via Phonecheck, with the check time, and NO new call;
//   • a Phonecheck station record: battery health, cycles, Find My, carrier
//     lock, erase status, report link — labelled "Phonecheck station", with
//     the station's own test time when it sent one, else "looked up <time>";
//   • only what is genuinely missing is said missing, item by item — and a
//     missing station record is said missing FROM THIS REPORT, never "not
//     tested" (GradeIQ cannot see SwapUp's station records);
//   • a lost/stolen status nobody gave is never "clean";
//   • ONE grade: neither the station's letter nor its cosmetics field appears;
//   • a later lookup of the same IMEI never rewrites an older report;
//   • the SuperIQ export reads every diagnostic from the same place.
//
// No network: global fetch only records calls — building a report must make
// none. (The re-grade's lookups are pinned in lib/reprocessLookup.test.mjs.)

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// db.ts opens <cwd>/data/gradeiq.db — never a real database.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "giq-passport-src-")));
for (const k of Object.keys(process.env)) {
  if (/^(GEMINI_|GOOGLE_API_KEY|OPENAI_|MOONSHOT_|KIMI_|VISION_|GRADEIQ_|PHONECHECK_|IMEI_API_|NEXT_PUBLIC_BASE_PATH|PUBLIC_ORIGIN)/.test(k)) delete process.env[k];
}
// Credentials configured, exactly like production — so a stray lookup WOULD
// reach the (fake) network and show up in `calls`.
process.env.PHONECHECK_API_KEY = "pc-test-key";
process.env.PHONECHECK_USERNAME = "pc-test-user";

let pass = 0;
const t = async (name, fn) => {
  try {
    await fn();
    console.log("  ok  ", name);
    pass++;
  } catch (e) {
    console.log("  FAIL", name, "\n       ", e.stack || e.message);
    process.exitCode = 1;
  }
};

/** Luhn check digit, so every test IMEI is a real-shaped one. */
function imeiFrom(body14) {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    let d = +body14[i];
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return body14 + ((10 - (sum % 10)) % 10);
}

const SAMSUNG = imeiFrom("35124296555113"); // never on a station → the GSMA registry answers
const STATION = imeiFrom("35290611234567"); // a Phonecheck station tested it
const SILENT = imeiFrom("35777701234567"); // the registry knows it but gives no lost/stolen status
const STOLEN = imeiFrom("35666601234567"); // the registry reports it lost/stolen
const NOWHERE = imeiFrom("35888801234567"); // neither the station nor the registry knows it

const gsmaBody = (blackliststatus) => ({
  API: "G001",
  RawResponse: {
    marketingname: "Galaxy Z Flip5",
    brandname: "Samsung",
    manufacturer: "Samsung Korea",
    blackliststatus,
    operatingsys: "Android",
    modelname: "SM-F731W",
  },
});
const STATION_ROW = {
  IMEI: STATION,
  Make: "Samsung",
  Model: "Galaxy S23 Ultra",
  ModelNumber: "SM-S918B",
  Color: "Phantom Black",
  Capacity: "256GB",
  BatteryHealthPercentage: "91",
  BatteryCycle: "412",
  DeviceLock: "Off",
  UnlockStatus: "Unlocked",
  Erasure: "Erased",
  ESNResponse: "Clean",
  Grade: "B", // the station's OWN letter — must never reach the report
  Cosmetics: "Light scratches on back glass",
  Failed: "Face ID",
  A4ReportLink: "https://reports.example.test/a4/abc123",
};

/** Every outbound request. A report is built from stored answers only. */
let calls = [];
globalThis.fetch = async (url, init = {}) => {
  const imei = init.body instanceof URLSearchParams ? init.body.get("imei") : "";
  calls.push(`${new URL(String(url)).pathname} ${imei}`);
  return new Response(JSON.stringify({ status: 0, msg: "No Data Found" }), { status: 200, headers: { "Content-Type": "application/json" } });
};

const { buildPassport, DIAG_SOURCE, DIAG_MISSING } = await import("./passport.ts");
const { computeTrust } = await import("./trust.ts");
const { buildDeviceExport } = await import("./deviceExport.ts");
const { parseGsmaResponse, parsePcReport } = await import("./phonecheck.ts");
const { imeiInfoFromReport } = await import("./imei.ts");
const { storedLookup } = await import("./imeiCache.ts");
const { db, getSession } = await import("./db.ts");

function seedSession(id, cols = {}) {
  const c = {
    imei: "",
    model: "Galaxy Z Flip5",
    imei_info: {},
    phonecheck: {},
    ocr: {},
    device: {},
    overall_grade: "",
    cosmetic_grade: "",
    photos: [],
    ...cols,
  };
  db.prepare(
    `INSERT INTO sessions (id, client_id, imei, model, status, imei_info, phonecheck, ocr, device, overall_grade, cosmetic_grade, cosmetic, photos)
     VALUES (?, 'swapup', ?, ?, 'open', ?, ?, ?, ?, ?, ?, '{}', ?)`
  ).run(
    id,
    c.imei,
    c.model,
    JSON.stringify(c.imei_info),
    JSON.stringify(c.phonecheck),
    JSON.stringify(c.ocr),
    JSON.stringify(c.device),
    c.overall_grade,
    c.cosmetic_grade,
    JSON.stringify(c.photos)
  );
  return getSession(id);
}
/** A lookup-table row, as resolveImei writes it. */
function seedLookup(imei, info, phonecheck, at) {
  db.prepare(
    `INSERT INTO imei_lookups (imei, info, phonecheck, at) VALUES (?, ?, ?, ?)
     ON CONFLICT(imei) DO UPDATE SET info = excluded.info, phonecheck = excluded.phonecheck, at = excluded.at`
  ).run(imei, JSON.stringify(info), JSON.stringify(phonecheck), at);
}
const clearCache = () => {
  db.prepare("DELETE FROM imei_lookups").run();
  db.prepare("DELETE FROM paid_lookups").run();
};
const row = (p, key) => p.diagnostics.rows.find((r) => r.key === key);
/** An ISO time `min` minutes ago — a lookup made before the report was written. */
const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
/** ISO → the report's "yyyy-mm-dd hh:mm UTC". */
const fmt = (iso) => `${new Date(iso).toISOString().slice(0, 16).replace("T", " ")} UTC`;
/** Back-date a session's last write (SQLite's own format). */
const writtenAt = (id, sqlTime) => db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(sqlTime, id);
const gsmaReport = (imei, status = "No") => parseGsmaResponse(gsmaBody(status), imei);
const stationReport = (imei = STATION, over = {}) => parsePcReport({ ...STATION_ROW, IMEI: imei, ...over }, imei);

console.log("passport — no IMEI");

await t("no IMEI (like #650F8C): 'IMEI not recorded on this report', station items said per item", () => {
  calls = [];
  const p = buildPassport(seedSession("noimei"));
  assert.equal(row(p, "blacklist").value, null);
  assert.equal(row(p, "blacklist").note, "IMEI not recorded on this report");
  assert.equal(row(p, "batteryHealth").value, null);
  assert.equal(row(p, "batteryHealth").note, "No Phonecheck station record on this report");
  assert.equal(row(p, "fmip").note, "No Phonecheck station record on this report");
  assert.equal(row(p, "carrierLock").note, "No Phonecheck station record on this report");
  assert.equal(p.diagnostics.blacklist, "unknown");
  assert.equal(p.diagnostics.imeiRecorded, false);
  assert.equal(p.diagnostics.source, "IMEI not recorded");
  // Nothing a station alone could say is invented or called missing.
  for (const k of ["registryModel", "batteryCycles", "erased", "stationReport", "stationFailed", "mdm"])
    assert.equal(row(p, k), undefined, k);
  assert.doesNotMatch(JSON.stringify(p), /not connected/i);
  // GradeIQ cannot know whether a station tested the phone — it never says so.
  assert.doesNotMatch(JSON.stringify(p.diagnostics), /not tested|needs a phonecheck station test/i);
  assert.deepEqual(calls, []);
});

console.log("passport — the GSMA registry via Phonecheck (SwapUp's call A, from the table)");

await t("IMEI + a cached GSMA clean answer: model + Clean, source and check time, NO call", () => {
  clearCache();
  const pc = gsmaReport(SAMSUNG);
  const callA = ago(30); // SwapUp's call A, before the IMEI reached the session
  seedLookup(SAMSUNG, imeiInfoFromReport(SAMSUNG, pc), pc, callA);
  // Exactly a SwapUp session: IMEI filled by /device, imei_info and phonecheck empty.
  const s = seedSession("gsma-clean", { imei: SAMSUNG });
  calls = [];
  const p = buildPassport(s);
  const bl = row(p, "blacklist");
  assert.equal(bl.value, "Clean");
  assert.equal(bl.tone, "good");
  assert.equal(bl.source, "GSMA registry via Phonecheck");
  assert.equal(bl.checkedAt, fmt(callA));
  assert.equal(bl.timeLabel, "checked");
  assert.equal(row(p, "registryModel").value, "Samsung Galaxy Z Flip5 · SM-F731W");
  assert.equal(row(p, "registryModel").source, DIAG_SOURCE.registry);
  // The registry carries none of these — each is said missing on its own, as
  // what GradeIQ knows: its lookup (at that time) held no station record.
  for (const k of ["batteryHealth", "fmip", "carrierLock"]) {
    assert.equal(row(p, k).value, null, k);
    assert.equal(row(p, k).note, "No Phonecheck station record when GradeIQ looked up this IMEI", k);
    assert.equal(row(p, k).checkedAt, fmt(callA), k);
    assert.equal(row(p, k).timeLabel, "looked up", k);
  }
  assert.doesNotMatch(JSON.stringify(p.diagnostics), /not tested|needs a phonecheck station test/i);
  assert.equal(row(p, "erased"), undefined);
  assert.equal(p.diagnostics.blacklist, "clean");
  assert.equal(p.diagnostics.source, "GSMA registry");
  assert.equal(p.identification.find((f) => f.label === "Make").value, "Samsung");
  assert.doesNotMatch(JSON.stringify(p), /not connected/i);
  assert.deepEqual(calls, [], "reading the report must never pay for a lookup");
});

await t("an answer older than 24 h is still shown — with its own (old) check time, and still no call", () => {
  const pc = gsmaReport(SAMSUNG);
  const old = ago(9 * 24 * 60);
  seedLookup(SAMSUNG, imeiInfoFromReport(SAMSUNG, pc), pc, old);
  calls = [];
  const bl = row(buildPassport(getSession("gsma-clean")), "blacklist");
  assert.equal(bl.value, "Clean");
  assert.equal(bl.checkedAt, fmt(old));
  assert.deepEqual(calls, []);
});

await t("a lookup made AFTER the report was last written does not speak for it", () => {
  clearCache();
  const pc = gsmaReport(SAMSUNG);
  seedLookup(SAMSUNG, imeiInfoFromReport(SAMSUNG, pc), pc, ago(1));
  seedSession("gsma-later", { imei: SAMSUNG });
  writtenAt("gsma-later", "2026-03-01 10:00:00");
  const p = buildPassport(getSession("gsma-later"));
  assert.equal(row(p, "blacklist").value, null);
  assert.equal(row(p, "blacklist").note, DIAG_MISSING.notChecked);
  assert.equal(row(p, "registryModel"), undefined);
  assert.equal(row(p, "batteryHealth").note, DIAG_MISSING.noStationRecord);
});

await t("the registry answered with NO lost/stolen status: Unknown, never Clean", () => {
  for (const status of [null, "", "Maybe"]) {
    clearCache();
    const pc = parseGsmaResponse(gsmaBody(status), SILENT);
    seedLookup(SILENT, imeiInfoFromReport(SILENT, pc), pc, ago(20));
    db.prepare("DELETE FROM sessions WHERE id = 'gsma-silent'").run();
    const p = buildPassport(seedSession("gsma-silent", { imei: SILENT }));
    const bl = row(p, "blacklist");
    assert.equal(bl.value, "Unknown", String(status));
    assert.equal(bl.tone, undefined);
    assert.equal(bl.note, DIAG_MISSING.registryNoStatus);
    assert.equal(bl.source, DIAG_SOURCE.registry);
    assert.equal(p.diagnostics.blacklist, "unknown");
    assert.ok(!p.diagnostics.rows.some((r) => r.value === "Clean"), "nothing on the report may read Clean");
    // The model it DID give is still shown.
    assert.equal(row(p, "registryModel").value, "Samsung Galaxy Z Flip5 · SM-F731W");
  }
});

await t("the registry reports it lost/stolen: Blacklisted, in red", () => {
  clearCache();
  const pc = gsmaReport(STOLEN, "Yes");
  seedLookup(STOLEN, imeiInfoFromReport(STOLEN, pc), pc, ago(20));
  const p = buildPassport(seedSession("gsma-stolen", { imei: STOLEN }));
  assert.equal(row(p, "blacklist").value, "Blacklisted");
  assert.equal(row(p, "blacklist").tone, "bad");
  assert.equal(p.diagnostics.blacklist, "blacklisted");
});

await t("neither the station database nor the registry had an answer: Unknown, worded neutrally", () => {
  clearCache();
  const at = ago(20);
  const pc = { imei: NOWHERE, found: false, batteryHealth: 0, fmip: "unknown", erased: false, erasedKnown: false, blacklist: "unknown", simLock: "unknown", failedComponents: [], source: "not_found" };
  seedLookup(NOWHERE, { imei: NOWHERE, valid: true, tac: NOWHERE.slice(0, 8), brand: "", model: "Unknown", modelNumber: null, blacklist: "unknown", lock: "unknown", fmip: "unknown", source: "stub" }, pc, at);
  const p = buildPassport(seedSession("nowhere", { imei: NOWHERE }));
  assert.equal(row(p, "blacklist").value, "Unknown");
  // Rows cached before failures were told apart may be failures, so the note
  // does not claim the registry has no record.
  assert.equal(row(p, "blacklist").note, "Phonecheck's station database and the GSMA registry gave no answer for this IMEI");
  assert.doesNotMatch(JSON.stringify(p.diagnostics), /No GSMA registry record/);
  assert.equal(row(p, "blacklist").checkedAt, fmt(at));
  assert.equal(row(p, "registryModel"), undefined);
});

await t("no table row, but /offer stored the GSMA answer on the session: shown too, with its own stamp when it has one", () => {
  clearCache();
  const p = buildPassport(seedSession("offer-gsma", { imei: SAMSUNG, phonecheck: gsmaReport(SAMSUNG) }));
  assert.equal(row(p, "blacklist").value, "Clean");
  assert.equal(row(p, "blacklist").source, DIAG_SOURCE.registry);
  assert.equal(row(p, "blacklist").checkedAt, null, "an unstamped copy has no time to give");
  const at = ago(5);
  const q = buildPassport(seedSession("offer-gsma-stamped", { imei: SAMSUNG, phonecheck: { ...gsmaReport(SAMSUNG), lookedUpAt: at } }));
  assert.equal(row(q, "blacklist").checkedAt, fmt(at));
  assert.equal(row(q, "batteryHealth").checkedAt, fmt(at));
});

await t("the session's own answer comes first; the table fills only a kind the session lacks", () => {
  clearCache();
  // The table: the registry says clean (call A). The session: a station record
  // whose ESN says blacklisted. Both count; blacklisted wins, credited right.
  const at = ago(40);
  const pc = gsmaReport(STATION);
  seedLookup(STATION, imeiInfoFromReport(STATION, pc), pc, at);
  const own = stationReport(STATION, { ESNResponse: "Blacklisted", BatteryHealthPercentage: "77" });
  const p = buildPassport(seedSession("own-first", { imei: STATION, phonecheck: own }));
  assert.equal(row(p, "batteryHealth").value, "77%");
  assert.equal(row(p, "blacklist").value, "Blacklisted");
  assert.equal(row(p, "blacklist").source, DIAG_SOURCE.station);
  // The registry's model (a kind the session lacks) still comes from the table.
  assert.equal(row(p, "registryModel").checkedAt, fmt(at));
});

await t("an IMEI with no answer anywhere: 'Not checked', and a failed lookup says it failed", () => {
  clearCache();
  const none = buildPassport(seedSession("unchecked", { imei: SAMSUNG }));
  assert.equal(row(none, "blacklist").value, null);
  assert.equal(row(none, "blacklist").note, DIAG_MISSING.notChecked);
  assert.equal(none.diagnostics.source, "No Phonecheck record yet");
  const failed = buildPassport(
    seedSession("lookup-failed", { imei: SAMSUNG, phonecheck: { imei: SAMSUNG, found: false, blacklist: "unknown", source: "error" } })
  );
  assert.equal(row(failed, "blacklist").note, "Not checked — the Phonecheck lookup failed");
});

await t("demo (fabricated) Phonecheck values are never shown as facts", () => {
  clearCache();
  const demo = { imei: SAMSUNG, found: false, batteryHealth: 88, fmip: "off", erased: true, erasedKnown: true, blacklist: "clean", simLock: "unlocked", failedComponents: ["Wi-Fi"], source: "demo" };
  const p = buildPassport(seedSession("demo", { imei: SAMSUNG, phonecheck: demo }));
  assert.equal(row(p, "blacklist").value, null);
  assert.equal(row(p, "batteryHealth").value, null);
  assert.equal(row(p, "fmip").value, null);
  assert.equal(row(p, "carrierLock").value, null);
  assert.equal(row(p, "erased"), undefined);
  assert.equal(p.diagnostics.batteryHealth, null);
});

console.log("passport — a Phonecheck station record");

await t("station record (from the table): battery %, cycles, Find My, carrier lock, erase, report link", () => {
  clearCache();
  const rec = stationReport();
  const fetched = ago(15);
  seedLookup(STATION, imeiInfoFromReport(STATION, rec), rec, fetched);
  const s = seedSession("station", { imei: STATION, model: "Galaxy S23 Ultra", overall_grade: "A", cosmetic_grade: "A" });
  calls = [];
  const p = buildPassport(s);
  const at = fmt(fetched);
  const expect = {
    batteryHealth: ["91%", "good"],
    batteryCycles: ["412", undefined],
    fmip: ["Off", "good"],
    carrierLock: ["Unlocked", "good"],
    erased: ["Erased", "good"],
    blacklist: ["Clean", "good"],
    stationFailed: ["Face ID", "bad"],
    stationReport: ["Open report", undefined],
  };
  for (const [k, [value, tone]] of Object.entries(expect)) {
    const r = row(p, k);
    assert.ok(r, k);
    assert.equal(r.value, value, k);
    assert.equal(r.tone, tone, k);
    assert.equal(r.source, "Phonecheck station", k);
    assert.equal(r.checkedAt, at, k);
    // No zoned test time in this record: the time is when GradeIQ FETCHED it,
    // and says so — a station test from weeks ago must not read as today's.
    assert.equal(r.timeLabel, "looked up", k);
  }
  assert.equal(row(p, "stationReport").href, "https://reports.example.test/a4/abc123");
  assert.equal(p.diagnostics.batteryHealth, 91);
  assert.equal(p.diagnostics.fmip, "off");
  assert.equal(p.diagnostics.lock, "unlocked");
  assert.equal(p.diagnostics.source, "Phonecheck station");
  assert.equal(p.identification.find((f) => f.label === "Colour").value, "Phantom Black");
  assert.equal(p.identification.find((f) => f.label === "Storage").value, "256GB");
  assert.equal(computeTrust(s).bands.find((b) => b.label === "Battery health").value, "91%");
  assert.deepEqual(calls, []);
});

await t("a station record with its own (zoned) test time: rows say 'tested <that time>'", () => {
  const rec = stationReport(STATION, { UpdatedTimeStamp: "2026-10-20T14:30:00.00+05:30" });
  const p = buildPassport(seedSession("station-tested", { imei: STATION, phonecheck: rec }), { lookup: null });
  for (const k of ["batteryHealth", "fmip", "carrierLock", "erased"]) {
    assert.equal(row(p, k).checkedAt, "2026-10-20 09:00 UTC", k);
    assert.equal(row(p, k).timeLabel, "tested", k);
  }
});

await t("MDM is shown as its own fact — and Find My is not read from it", () => {
  const rec = stationReport(STATION, { MDM: "Off", DeviceLock: "On" });
  const p = buildPassport(seedSession("station-mdm", { imei: STATION, phonecheck: rec }), { lookup: null });
  assert.equal(row(p, "fmip").value, "On");
  assert.equal(row(p, "fmip").tone, "bad");
  assert.equal(row(p, "mdm").value, "Off");
  const q = buildPassport(seedSession("station-mdm-on", { imei: STATION, phonecheck: stationReport(STATION, { MDM: "On", DeviceLock: "Off" }) }), { lookup: null });
  assert.equal(row(q, "fmip").value, "Off");
  assert.equal(row(q, "mdm").value, "On");
  assert.equal(row(q, "mdm").tone, "bad");
});

await t("a station ESN of 'No Response' / 'No Data' never reaches the report as Clean", () => {
  for (const esn of ["No Response", "No Data"]) {
    const rec = stationReport(STATION, { ESNResponse: esn });
    const p = buildPassport(seedSession(`station-esn-${esn}`, { imei: STATION, phonecheck: rec }), { lookup: null });
    assert.notEqual(row(p, "blacklist").value, "Clean", esn);
    assert.equal(p.diagnostics.blacklist, "unknown", esn);
  }
});

await t("ONE grade: neither the station's letter nor its cosmetics field reaches the report", () => {
  const p = buildPassport(getSession("station"));
  assert.equal(p.finalGrade, "A");
  assert.ok(!p.diagnostics.rows.some((r) => /grade|cosmetic/i.test(r.label)), "no second grade row");
  assert.ok(!p.diagnostics.rows.some((r) => r.value === "B"), "the station's B is not shown");
  // The cosmetics field is as often a grade as a note — every one of these got
  // past the old note filter as a second letter. None is shown now.
  for (const c of ["Light scratches on back glass", "B Grade", "A-Stock", "Grade A - minor scratches", "Cosmetic Grade: C", "Excellent (A)", "B+ light wear", "Grade B+", "B"]) {
    const q = buildPassport(getSession("station"), {
      lookup: { info: null, phonecheck: stationReport(STATION, { Cosmetics: c }), at: ago(15) },
    });
    const shown = q.diagnostics.rows.some((r) => [r.value, r.note].some((v) => v === c || (c.length > 1 && String(v ?? "").includes(c))));
    assert.ok(!shown, c);
    assert.ok(row(q, "batteryHealth").value === "91%", "the rest of the station record still shows");
  }
});

await t("a station record stored on the session (no table row) is used too, without a time", () => {
  clearCache();
  const p = buildPassport(seedSession("station-col", { imei: STATION, phonecheck: stationReport() }));
  assert.equal(row(p, "batteryHealth").value, "91%");
  assert.equal(row(p, "batteryHealth").source, DIAG_SOURCE.station);
  assert.equal(row(p, "batteryHealth").checkedAt, null);
});

await t("a station record that does not report an item says so — Find My 'unknown' is NOT shown as On", () => {
  clearCache();
  const rec = stationReport(STATION, { DeviceLock: undefined, UnlockStatus: undefined, Erasure: undefined, BatteryHealthPercentage: undefined });
  assert.equal(rec.fmip, "unknown");
  const p = buildPassport(seedSession("station-thin", { imei: STATION, phonecheck: rec }));
  for (const k of ["fmip", "carrierLock", "erased", "batteryHealth"]) {
    assert.equal(row(p, k).value, null, k);
    assert.equal(row(p, k).note, "Not reported by the Phonecheck station", k);
  }
  // A DeviceLock of "NA" is the station not reporting it, not "Off" or "On".
  const na = buildPassport(seedSession("station-na", { imei: STATION, phonecheck: stationReport(STATION, { DeviceLock: "NA" }) }), { lookup: null });
  assert.equal(row(na, "fmip").value, null);
  assert.equal(row(na, "fmip").note, "Not reported by the Phonecheck station");
  assert.equal(p.diagnostics.fmip, null);
});

await t("a station record's lost/stolen status filled from the registry is credited to the registry", () => {
  const rec = stationReport(STATION, { ESNResponse: undefined });
  rec.blacklist = "clean";
  rec.extra = { ...(rec.extra ?? {}), blacklistSource: "gsma" };
  const p = buildPassport(seedSession("station-gsma-bl", { imei: STATION, phonecheck: rec }), { lookup: null });
  assert.equal(row(p, "blacklist").value, "Clean");
  assert.equal(row(p, "blacklist").source, "GSMA registry via Phonecheck");
});

await t("any source saying blacklisted wins over another saying clean", () => {
  clearCache();
  const pc = gsmaReport(SAMSUNG);
  seedLookup(SAMSUNG, imeiInfoFromReport(SAMSUNG, pc), pc, ago(30));
  const esn = { imei: SAMSUNG, valid: true, tac: SAMSUNG.slice(0, 8), brand: "Samsung", model: "Galaxy Z Flip5", modelNumber: null, blacklist: "blacklisted", lock: "locked", fmip: "on", source: "esn" };
  const p = buildPassport(seedSession("conflict", { imei: SAMSUNG, imei_info: esn }));
  assert.equal(row(p, "blacklist").value, "Blacklisted");
  assert.equal(row(p, "blacklist").source, "Phonecheck ESN check");
  // The ESN check also carries the locks the registry cannot.
  assert.equal(row(p, "fmip").value, "On");
  assert.equal(row(p, "carrierLock").value, "Locked");
});

await t("a legacy 'api' identity row still answers, labelled as a Phonecheck lookup", () => {
  clearCache();
  const legacy = { imei: SAMSUNG, brand: "Samsung", model: "Galaxy Z Flip5", blacklist: "clean", lock: "unlocked", fmip: "unknown", source: "api" };
  const p = buildPassport(seedSession("legacy", { imei: SAMSUNG, imei_info: legacy }));
  assert.equal(row(p, "blacklist").value, "Clean");
  assert.equal(row(p, "blacklist").source, "Phonecheck lookup");
  assert.equal(row(p, "carrierLock").value, "Unlocked");
});

await t("the Settings screenshot still answers battery health and Find My, labelled as such", () => {
  const p = buildPassport(seedSession("ocr", { ocr: { batteryHealth: 84, findMy: "off" } }));
  assert.equal(row(p, "batteryHealth").value, "84%");
  assert.equal(row(p, "batteryHealth").source, "Settings screenshot");
  assert.equal(row(p, "fmip").value, "Off");
  assert.equal(row(p, "fmip").source, "Settings screenshot");
});

console.log("passport — no blanket banner left");

await t("the report component and the passport carry no 'not connected' banner or stale comment", () => {
  const ui = fs.readFileSync(path.join(ROOT, "app/components/DevicePassport.tsx"), "utf8");
  assert.doesNotMatch(ui, /ESN API not connected/);
  assert.doesNotMatch(ui, /=== "not connected"/);
  const lib = fs.readFileSync(path.join(ROOT, "lib/passport.ts"), "utf8");
  assert.doesNotMatch(lib, /aren't connected here/);
});

await t("the trust score's battery band says 'No reading' — not 'Not connected', not 'Not tested'", () => {
  const band = computeTrust(getSession("noimei")).bands.find((b) => b.label === "Battery health");
  assert.equal(band.value, "No reading");
});

console.log("passport — older reports stay as they were written");

await t("a later lookup of the same IMEI does not rewrite an older report or its export", () => {
  clearCache();
  // A report written in March, with its own station record.
  seedSession("march", { imei: STATION, model: "Galaxy S23 Ultra", phonecheck: stationReport(STATION) });
  writtenAt("march", "2026-03-01 10:00:00");
  const before = buildPassport(getSession("march"));
  const exportBefore = buildDeviceExport(getSession("march"), "https://x.test", "superiq").rows[0];
  // Months later the same phone is traded again and re-tested.
  const later = stationReport(STATION, { BatteryHealthPercentage: "70", Color: "Green", BatteryCycle: "900" });
  seedLookup(STATION, imeiInfoFromReport(STATION, later), later, ago(1));
  const after = buildPassport(getSession("march"));
  assert.equal(row(after, "batteryHealth").value, "91%");
  assert.equal(after.identification.find((f) => f.label === "Colour").value, "Phantom Black");
  assert.equal(after.signature, before.signature);
  assert.deepEqual(after.diagnostics, before.diagnostics);
  const exportAfter = buildDeviceExport(getSession("march"), "https://x.test", "superiq").rows[0];
  assert.equal(exportAfter.batteryHealthPct, 91);
  assert.equal(exportAfter.batteryHealthPct, exportBefore.batteryHealthPct);
});

console.log("passport — the SuperIQ export reads one place");

await t("export row: battery, cycles, blacklist, Find My and carrier lock all from the report's diagnostics", () => {
  clearCache();
  const I = imeiFrom("35290633334444");
  const rec = parsePcReport(
    { IMEI: I, Make: "Apple", Model: "iPhone 14", BatteryHealthPercentage: "81", BatteryCycle: "640", DeviceLock: "On", UnlockStatus: "Locked", ESNResponse: "Blacklisted" },
    I
  );
  seedLookup(I, imeiInfoFromReport(I, rec), rec, ago(10));
  // A SwapUp-shaped session: the IMEI, nothing in its own columns.
  const s = seedSession("export-mix", { imei: I, model: "iPhone 14" });
  const r = buildDeviceExport(s, "https://x.test", "superiq").rows[0];
  assert.equal(r.batteryHealthPct, 81);
  assert.equal(r.batteryCycleCount, 640);
  assert.equal(r.blacklistStatus, "blacklisted");
  assert.equal(r.icloudStatus, "on");
  assert.equal(r.carrierLocked, true);
});

await t("storedLookup reads the table only: no row → null, a partial IMEI → null, never a call", () => {
  clearCache();
  calls = [];
  assert.equal(storedLookup(SAMSUNG), null);
  assert.equal(storedLookup("3512"), null);
  assert.deepEqual(calls, []);
});

console.log(pass + " assertions passed\n");
