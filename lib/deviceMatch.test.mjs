// "Is the phone that was tested the phone the session started on?"
//
// Built from a real session: rows 1 and 3 are Chrome 150 / Android 10, row 2 is
// Chrome 151 on a different carrier IP. The IPs differ on rows 1 and 2 for the
// same person in the same room, which is exactly why IP is not consulted.
//
// The bias under test: a MISMATCH must be provable before it is claimed.
// "unknown" is a first-class answer — most sessions carry little signal, and
// flagging those would bury the genuine swaps.

import assert from "node:assert/strict";
import { compareDevices, checkSessionDevices } from "./deviceMatch.ts";

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

const dev = (browser, os, extra = {}) => ({
  parsed: { kind: "mobile", browser, os, model: extra.model || "" },
  ...extra,
});

// The real session from the report.
const ORIGIN = dev("Chrome 150", "Android 10");
const CAMERA = dev("Chrome 151", "Android 10");
const REPORTED = dev("Chrome 150", "Android 10", { screen: "412x960" });

console.log("deviceMatch — the real session");

t("started-on and under-test read as the same phone", () => {
  assert.equal(compareDevices(ORIGIN, REPORTED).verdict, "same");
});

t("the camera device is correctly a different one", () => {
  assert.equal(compareDevices(ORIGIN, CAMERA).verdict, "different");
});

t("the session as a whole is not a concern", () => {
  const r = checkSessionDevices({ origin: ORIGIN, camera: CAMERA, reported: REPORTED });
  assert.equal(r.concern, false);
  assert.match(r.summary, /same phone, photographed by a second device/);
});

console.log("deviceMatch — the swap this exists to catch");

t("a different MODEL between start and test is a concern", () => {
  const r = checkSessionDevices({
    origin: dev("Chrome 150", "Android 14", { model: "SM-S918B" }),
    camera: CAMERA,
    reported: dev("Chrome 150", "Android 14", { model: "SM-A146B" }),
  });
  assert.equal(r.concern, true);
  assert.equal(r.underTest.verdict, "different");
  assert.match(r.underTest.reasons.join(" "), /model/);
  assert.match(r.summary, /different phone/);
});

t("a different OS between start and test is a concern", () => {
  const r = checkSessionDevices({
    origin: dev("Chrome 150", "Android 10"),
    reported: dev("Chrome 150", "Android 14"),
  });
  assert.equal(r.concern, true);
});

t("a different SCREEN between start and test is a concern", () => {
  const r = checkSessionDevices({
    origin: dev("Chrome 150", "Android 10", { screen: "412x960" }),
    reported: dev("Chrome 150", "Android 10", { screen: "360x800" }),
  });
  assert.equal(r.concern, true);
});

t("the reasons name what actually differed", () => {
  const r = compareDevices(
    dev("Chrome 150", "Android 10", { screen: "412x960" }),
    dev("Chrome 151", "Android 10", { screen: "360x800" })
  );
  const joined = r.reasons.join(" | ");
  assert.match(joined, /screen: 412x960 vs 360x800/);
  assert.match(joined, /browser/);
  assert.ok(!/OS/.test(joined), "OS agreed and must not be listed as differing");
});

console.log("deviceMatch — refuses to guess");

t("a missing record is unknown, never a concern", () => {
  const r = checkSessionDevices({ origin: ORIGIN, camera: CAMERA, reported: undefined });
  assert.equal(r.underTest.verdict, "unknown");
  assert.equal(r.concern, false);
});

t("two records with nothing comparable are unknown", () => {
  const r = compareDevices({ parsed: {} }, { parsed: {} });
  assert.equal(r.verdict, "unknown");
});

t("matching only on device KIND is not evidence of sameness", () => {
  // Both "mobile" and nothing else — that describes half the planet.
  const r = compareDevices({ parsed: { kind: "mobile" } }, { parsed: { kind: "mobile" } });
  assert.equal(r.verdict, "unknown");
});

t("a client-hint model is used when the UA carries none", () => {
  const a = { parsed: { browser: "Chrome 150", os: "Android 14" }, model: { label: "Pixel 8" } };
  const b = { parsed: { browser: "Chrome 150", os: "Android 14" }, model: { label: "SM-A146B" } };
  assert.equal(compareDevices(a, b).verdict, "different");
});

