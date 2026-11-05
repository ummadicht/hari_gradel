// Who a Keycloak token lets in. The realm is shared with SuperIQ, so the
// default for "no GradeIQ role" must be NO session — it used to be a tenant-less
// "client" that could read every tenant's sessions.

import assert from "node:assert/strict";
import { accessFromClaims } from "./oidcClaims.ts";

let pass = 0;
const t = (name, fn) => {
  try { fn(); console.log("  ok  ", name); pass++; }
  catch (e) { console.log("  FAIL", name, "\n       ", e.message); process.exitCode = 1; }
};
const tok = (roles, extra = {}) => ({ resource_access: roles === null ? undefined : { gradeiq: { roles } }, ...extra });

console.log("oidcClaims — access from a Keycloak token");

t("super → every client (giq_client ignored)", () => {
  assert.deepEqual(accessFromClaims(tok(["super"], { giq_client: "denovo" })), { role: "super", clientId: null });
});
t("client + known giq_client → that client", () => {
  assert.deepEqual(accessFromClaims(tok(["client"], { giq_client: "swapmore-in" })), { role: "client", clientId: "swapmore-in" });
});
t("giq_client is trimmed and lower-cased", () => {
  assert.deepEqual(accessFromClaims(tok(["client"], { giq_client: "  DeNovo " })), { role: "client", clientId: "denovo" });
});
t("a single-valued array attribute is accepted", () => {
  assert.deepEqual(accessFromClaims(tok(["client"], { giq_client: ["inzman"] })), { role: "client", clientId: "inzman" });
});
t("several giq_client values are ambiguous → refused", () => {
  assert.ok("denied" in accessFromClaims(tok(["client"], { giq_client: ["denovo", "inzman"] })));
});
t("no gradeiq role at all (a SuperIQ-only user) → refused", () => {
  const a = accessFromClaims({ resource_access: { "superiq-erp": { roles: ["operator"] } }, giq_client: "denovo" });
  assert.ok("denied" in a, JSON.stringify(a));
});
t("no resource_access → refused", () => {
  assert.ok("denied" in accessFromClaims(tok(null)));
});
t("client role without giq_client → refused (no tenant-less client)", () => {
  assert.ok("denied" in accessFromClaims(tok(["client"])));
});
t("client role with an unknown giq_client → refused", () => {
  assert.ok("denied" in accessFromClaims(tok(["client"], { giq_client: "evilcorp" })));
});
t("roles of ANOTHER client never count", () => {
  assert.ok("denied" in accessFromClaims({ resource_access: { "superiq-erp": { roles: ["super", "client"] } }, giq_client: "denovo" }));
});
t("the client id is configurable (OIDC_CLIENT_ID)", () => {
  assert.deepEqual(accessFromClaims({ resource_access: { other: { roles: ["super"] } } }, "other"), { role: "super", clientId: null });
});
t("non-string roles are ignored", () => {
  assert.ok("denied" in accessFromClaims({ resource_access: { gradeiq: { roles: [{ name: "super" }] } } }));
});

console.log(`\n${pass} passed`);
