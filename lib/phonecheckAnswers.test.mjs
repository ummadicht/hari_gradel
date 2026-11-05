// What a Phonecheck lookup ANSWERED, told apart from what it failed to ask.
//
// getPhonecheck turned every failed GSMA registry call (HTTP 500, a 401 from
// bad credentials, an HTML error page) into source "not_found", which the
// lookup cache keeps for 24 h and the report printed as a registry fact. These
// tests pin:
//   • a registry that answered "nothing for this IMEI" → not_found, cached;
//   • a registry that could not be asked → error, NOT cached (asked again next time);
//   • stationCheck asks the station database only — record / none / failed.
//
// No network: global fetch is a scripted fake. IMEIs are made up.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// db.ts opens <cwd>/data/gradeiq.db — never a real database.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "giq-pc-answers-")));
for (const k of Object.keys(process.env)) {
  if (/^(GEMINI_|GOOGLE_API_KEY|OPENAI_|GRADEIQ_|PHONECHECK_|IMEI_API_|NEXT_PUBLIC_BASE_PATH|PUBLIC_ORIGIN)/.test(k)) delete process.env[k];
}
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

/** Per IMEI: what CheckEsn and GetDeviceInfo do. Default: no station record, registry clean. */
const mode = {};
let calls = [];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const imei = init.body instanceof URLSearchParams ? init.body.get("imei") : "";
  calls.push(`${u.pathname} …${imei.slice(-4)}`);
  const m = mode[imei] ?? {};
  if (u.pathname.startsWith("/cloud/cloudDB/GetDeviceInfo")) {
    if (m.station === "401") return json({ status: 0, msg: "Unauthorized" }, 401);
    if (m.station === "502") return new Response("<html>502 Bad Gateway</html>", { status: 502 });
    if (m.station && typeof m.station === "object") return json([m.station]);
    return json({ status: 0, msg: "No Data Found" });
  }
  if (u.pathname.startsWith("/cloud/cloudDB/CheckEsn")) {
    if (m.esn === "500") return new Response("<html>500 Internal Server Error</html>", { status: 500 });
    if (m.esn === "401") return json({ status: 0, msg: "Post Data is missing" }, 401);
    if (m.esn === "weird") return json({ status: 0, msg: "Service busy" });
    if (m.esn === "none") return json({ status: 0, msg: "No Data Found" });
    if (m.esn === "invalid") return json({ API: "G001", RawResponse: "IMEI or SN is Invalid" });
    return json({ API: "G001", RawResponse: { marketingname: "Galaxy Z Flip5", brandname: "Samsung", blackliststatus: "No", modelname: "SM-F731W" } });
  }
  throw new Error(`unexpected fetch ${u.href}`);
};

const { getPhonecheck, gsmaAsk, stationCheck } = await import("./phonecheck.ts");
const { resolveImei, storedLookup } = await import("./imeiCache.ts");
const { db } = await import("./db.ts");
const cached = (imei) => !!db.prepare("SELECT 1 FROM imei_lookups WHERE imei = ?").get(imei);

console.log("phonecheck — a failed registry call is not the registry's answer");

await t("CheckEsn HTTP 500 / 401 / an unknown envelope → 'error', never 'not_found'", async () => {
  for (const [esn, body] of [["500", "35124296000001"], ["401", "35124296000002"], ["weird", "35124296000003"]]) {
    const I = imeiFrom(body);
    mode[I] = { esn };
    assert.equal((await gsmaAsk(I)).kind, "failed", esn);
    assert.equal((await getPhonecheck(I)).source, "error", esn);
  }
});

await t("…and resolveImei does NOT cache it — the next ask tries again", async () => {
  const I = imeiFrom("35124296000004");
  mode[I] = { esn: "401" };
  const r = await resolveImei(I, Date.now(), { caller: "server", ip: "" });
  assert.equal(r.phonecheck.source, "error");
  assert.equal(cached(I), false, "a failure is not kept for 24 h");
  assert.equal(r.info.blacklist, "unknown");
});

await t("the registry answering 'no record' IS an answer: not_found, cached", async () => {
  for (const [esn, body] of [["none", "35124296000005"], ["invalid", "35124296000006"]]) {
    const I = imeiFrom(body);
    mode[I] = { esn };
    assert.equal((await gsmaAsk(I)).kind, "no-record", esn);
    const r = await resolveImei(I, Date.now(), { caller: "server", ip: "" });
    assert.equal(r.phonecheck.source, "not_found", esn);
    assert.equal(cached(I), true, esn);
  }
});

await t("a registry answer is stamped with the time it was looked up", async () => {
  const I = imeiFrom("35124296000007");
  const now = Date.parse("2026-10-29T06:00:00.000Z");
  const r = await resolveImei(I, now, { caller: "server", ip: "" });
  assert.equal(r.phonecheck.source, "gsma");
  assert.equal(r.phonecheck.lookedUpAt, "2026-10-29T06:00:00.000Z");
  assert.equal(storedLookup(I).phonecheck.lookedUpAt, "2026-10-29T06:00:00.000Z");
  // A hit hands the same time back.
  const again = await resolveImei(I, now + 1000, { caller: "server", ip: "" });
  assert.equal(again.cached, true);
  assert.equal(again.phonecheck.lookedUpAt, "2026-10-29T06:00:00.000Z");
});

console.log("phonecheck — stationCheck asks the station database only");

await t("a station record → 'record'; 'No Data Found' → 'none'; 401 / 502 → 'failed' — and never CheckEsn", async () => {
  const REC = imeiFrom("35290611000001");
  mode[REC] = { station: { IMEI: REC, Make: "Samsung", Model: "Galaxy S23", BatteryHealthPercentage: "90" } };
  const NONE = imeiFrom("35290611000002");
  const DENIED = imeiFrom("35290611000003");
  mode[DENIED] = { station: "401" };
  const DOWN = imeiFrom("35290611000004");
  mode[DOWN] = { station: "502" };
  calls = [];
  const r = await stationCheck(REC);
  assert.equal(r.kind, "record");
  assert.equal(r.report.batteryHealth, 90);
  assert.equal((await stationCheck(NONE)).kind, "none");
  assert.equal((await stationCheck(DENIED)).kind, "failed", "a login that may not read station records is not 'no record'");
  assert.equal((await stationCheck(DOWN)).kind, "failed");
  assert.ok(calls.every((c) => c.startsWith("/cloud/cloudDB/GetDeviceInfo")), calls.join(" | "));
  assert.equal(calls.length, 4);
});

console.log(pass + " assertions passed\n");