t("the camera being the same phone is surfaced, not silently accepted", () => {
  const r = checkSessionDevices({ origin: ORIGIN, camera: ORIGIN, reported: REPORTED });
  assert.equal(r.concern, false); // not a swap …
  assert.match(r.summary, /camera device looks like that same phone/); // … but worth saying
});

console.log("deviceMatch — the documented blind spot");

t("two IDENTICAL handsets cannot be told apart, and it does not pretend", () => {
  // Same model, OS, browser and screen on both sides reads as "same". This is a
  // real limit of browser-visible signals; the module says so rather than
  // inventing certainty.
  const twin = dev("Chrome 150", "Android 14", { model: "SM-S918B", screen: "412x960" });
  assert.equal(compareDevices(twin, { ...twin }).verdict, "same");
});

console.log("deviceMatch — the browser token");

// The reported session: three records, all "iPhone / iOS 18 / Safari 26".
// Indistinguishable by hardware; only a token can separate them.
const IDENTICAL = { parsed: { kind: "mobile", browser: "Safari 26", os: "iOS 18" }, screen: "440x956" };

t("identical iPhones: the token settles what the UA could not", () => {
  const a = { ...IDENTICAL, token: "aaa111" };
  const b = { ...IDENTICAL, token: "aaa111" };
  const r = compareDevices(a, b);
  assert.equal(r.verdict, "same");
  assert.match(r.reasons.join(" "), /same browser token/);
});

t("a matching token beats a hardware signal that disagrees", () => {
  // Same browser, but the self-reported screen differs (orientation, zoom).
  // The token is the stronger fact and should not be overruled by it.
  const r = compareDevices(
    { ...IDENTICAL, token: "t1" },
    { ...IDENTICAL, screen: "956x440", token: "t1" }
  );
  assert.equal(r.verdict, "same");
});

t("differing tokens CORROBORATE a hardware mismatch", () => {
  const r = compareDevices(
    { parsed: { browser: "Chrome 150", os: "Android 14", model: "SM-S918B" }, token: "t1" },
    { parsed: { browser: "Chrome 150", os: "Android 14", model: "SM-A146B" }, token: "t2" }
  );
  assert.equal(r.verdict, "different");
  assert.match(r.reasons.join(" "), /different browser token/);
});

t("differing tokens ALONE are NOT called a swap", () => {
  /* This is the false-positive that would destroy trust in the check: private
     browsing, cleared site data, or opening the QR in a second browser on the
     SAME phone all produce a fresh token with identical hardware. Unresolved,
     not condemned. */
  const r = compareDevices({ ...IDENTICAL, token: "t1" }, { ...IDENTICAL, token: "t2" });
  assert.equal(r.verdict, "unknown");
  assert.match(r.reasons.join(" "), /identical handsets|second browser|clearing site data/);
});

t("a differing token never makes the session a CONCERN on its own", () => {
  const r = checkSessionDevices({
    origin: { ...IDENTICAL, token: "t1" },
    reported: { ...IDENTICAL, token: "t2" },
  });
  assert.equal(r.concern, false);
});

t("a token on only one side falls back to the hardware comparison", () => {
  // Every record captured before tokens existed lands here.
  const r = compareDevices({ ...IDENTICAL, token: "t1" }, { ...IDENTICAL });
  assert.equal(r.verdict, "same"); // hardware agrees; no token claim made
  assert.ok(!r.reasons.join(" ").includes("token"));
});

t("empty-string tokens are not treated as a match", () => {
  // Two privacy-hardened browsers both yield "" — that is an absence, and
  // "absent === absent" must never read as "the same device".
  const r = compareDevices({ ...IDENTICAL, token: "" }, { ...IDENTICAL, token: "" });
  assert.ok(!r.reasons.join(" ").includes("same browser token"));
});

t("the camera device is proven separate when its token differs AND hardware does", () => {
  const r = checkSessionDevices({
    origin: { ...IDENTICAL, token: "phone-a" },
    reported: { ...IDENTICAL, token: "phone-a" },
    camera: { parsed: { browser: "Chrome 151", os: "Android 14" }, token: "phone-b" },
  });
  assert.equal(r.underTest.verdict, "same");
  assert.equal(r.cameraSeparate.verdict, "different");
  assert.match(r.summary, /photographed by a second device/);
});

console.log(pass + " assertions passed\n");
