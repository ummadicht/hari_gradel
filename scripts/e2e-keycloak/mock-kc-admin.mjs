#!/usr/bin/env node
// mock-kc-admin.mjs — the slice of Keycloak's ADMIN REST API that
// scripts/import-users-to-keycloak.mjs uses, for the SUP-84 e2e test
// (scripts/e2e-keycloak/run.sh, section I). NOT a security product.
//
// Mirrors: master-realm password grant for admin-cli; GET clients?clientId,
// client roles; users search by username/email (exact); POST /users with
// Keycloak's 409 on a taken username/email; GET/PUT /users/{id};
// reset-password; client role mappings. Seeds the realm's own `admin` user the
// way realm-novetta.json does (super, giq_client=denovo, another email), so the
// username collision with GradeIQ's built-in `admin` is exercised.
//
// Env: KCA_PORT (37814) KCA_REALM (novetta) KCA_ADMIN_USER / KCA_ADMIN_PASS
//   (throwaway, required) KCA_DROP_UNDECLARED=1 (behave like Keycloak 24+ with
//   giq_client NOT declared in the user profile: the attribute is silently
//   dropped) KCA_LOG (jsonl of every request: method, path, body keys — never
//   values of password fields).
// Test-only: GET /kca/state → users (without credentials) + counts.
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";

const PORT = Number(process.env.KCA_PORT || 37814);
const REALM = process.env.KCA_REALM || "novetta";
const AU = process.env.KCA_ADMIN_USER, AP = process.env.KCA_ADMIN_PASS;
if (!AU || !AP) { console.error("KCA_ADMIN_USER/KCA_ADMIN_PASS required"); process.exit(2); }
const DROP = !!process.env.KCA_DROP_UNDECLARED;
const LOG = process.env.KCA_LOG || "";
const tokens = new Set();
const clientUuid = crypto.randomUUID();
const roles = { super: { id: crypto.randomUUID(), name: "super" }, client: { id: crypto.randomUUID(), name: "client" } };
const users = new Map(); // id → {id, username, email, enabled, attributes, requiredActions, roles:Set, credentials:[]}
function addUser(u) {
  const id = crypto.randomUUID();
  users.set(id, { id, enabled: true, requiredActions: [], attributes: {}, roles: new Set(), credentials: [], ...u, createdTimestamp: Date.now() });
  return id;
}
// realm-novetta.json's seed admin
addUser({ username: "admin", email: "admin@novatech.example", attributes: { giq_client: ["denovo"], erp_tenant: ["tnt_denovo"] }, roles: new Set(["super"]), credentials: [{ type: "password", temporary: false }] });

