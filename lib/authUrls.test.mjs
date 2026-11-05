// The public origin for sign-in redirects, and the returnTo guard. Behind Caddy
// the request URL is the internal https://localhost:3700 — a redirect built from
// it sent a successful Keycloak login to localhost.

import assert from "node:assert/strict";
import { publicOrigin, safeReturnTo } from "./authUrls.ts";

let pass = 0;
const t = (name, fn) => {
  try { fn(); console.log("  ok  ", name); pass++; }
  catch (e) { console.log("  FAIL", name, "\n       ", e.message); process.exitCode = 1; }
};
const req = (url, headers = {}) => new Request(url, { headers });
const INTERNAL = "https://localhost:3700/apps/gradeiq/auth/callback?code=x";

console.log("authUrls — public origin + returnTo");

delete process.env.PUBLIC_ORIGIN;
t("Caddy's forwarded host + proto win over the internal URL", () => {
  assert.equal(publicOrigin(req(INTERNAL, { host: "localhost:3700", "x-forwarded-host": "swapmore.com", "x-forwarded-proto": "https" })), "https://swapmore.com");
});
t("Host header + forwarded proto (what Caddy sends) → the public origin", () => {
  assert.equal(publicOrigin(req(INTERNAL, { host: "swapmore.com", "x-forwarded-proto": "https" })), "https://swapmore.com");
});
t("first value of a comma list is used", () => {
  assert.equal(publicOrigin(req(INTERNAL, { "x-forwarded-host": "swapmore.com, internal", "x-forwarded-proto": "https, http" })), "https://swapmore.com");
});
t("no forwarded headers → the request's own scheme + Host", () => {
  assert.equal(publicOrigin(req("http://127.0.0.1:37811/x", { host: "127.0.0.1:37811" })), "http://127.0.0.1:37811");
});
t("a junk host header falls back to the request origin", () => {
  assert.equal(publicOrigin(req("http://127.0.0.1:1/x", { "x-forwarded-host": "evil.example/@x", "x-forwarded-proto": "https" })), "http://127.0.0.1:1");
});
t("a junk proto falls back to the request origin", () => {
  assert.equal(publicOrigin(req("http://127.0.0.1:1/x", { "x-forwarded-host": "swapmore.com", "x-forwarded-proto": "javascript" })), "http://127.0.0.1:1");
});
t("PUBLIC_ORIGIN pins it", () => {
  process.env.PUBLIC_ORIGIN = "https://swapmore.com/";
  try {
    assert.equal(publicOrigin(req(INTERNAL, { "x-forwarded-host": "other.example", "x-forwarded-proto": "https" })), "https://swapmore.com");
  } finally { delete process.env.PUBLIC_ORIGIN; }
});

t("returnTo: a same-app path passes", () => assert.equal(safeReturnTo("/console/denovo?x=1"), "/console/denovo?x=1"));
t("returnTo: //host is refused", () => assert.equal(safeReturnTo("//evil.example/x"), "/superadmin"));
t("returnTo: /\\host is refused", () => assert.equal(safeReturnTo("/\\evil.example"), "/superadmin"));
t("returnTo: absolute URLs are refused", () => assert.equal(safeReturnTo("https://evil.example/"), "/superadmin"));
t("returnTo: empty → fallback", () => assert.equal(safeReturnTo(null, "/x"), "/x"));

console.log(`\n${pass} passed`);
