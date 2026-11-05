// Field mapping for the GSMA registry response (`/cloud/cloudDB/CheckEsn/`).
//
// Runs against the PRODUCTION parser, not a copy. The payloads below are real
// responses captured from the live service, trimmed only of the refcode.
//
// The risk this guards is not "does the happy path work" — it is that a vendor
// field goes missing or changes wording and an unknown device starts reading as
// clean. A wrong "clean" authorises a payout on a stolen handset.

import assert from "node:assert/strict";
import { parseGsmaResponse, parsePcReport, readBlacklist, readFindMy } from "./phonecheck.ts";

let pass = 0;
const t = (name, fn) => {
  try {
    fn();
    console.log("  ok  ", name);
    pass++;
  } catch (e) {
    console.log("  FAIL", name, "\n       ", e.message);
    process.exitCode = 1;
  }
};

const apple = {
  API: "G001",
  Remarks: "Good",
  deviceid: "353016113100000",
  RawResponse: {
    devicetype: "Smartphone",
    marketingname: "Apple iPhone 12 mini (A2398)",
    brandname: "Apple",
    manufacturer: "Apple Inc",
    responsestatus: "success",
    blackliststatus: "No",
    greyliststatus: null,
    operatingsys: "iOS",
    modelname: "iPhone 12 mini (A2398)",
  },
};

const samsung = {
  API: "G001",
  RawResponse: {
    marketingname: "Galaxy Z Flip5",
    brandname: "Samsung",
    manufacturer: "Samsung Korea",
    blackliststatus: "No",
    operatingsys: "Android",
    modelname: "SM-F731W",
  },
};

const stolen = {
  API: "G001",
  RawResponse: {
    marketingname: "NOKIA 3110",
    brandname: "NA",
    blackliststatus: "Yes",
    modelname: "NOKIA 3110",
  },
};

console.log("phonecheck — GSMA response mapping");

t("resolves a device that never touched a station", () => {
  const r = parseGsmaResponse(samsung, "351242965551131");
  assert.equal(r.found, true);
  assert.equal(r.make, "Samsung");
  assert.equal(r.model, "Galaxy Z Flip5");
  assert.equal(r.source, "gsma");
});

t("keeps the part number when it differs from the marketing name", () => {
  assert.equal(parseGsmaResponse(samsung, "1").modelNumber, "SM-F731W");
});

t("does NOT invent a part number when Apple repeats the model string", () => {
  // modelname "iPhone 12 mini (A2398)" is a name, not a part number — storing
  // it as modelNumber would make an identity comparison fail against a real one.
  assert.equal(parseGsmaResponse(apple, "1").modelNumber, undefined);
});

t('"No" means clean, "Yes" means blacklisted', () => {
  assert.equal(parseGsmaResponse(apple, "1").blacklist, "clean");
  assert.equal(parseGsmaResponse(stolen, "1").blacklist, "blacklisted");
});

t("an absent blacklist field is unknown, NEVER clean", () => {
  const r = parseGsmaResponse({ RawResponse: { marketingname: "Pixel 8" } }, "1");
  assert.equal(r.blacklist, "unknown");
});

t("an unrecognised blacklist word is unknown, not clean", () => {
  const r = parseGsmaResponse(
    { RawResponse: { marketingname: "Pixel 8", blackliststatus: "Pending" } },
    "1"
  );
  assert.equal(r.blacklist, "unknown");
});

t('brand "NA" is an absence, not a manufacturer', () => {
  assert.equal(parseGsmaResponse(stolen, "1").make, undefined);
});

t("never claims battery, SIM lock or Find My — the registry has none", () => {
  const r = parseGsmaResponse(apple, "1");
  assert.equal(r.batteryHealth, 0);
  assert.equal(r.simLock, "unknown");
  assert.equal(r.fmip, "unknown");
  assert.equal(r.erasedKnown, false);
});

t("a carrier refusal is not a device", () => {
  // Carrier services answer as an array with a string RawResponse.
  const refusal = [{ API: "S001", Carrier: "T-Mobile", RawResponse: "IMEI or SN is Invalid" }];
  assert.equal(parseGsmaResponse(refusal, "1"), null);
});

t("an error envelope with no RawResponse is null, not an empty device", () => {
  assert.equal(parseGsmaResponse({ status: 0, msg: "No Data Found" }, "1"), null);
  assert.equal(parseGsmaResponse(null, "1"), null);
});

t("a RawResponse carrying no name at all is null", () => {
  assert.equal(parseGsmaResponse({ RawResponse: { blackliststatus: "No" } }, "1"), null);
});

t("unmapped vendor fields are kept for diagnosis", () => {
  const r = parseGsmaResponse(apple, "1");
  assert.ok(r.extra && Object.keys(r.extra).length > 0);
});