const pub = (u) => ({ id: u.id, username: u.username, email: u.email, enabled: u.enabled, attributes: u.attributes, requiredActions: u.requiredActions, createdTimestamp: u.createdTimestamp });
function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body === undefined ? "" : JSON.stringify(body));
}
async function body(req) {
  const c = [];
  for await (const x of req) c.push(x);
  return Buffer.concat(c).toString("utf8");
}
function log(rec) { if (LOG) try { fs.appendFileSync(LOG, JSON.stringify(rec) + "\n"); } catch { /* ignore */ } }

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;
  const raw = await body(req);
  let json; try { json = raw ? JSON.parse(raw) : undefined; } catch { json = undefined; }
  log({ method: req.method, path: p, query: url.search, bodyKeys: json && typeof json === "object" && !Array.isArray(json) ? Object.keys(json) : Array.isArray(json) ? ["[array]"] : raw ? ["form"] : [] });

  if (p === "/realms/master/protocol/openid-connect/token" && req.method === "POST") {
    const f = new URLSearchParams(raw);
    if (f.get("grant_type") !== "password" || f.get("client_id") !== "admin-cli" || f.get("username") !== AU || f.get("password") !== AP)
      return send(res, 401, { error: "invalid_grant", error_description: "Invalid user credentials" });
    const t = crypto.randomBytes(24).toString("hex"); tokens.add(t);
    return send(res, 200, { access_token: t, expires_in: 60, token_type: "Bearer" });
  }
  if (p === "/kca/state") {
    return send(res, 200, { users: [...users.values()].map((u) => ({ ...pub(u), roles: [...u.roles], credentials: u.credentials.map((c) => ({ type: c.type, temporary: c.temporary })) })) });
  }
  const A = `/admin/realms/${REALM}`;
  if (!p.startsWith(A)) return send(res, 404, { error: "not found" });
  const auth = /^Bearer (.+)$/.exec(req.headers.authorization || "");
  if (!auth || !tokens.has(auth[1])) return send(res, 401, { error: "HTTP 401 Unauthorized" });
  const sub = p.slice(A.length);
  let m;

  if (sub === "/clients" && req.method === "GET")
    return send(res, 200, url.searchParams.get("clientId") === "gradeiq" ? [{ id: clientUuid, clientId: "gradeiq" }] : []);
  if (sub === `/clients/${clientUuid}/roles` && req.method === "GET") return send(res, 200, Object.values(roles));
  if (sub === "/users" && req.method === "GET") {
    const un = url.searchParams.get("username"), em = url.searchParams.get("email");
    const hit = [...users.values()].filter((u) => (un ? u.username === un.toLowerCase() : true) && (em ? u.email === em.toLowerCase() : true));
    return send(res, 200, hit.map(pub));
  }
  if (sub === "/users" && req.method === "POST") {
    const un = String(json?.username || "").toLowerCase(), em = String(json?.email || "").toLowerCase();
    if ([...users.values()].some((u) => u.username === un)) return send(res, 409, { errorMessage: "User exists with same username" });
    if (em && [...users.values()].some((u) => u.email === em)) return send(res, 409, { errorMessage: "User exists with same email" });
    const attributes = DROP ? {} : (json?.attributes || {});
    const id = addUser({ username: un, email: em, enabled: json?.enabled !== false, requiredActions: json?.requiredActions || [], attributes, credentials: [] });
    res.setHeader("location", `${A}/users/${id}`);
    return send(res, 201);
  }
  if ((m = /^\/users\/([^/]+)$/.exec(sub))) {
    const u = users.get(m[1]);
    if (!u) return send(res, 404, { error: "User not found" });
    if (req.method === "GET") return send(res, 200, pub(u));
    if (req.method === "PUT") {
      if (json?.attributes && !DROP) u.attributes = json.attributes;
      if (json?.email) u.email = String(json.email).toLowerCase();
      return send(res, 204);
    }
  }
  if ((m = /^\/users\/([^/]+)\/reset-password$/.exec(sub)) && req.method === "PUT") {
    const u = users.get(m[1]);
    if (!u) return send(res, 404, { error: "User not found" });
    if (json?.type !== "password" || !json?.value) return send(res, 400, { error: "invalid" });
    u.credentials = [{ type: "password", temporary: !!json.temporary }];
    return send(res, 204);
  }
  if ((m = /^\/users\/([^/]+)\/role-mappings\/clients\/([^/]+)$/.exec(sub))) {
    const u = users.get(m[1]);
    if (!u || m[2] !== clientUuid) return send(res, 404, { error: "not found" });
    if (req.method === "GET") return send(res, 200, [...u.roles].map((r) => roles[r]));
    if (req.method === "POST") {
      for (const r of json || []) if (roles[r.name]?.id === r.id) u.roles.add(r.name); else return send(res, 404, { error: "Role not found" });
      return send(res, 204);
    }
  }
  return send(res, 404, { error: "not found", path: sub });
}).listen(PORT, "127.0.0.1", () => console.log(`mock-kc-admin listening :${PORT} realm ${REALM}${DROP ? " (drops undeclared attributes)" : ""}`));
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => process.exit(0));
