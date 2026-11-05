// The device token's LIFETIME.
//
// The token answers one question inside one inspection. Its danger is not that
// it fails — it is that it succeeds too well and becomes a durable identifier
// every consumer's phone carries between visits. These tests pin the expiry,
// because that is the only thing standing between a fraud check and a tracking
// cookie.

import assert from "node:assert/strict";
import { reuseFromStore, TOKEN_TTL_MS } from "./deviceToken.ts";

let pass = 0;
const t = (name, fn) => {
  try { fn(); console.log("  ok  ", name); pass++; }
  catch (e) { console.log("  FAIL", name, "\n       ", e.message); process.exitCode = 1; }
};

const NOW = 1_800_000_000_000;
const rec = (tok, exp) => JSON.stringify({ t: tok, exp });

console.log("deviceToken — lifetime");

t("the window is 12 hours, not a year", () => {
  assert.equal(TOKEN_TTL_MS, 12 * 60 * 60 * 1000);
});

t("a live token is reused, with its ORIGINAL deadline", () => {
  const exp = NOW + 60_000;
  const got = reuseFromStore(rec("abc", exp), NOW);
  assert.equal(got.token, "abc");
  // Carried through untouched — a sliding window would make it immortal.
  assert.equal(got.exp, exp);
});

t("an expired token is NOT reused", () => {
  assert.equal(reuseFromStore(rec("abc", NOW - 1), NOW), null);
});

t("expiry is exclusive at the boundary", () => {
  assert.equal(reuseFromStore(rec("abc", NOW), NOW), null);
  assert.ok(reuseFromStore(rec("abc", NOW + 1), NOW));
});

t("reuse never EXTENDS the deadline — the key privacy property", () => {
  /* Simulate a phone used every hour for a day. If the deadline moved on each
     visit the token would never rotate, which is the tracking cookie this TTL
     exists to prevent. */
  const minted = NOW;
  const exp = minted + TOKEN_TTL_MS;
  let stored = rec("abc", exp);
  for (let h = 1; h <= 11; h++) {
    const got = reuseFromStore(stored, minted + h * 3600_000);
    assert.ok(got, `should still be live at +${h}h`);
    assert.equal(got.exp, exp, `deadline moved at +${h}h`);
    stored = rec(got.token, got.exp); // what ensureDeviceToken writes back
  }
  // …and it is gone once the original window closes, despite constant use.
  assert.equal(reuseFromStore(stored, minted + TOKEN_TTL_MS + 1), null);
});

console.log("deviceToken — hostile / legacy storage");

t("legacy unbounded plain-string tokens are dropped, not migrated", () => {
  // These were written with a one-year cookie and no expiry at all.
  assert.equal(reuseFromStore("47b239f2b96f739085f007d3a15545a3", NOW), null);
});

t("missing, empty and malformed storage yield nothing", () => {
  for (const v of [null, "", "{", "{}", '{"t":""}', '{"t":"a"}', '{"exp":123}']) {
    assert.equal(reuseFromStore(v, NOW), null, JSON.stringify(v));
  }
});

t("a non-numeric expiry is not trusted", () => {
  assert.equal(reuseFromStore('{"t":"a","exp":"9999999999999"}', NOW), null);
  assert.equal(reuseFromStore('{"t":"a","exp":null}', NOW), null);
});

t("NaN/Infinity cannot buy an immortal token", () => {
  assert.equal(reuseFromStore('{"t":"a","exp":1e999}', NOW), null); // JSON → Infinity
});

console.log(pass + " assertions passed\n");