console.log("phonecheck — station record values (GetDeviceInfo)");

// A station record's fields feed the report and the payout block. A wrong
// "clean" or a wrong "Find My: Off" pays out on a stolen or iCloud-locked phone.
const IMEI = "352906112345671";
const station = (over) => parsePcReport({ IMEI, Make: "Apple", Model: "iPhone 14", BatteryHealthPercentage: "88", ...over }, IMEI);

t("lost/stolen is clean ONLY on an explicit token — 'No Response' / 'No Data' are unknown", () => {
  for (const v of ["No Response", "No Data", "No Data Found", "N/A", "NA", "Not Found", "Unknown", "Pending", "Error", "", null, undefined, "Maybe"])
    assert.equal(readBlacklist(v), "unknown", String(v));
  for (const v of ["Clean", "clean", "CLEAN", "No", "Pass", "Passed", "Good", "Not Blacklisted", "ESN: Clean", "Blacklist Status: Clean", "Not lost or stolen"])
    assert.equal(readBlacklist(v), "clean", String(v));
  for (const v of ["Blacklisted", "Black Listed", "Lost", "Stolen", "Lost or Stolen", "Bad ESN", "Barred", "Yes", "Fail"])
    assert.equal(readBlacklist(v), "blacklisted", String(v));
});

t("a station record whose ESN said 'No Response' is NOT clean (so the registry backfill still runs)", () => {
  assert.equal(station({ ESNResponse: "No Response" }).blacklist, "unknown");
  assert.equal(station({ ESNResponse: "No Data" }).blacklist, "unknown");
  assert.equal(station({ ESNResponse: "Clean" }).blacklist, "clean");
  // "Not Blacklisted" used to fall through to /black/ and read as blacklisted.
  assert.equal(station({ ESNResponse: "Not Blacklisted" }).blacklist, "clean");
});

t("Find My comes from DeviceLock / iCloud / FMiP — never from MDM", () => {
  // MDM Off + DeviceLock On: an activation-locked phone. Was "off" (green).
  assert.equal(station({ MDM: "Off", DeviceLock: "On" }).fmip, "on");
  // MDM "No" + DeviceLock On: was "unknown", although the station reported it.
  assert.equal(station({ MDM: "No", DeviceLock: "On" }).fmip, "on");
  // MDM On + DeviceLock Off: Find My is off; MDM is its own fact.
  const r = station({ MDM: "On", DeviceLock: "Off" });
  assert.equal(r.fmip, "off");
  assert.equal(r.mdm, "on");
  // MDM alone says nothing about Find My.
  assert.equal(station({ MDM: "Off" }).fmip, "unknown");
  assert.equal(station({ DeviceLock: "NA" }).fmip, "unknown");
  assert.equal(station({ DeviceLock: "No Response" }).fmip, "unknown");
});

t("when Find My fields disagree, ON wins", () => {
  assert.equal(readFindMy({ FMIP: "Off", DeviceLock: "On" }), "on");
  assert.equal(readFindMy({ iCloudStatus: "Off", DeviceLock: "Off" }), "off");
});

t("carrier lock: 'Not Locked' is unlocked, 'No Response' is unknown", () => {
  assert.equal(station({ UnlockStatus: "Unlocked" }).simLock, "unlocked");
  assert.equal(station({ UnlockStatus: "Not Locked" }).simLock, "unlocked");
  assert.equal(station({ UnlockStatus: "Locked" }).simLock, "locked");
  assert.equal(station({ UnlockStatus: "No Response" }).simLock, "unknown");
});

t("an erase field of 'NA' is not an erase result", () => {
  assert.equal(station({ Erasure: "NA" }).erasedKnown, false);
  assert.equal(station({ Erasure: "Erased" }).erasedKnown, true);
  assert.equal(station({ Erasure: "No" }).erasedKnown, true);
  assert.equal(station({ Erasure: "No" }).erased, false);
});

t("the station's own test time is read only from a time stamp WITH a zone", () => {
  assert.equal(station({ UpdatedTimeStamp: "2026-03-12T17:51:00.00+04:00" }).testedAt, "2026-03-12T13:51:00.000Z");
  assert.equal(station({ UpdatedTimeStamp: "2026-10-20T14:30:00Z" }).testedAt, "2026-10-20T14:30:00.000Z");
  // Zone-less: never guessed in the server's own zone.
  assert.equal(station({ UpdatedTimeStamp: "2026-03-12 17:51:00" }).testedAt, undefined);
  assert.equal(station({ DeviceUpdatedDate: "2026-03-12 17:51:00" }).testedAt, undefined);
});

console.log(pass + " assertions passed\n");
