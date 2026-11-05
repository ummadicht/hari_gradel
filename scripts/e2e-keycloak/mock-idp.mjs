#!/usr/bin/env node
// mock-idp.mjs — a tiny Keycloak-shaped OIDC provider for the SUP-84 GradeIQ
// end-to-end test (scripts/e2e-keycloak/run.sh). NOT a security product: it exists so GradeIQ's Keycloak code
// can be exercised end to end on a Mac with no Docker and no real Keycloak.
//
// What it mirrors from Keycloak (realm read from realm-fixture.json — the
// secret-free client projection of realm-novetta.json — or MOCK_REALM_FILE):
//   - discovery, JWKS (RS256), authorization-code + PKCE (S256 enforced when the
//     client has pkce.code.challenge.method), refresh_token, client_credentials,
//     userinfo, RP-initiated logout (post_logout_redirect_uri validated against
//     the client's post.logout.redirect.uris), error shapes/status codes.
//   - token claims: iss, aud (audience-resolve: every OTHER client with roles in
//     resource_access, plus oidc-audience-mapper audiences on the client), azp,
//     sub, typ, sid, nonce (ID token), at_hash, preferred_username, email,
//     resource_access.<client>.roles, realm_access, and user-attribute mappers
//     (giq_client / erp_tenant) per their access/id/userinfo flags.
//   - service accounts: preferred_username service-account-<client>, client_id,
//     aud = [mapper audiences..., "account"].
//
// The user is chosen per authorization request with ?login_hint=… (or the
// MOCK_DEFAULT_USER env). With neither, the authorize URL answers 200 with a
// login form and signs nobody in — like Keycloak:
//   super            gradeiq:super (+ superiq-erp:super_admin), giq_client=denovo (as the realm's seed admin)
//   client:<id>      gradeiq:client, giq_client=<id>
//   client           gradeiq:client, NO giq_client attribute
//   norole           no gradeiq role at all (a SuperIQ-only operator)
//   norole:<id>      no gradeiq role, but carries giq_client=<id>
//   deny             the user cancels at the IdP → error=access_denied
//
// Env:
//   MOCK_PORT (37812) MOCK_HOST (127.0.0.1) MOCK_REALM_FILE (./realm-fixture.json)
//   MOCK_CLIENT_SECRETS  JSON {clientId: secret} — throwaway values only. The
//                        realm file's own secrets are NEVER used.
//   MOCK_EXTRA_REDIRECTS comma list of extra redirect URIs/patterns (std-flow clients)
//   MOCK_EXTRA_POST_LOGOUT comma list of extra post-logout URIs/patterns
//   MOCK_DEFAULT_USER (none)  MOCK_EVENTS_FILE (jsonl event log)
//   MOCK_HANG=1           accept connections and never answer (timeout tests)
//   MOCK_ISSUER_OVERRIDE  advertise a different "issuer" in discovery (tests the
//                         issuer-mismatch check)
//
// Test-only helpers (not Keycloak): GET /mock/health, GET /mock/events,
//   POST /mock/forge {claims, signer:"realm"|"rogue"} → {token}.
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import * as jose from "jose"; // GradeIQ's own dependency (node_modules of this checkout)

const PORT = Number(process.env.MOCK_PORT || 37812);
const HOST = process.env.MOCK_HOST || "127.0.0.1";
const REALM_FILE = process.env.MOCK_REALM_FILE || new URL("./realm-fixture.json", import.meta.url).pathname;
const realm = JSON.parse(fs.readFileSync(REALM_FILE, "utf8"));
const REALM = realm.realm;
const ORIGIN = process.env.MOCK_PUBLIC_ORIGIN || `http://${HOST}:${PORT}`;
const ISSUER = `${ORIGIN}/realms/${REALM}`;
const OIDC = `/realms/${REALM}/protocol/openid-connect`;
const ACCESS_TTL = Number(realm.accessTokenLifespan || 300);
const SSO_IDLE = Number(realm.ssoSessionIdleTimeout || 1800);
const SECRETS = JSON.parse(process.env.MOCK_CLIENT_SECRETS || "{}");
const list = (v) => String(v || "").split(",").map((s) => s.trim()).filter(Boolean);
const EXTRA_REDIRECTS = list(process.env.MOCK_EXTRA_REDIRECTS);
const EXTRA_POST_LOGOUT = list(process.env.MOCK_EXTRA_POST_LOGOUT);
const DEFAULT_USER = process.env.MOCK_DEFAULT_USER || "";
const EVENTS_FILE = process.env.MOCK_EVENTS_FILE || "";

// ── keys ────────────────────────────────────────────────────────────────────
async function makeKey(kid) {
  const { publicKey, privateKey } = await jose.generateKeyPair("RS256", { extractable: true });
  const jwk = { ...(await jose.exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };
  return { kid, publicKey, privateKey, jwk };
}
const KEY = await makeKey(crypto.randomBytes(16).toString("base64url"));
const ROGUE = await makeKey(KEY.kid); // same kid, different key: a forgery
const sign = (payload, key = KEY) =>
  new jose.SignJWT(payload).setProtectedHeader({ alg: "RS256", typ: "JWT", kid: key.kid }).sign(key.privateKey);
async function verifyOwn(token, opts = {}) {
  return (await jose.jwtVerify(token, KEY.publicKey, { issuer: ISSUER, ...opts })).payload;
}

// ── realm → clients ─────────────────────────────────────────────────────────
const clients = new Map();
for (const c of realm.clients || []) {
  const attrs = c.attributes || {};
  const redirectUris = [...(c.redirectUris || []), ...(c.standardFlowEnabled !== false ? EXTRA_REDIRECTS : [])];
  const pl = String(attrs["post.logout.redirect.uris"] || "").split("##").filter(Boolean);
  const postLogout = [...pl.flatMap((u) => (u === "+" ? redirectUris : [u])), ...EXTRA_POST_LOGOUT];
  const mappers = c.protocolMappers || [];
  clients.set(c.clientId, {
    clientId: c.clientId,
    confidential: !c.publicClient,
    standardFlow: c.standardFlowEnabled !== false && !c.bearerOnly,
    serviceAccounts: !!c.serviceAccountsEnabled,
    fullScope: c.fullScopeAllowed !== false,
    pkce: attrs["pkce.code.challenge.method"] || null,
    redirectUris,
    postLogout,
    audiences: mappers
      .filter((m) => m.protocolMapper === "oidc-audience-mapper" && m.config?.["access.token.claim"] === "true")
      .map((m) => m.config["included.client.audience"]),
    attrMappers: mappers
      .filter((m) => m.protocolMapper === "oidc-usermodel-attribute-mapper")
      .map((m) => ({
        attr: m.config["user.attribute"],
        claim: m.config["claim.name"],
        access: m.config["access.token.claim"] === "true",
        id: m.config["id.token.claim"] === "true",
        userinfo: m.config["userinfo.token.claim"] === "true",
      })),
    saSub: crypto.randomUUID(),
  });
}
// Attribute mappers are applied per REQUESTING client, as in Keycloak.

// Redirect matching the way Keycloak does it: exact, or a trailing-* prefix.
const matchUri = (uri, patterns) =>
  patterns.some((p) => (p.endsWith("*") ? uri.startsWith(p.slice(0, -1)) : uri === p));

// ── users ───────────────────────────────────────────────────────────────────
const subs = new Map();
const subFor = (u) => {
  if (!subs.has(u)) subs.set(u, crypto.randomUUID());
  return subs.get(u);
};
function userFor(hint) {
  const h = String(hint || DEFAULT_USER).trim();
  const [kind, attr] = h.split(":");
  const roles = {};
  const attrs = {};
  let username;
  if (kind === "super") {
    username = "admin";
    roles.gradeiq = ["super"];
    roles["superiq-erp"] = ["super_admin"];
    attrs.giq_client = attr === undefined ? "denovo" : attr || undefined;
    attrs.erp_tenant = "tnt_denovo";
  } else if (kind === "client") {
    username = attr ? `${attr}-admin` : "client-noattr";
    roles.gradeiq = ["client"];
    if (attr) attrs.giq_client = attr;
  } else if (kind === "norole") {
    username = attr ? `norole-${attr}` : "erp-operator";
    roles["superiq-erp"] = ["operator"];
    attrs.erp_tenant = "tnt_denovo";
    if (attr) attrs.giq_client = attr;
  } else if (kind === "deny") {
    return null;
  } else {
    throw new Error(`unknown login_hint ${h}`);
  }
  for (const k of Object.keys(attrs)) if (attrs[k] === undefined) delete attrs[k];
  return {
    hint: h, username, sub: subFor(h), email: `${username}@gradeiq.local`,
    given: username, roles, attrs,
  };
}

// ── state ───────────────────────────────────────────────────────────────────
const codes = new Map(); // code → {...}
const sso = new Map(); // sid → {user, authTime, active, lastSeen}
const refreshTokens = new Map(); // jti → {sid, clientId, scope, used}
const events = [];
function event(e) {
  const rec = { t: new Date().toISOString(), ...e };
  events.push(rec);
  if (events.length > 500) events.shift();
  if (EVENTS_FILE) try { fs.appendFileSync(EVENTS_FILE, JSON.stringify(rec) + "\n"); } catch { /* ignore */ }
}
const now = () => Math.floor(Date.now() / 1000);
const b64url = (b) => Buffer.from(b).toString("base64url");
const atHash = (tok) => b64url(crypto.createHash("sha256").update(tok).digest().subarray(0, 16));

// ── token builders ──────────────────────────────────────────────────────────
const ACCOUNT_ROLES = ["manage-account", "manage-account-links", "view-profile"];
const REALM_ROLES = [`default-roles-${REALM}`, "offline_access", "uma_authorization"];

function profile(user) {
  return {
    email_verified: false, name: user.given, preferred_username: user.username,
    given_name: user.given, email: user.email,
  };
}
function applyMappers(claims, client, user, where) {
  for (const m of client.attrMappers) if (m[where] && user.attrs[m.attr] !== undefined) claims[m.claim] = user.attrs[m.attr];
}
function humanAccess(user, client, s, scope) {
  const t = now();
  const resource_access = { account: { roles: ACCOUNT_ROLES } };
  for (const [c, rs] of Object.entries(user.roles)) {
    if (client.fullScope || c === client.clientId) resource_access[c] = { roles: rs };
  }
  // Keycloak's "audience resolve": every client whose roles are in the token,
  // except the requesting client itself, plus explicit audience mappers.
  const aud = [...new Set([...Object.keys(resource_access).filter((c) => c !== client.clientId), ...client.audiences])];
  const claims = {
    exp: t + ACCESS_TTL, iat: t, auth_time: s.authTime, jti: crypto.randomUUID(), iss: ISSUER,
    aud: aud.length === 1 ? aud[0] : aud, sub: user.sub, typ: "Bearer", azp: client.clientId,
    sid: s.sid, acr: "1", "allowed-origins": ["/*"], realm_access: { roles: REALM_ROLES },
    resource_access, scope, ...profile(user),
  };
  applyMappers(claims, client, user, "access");
  return claims;
}
function humanId(user, client, s, nonce, accessToken) {
  const t = now();
  const claims = {
    exp: t + ACCESS_TTL, iat: t, auth_time: s.authTime, jti: crypto.randomUUID(), iss: ISSUER,
    aud: client.clientId, sub: user.sub, typ: "ID", azp: client.clientId, sid: s.sid,
    at_hash: atHash(accessToken), acr: "1", ...profile(user),
  };
  if (nonce) claims.nonce = nonce;
  applyMappers(claims, client, user, "id");
  return claims;
}
function serviceAccess(client, remote) {
  const t = now();
  const aud = [...new Set([...client.audiences, "account"])];
  return {
    exp: t + ACCESS_TTL, iat: t, jti: crypto.randomUUID(), iss: ISSUER,
    aud: aud.length === 1 ? aud[0] : aud, sub: client.saSub, typ: "Bearer", azp: client.clientId,
    acr: "1", "allowed-origins": ["/*"], realm_access: { roles: REALM_ROLES },
    resource_access: { account: { roles: ACCOUNT_ROLES } }, scope: "email profile",
    clientHost: remote, email_verified: false, preferred_username: `service-account-${client.clientId}`,
    clientAddress: remote, client_id: client.clientId,
  };
}
async function issueHuman(user, client, s, nonce, scope) {
  const access_token = await sign(humanAccess(user, client, s, scope));
  const id_token = await sign(humanId(user, client, s, nonce, access_token));
  const rjti = crypto.randomUUID();
  refreshTokens.set(rjti, { sid: s.sid, clientId: client.clientId, scope, nonce, used: false });
  const t = now();
  const refresh_token = await sign({
    exp: t + SSO_IDLE, iat: t, jti: rjti, iss: ISSUER, aud: ISSUER, sub: user.sub, typ: "Refresh",
    azp: client.clientId, sid: s.sid, scope,
  });
  return {
    access_token, expires_in: ACCESS_TTL, refresh_expires_in: SSO_IDLE, refresh_token,
    token_type: "Bearer", id_token, "not-before-policy": 0, session_state: s.sid, scope,
  };
}

// ── http helpers ────────────────────────────────────────────────────────────
function send(res, status, body, headers = {}) {
  const isJson = typeof body !== "string";
  res.writeHead(status, {
    "content-type": isJson ? "application/json" : "text/html; charset=utf-8",
    "cache-control": "no-store", ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}
const redirect = (res, loc) => send(res, 302, "", { location: loc });
const oauthErr = (res, status, error, error_description) => send(res, status, { error, error_description });
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}
function clientAuth(req, form) {
  let id = form.get("client_id");
  let secret = form.get("client_secret");
  const h = req.headers.authorization || "";
  if (/^Basic\s+/i.test(h)) {
    const [u, p] = Buffer.from(h.replace(/^Basic\s+/i, ""), "base64").toString().split(":");
    id = decodeURIComponent(u || "");
    secret = decodeURIComponent(p || "");
  }
  const c = id ? clients.get(id) : null;
  if (!c) return { err: [401, "invalid_client", "Invalid client or Invalid client credentials"] };
  if (c.confidential) {
    const want = SECRETS[c.clientId];
    if (!secret) return { err: [401, "unauthorized_client", "Client secret not provided in request"] };
    if (!want || secret.length !== want.length || !crypto.timingSafeEqual(Buffer.from(secret), Buffer.from(want)))
      return { err: [401, "unauthorized_client", "Invalid client or Invalid client credentials"] };
  }
  return { client: c };
}
const errPage = (msg) => `<!doctype html><title>Keycloak (mock)</title><h1>We are sorry...</h1><p id="kc-error-message">${msg}</p>`;

// ── endpoints ───────────────────────────────────────────────────────────────
function discoveryDoc() {
  return {
    issuer: process.env.MOCK_ISSUER_OVERRIDE || ISSUER,
    authorization_endpoint: `${ORIGIN}${OIDC}/auth`,
    token_endpoint: `${ORIGIN}${OIDC}/token`,
    introspection_endpoint: `${ORIGIN}${OIDC}/token/introspect`,
    userinfo_endpoint: `${ORIGIN}${OIDC}/userinfo`,
    end_session_endpoint: `${ORIGIN}${OIDC}/logout`,
    jwks_uri: `${ORIGIN}${OIDC}/certs`,
    grant_types_supported: ["authorization_code", "implicit", "refresh_token", "password", "client_credentials"],
    response_types_supported: ["code", "none", "id_token", "token", "id_token token", "code id_token", "code token", "code id_token token"],
    subject_types_supported: ["public", "pairwise"],
    id_token_signing_alg_values_supported: ["RS256"],
    code_challenge_methods_supported: ["plain", "S256"],
    token_endpoint_auth_methods_supported: ["private_key_jwt", "client_secret_basic", "client_secret_post", "client_secret_jwt"],
    scopes_supported: ["openid", "email", "profile", "roles", "web-origins", "offline_access"],
    authorization_response_iss_parameter_supported: true,
    frontchannel_logout_session_supported: true,
  };
}

function handleAuth(res, q) {
  const client = clients.get(q.get("client_id") || "");
  if (!client) return send(res, 400, errPage("Client not found."));
  const redirectUri = q.get("redirect_uri") || "";
  if (!client.standardFlow || !matchUri(redirectUri, client.redirectUris)) {
    event({ type: "auth_rejected", reason: "invalid_redirect_uri", client: client.clientId, redirectUri });
    return send(res, 400, errPage("Invalid parameter: redirect_uri"));
  }
  const back = (params) => {
    const u = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
    u.searchParams.set("iss", ISSUER);
    return redirect(res, u.toString());
  };
  const state = q.get("state") || undefined;
  if (q.get("response_type") !== "code")
    return back({ error: "unsupported_response_type", error_description: "Client is not allowed to initiate browser login with given response_type.", state });
  const challenge = q.get("code_challenge");
  const method = q.get("code_challenge_method") || (challenge ? "plain" : null);
  if (client.pkce) {
    if (!method) return back({ error: "invalid_request", error_description: "Missing parameter: code_challenge_method", state });
    if (method !== client.pkce) return back({ error: "invalid_request", error_description: "Invalid parameter: code challenge method is not matching the configured one", state });
    if (!challenge) return back({ error: "invalid_request", error_description: "Missing parameter: code_challenge", state });
  }
  const scope = q.get("scope") || "";
  if (!scope.split(" ").includes("openid"))
    event({ type: "auth_warning", reason: "no openid scope", client: client.clientId });
  // No login_hint (and no MOCK_DEFAULT_USER): show the login form, as Keycloak
  // does — nobody is signed in by merely opening the authorize URL.
  if (!q.get("login_hint") && !DEFAULT_USER) {
    event({ type: "login_page", client: client.clientId });
    return send(res, 200, `<!doctype html><title>Sign in to ${REALM}</title><form id="kc-form-login"><input name="username"><input name="password" type="password"></form>`);
  }
  let user;
  try { user = userFor(q.get("login_hint")); } catch (e) { return send(res, 400, errPage(String(e.message))); }
  if (!user) {
    event({ type: "auth_denied", client: client.clientId });
    return back({ error: "access_denied", error_description: "User cancelled", state });
  }
  const sid = crypto.randomUUID();
  sso.set(sid, { sid, user, authTime: now(), active: true });
  const code = `${crypto.randomUUID()}.${sid}.${crypto.randomUUID()}`;
  codes.set(code, {
    client: client.clientId, redirectUri, challenge, method, nonce: q.get("nonce") || null,
    scope: ["openid", "email", "profile"].filter((s) => scope.split(" ").includes(s)).join(" ") || "openid",
    sid, exp: now() + 60, used: false,
  });
  event({ type: "auth_ok", client: client.clientId, user: user.hint, sid, pkce: method });
  return back({ state, session_state: sid, code });
}

async function handleToken(req, res) {
  const form = new URLSearchParams(await readBody(req));
  const auth = clientAuth(req, form);
  const grant = form.get("grant_type");
  if (auth.err) {
    event({ type: "token_rejected", grant, reason: auth.err[1], client: form.get("client_id") });
    return oauthErr(res, ...auth.err);
  }
  const client = auth.client;
  const remote = req.socket.remoteAddress || "127.0.0.1";

  if (grant === "authorization_code") {
    const code = form.get("code") || "";
    const c = codes.get(code);
    if (!c || c.used || c.exp < now() || c.client !== client.clientId) {
      if (c) c.used = true;
      event({ type: "token_rejected", grant, reason: "code_invalid", client: client.clientId });
      return oauthErr(res, 400, "invalid_grant", "Code not valid");
    }
    c.used = true; // one-shot, even on failure below
    if ((form.get("redirect_uri") || "") !== c.redirectUri) {
      event({ type: "token_rejected", grant, reason: "redirect_mismatch", client: client.clientId });
      return oauthErr(res, 400, "invalid_grant", "Incorrect redirect_uri");
    }
    if (c.challenge) {
      const v = form.get("code_verifier");
      if (!v) return oauthErr(res, 400, "invalid_grant", "PKCE code verifier not specified");
      const derived = c.method === "S256" ? b64url(crypto.createHash("sha256").update(v).digest()) : v;
      if (derived !== c.challenge) {
        event({ type: "token_rejected", grant, reason: "pkce_mismatch", client: client.clientId });
        return oauthErr(res, 400, "invalid_grant", "PKCE verification failed: Code mismatch");
      }
    }
    const s = sso.get(c.sid);
    if (!s?.active) return oauthErr(res, 400, "invalid_grant", "Session not active");
    const out = await issueHuman(s.user, client, s, c.nonce, c.scope);
    event({ type: "token_ok", grant, client: client.clientId, user: s.user.hint, sid: s.sid });
    return send(res, 200, out);
  }

  if (grant === "refresh_token") {
    let p;
    try { p = await verifyOwn(form.get("refresh_token") || "", { audience: ISSUER }); } catch {
      return oauthErr(res, 400, "invalid_grant", "Invalid refresh token");
    }
    const r = refreshTokens.get(p.jti);
    const s = r && sso.get(r.sid);
    if (!r || r.clientId !== client.clientId) return oauthErr(res, 400, "invalid_grant", "Invalid refresh token");
    if (r.used && realm.revokeRefreshToken) return oauthErr(res, 400, "invalid_grant", "Maximum allowed refresh token reuse exceeded");
    if (!s?.active) return oauthErr(res, 400, "invalid_grant", "Session not active");
    r.used = true;
    const out = await issueHuman(s.user, client, s, r.nonce, r.scope);
    event({ type: "token_ok", grant, client: client.clientId, sid: s.sid });
    return send(res, 200, out);
  }

  if (grant === "client_credentials") {
    if (!client.serviceAccounts) {
      event({ type: "token_rejected", grant, reason: "no_service_account", client: client.clientId });
      return oauthErr(res, 401, "unauthorized_client", "Client not enabled to retrieve service account");
    }
    const access_token = await sign(serviceAccess(client, remote));
    event({ type: "token_ok", grant, client: client.clientId });
    return send(res, 200, {
      access_token, expires_in: ACCESS_TTL, refresh_expires_in: 0, token_type: "Bearer",
      "not-before-policy": 0, scope: "email profile",
    });
  }
  return oauthErr(res, 400, "unsupported_grant_type", "Unsupported grant_type");
}

async function handleUserinfo(req, res) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "");
  const fail = () => send(res, 401, { error: "invalid_token", error_description: "Token verification failed" },
    { "www-authenticate": 'Bearer realm="' + REALM + '", error="invalid_token"' });
  if (!m) return fail();
  let p;
  try { p = await verifyOwn(m[1]); } catch { return fail(); }
  const s = p.sid && sso.get(p.sid);
  if (!s?.active) return fail();
  const client = clients.get(p.azp);
  const out = { sub: s.user.sub, ...profile(s.user) };
  if (client) applyMappers(out, client, s.user, "userinfo");
  return send(res, 200, out);
}

async function handleLogout(req, res, q) {
  if (req.method === "POST") for (const [k, v] of new URLSearchParams(await readBody(req))) q.set(k, v);
  const hint = q.get("id_token_hint");
  const plr = q.get("post_logout_redirect_uri");
  let client = q.get("client_id") ? clients.get(q.get("client_id")) : null;
  let sid = null;
  if (hint) {
    try {
      // Keycloak accepts an expired id_token_hint, but not a forged one.
      const p = (await jose.jwtVerify(hint, KEY.publicKey, { issuer: ISSUER, clockTolerance: 1e9 })).payload;
      sid = p.sid || null;
      const hc = clients.get(String(p.azp || p.aud));
      if (client && hc && client.clientId !== hc.clientId) return send(res, 400, errPage("Invalid parameter: id_token_hint"));
      client = client || hc;
    } catch {
      event({ type: "logout_rejected", reason: "bad_id_token_hint" });
      return send(res, 400, errPage("Invalid parameter: id_token_hint"));
    }
  }
  if (plr && !client) {
    event({ type: "logout_rejected", reason: "missing_client_or_hint", plr });
    return send(res, 400, errPage("Missing parameters: id_token_hint"));
  }
  if (plr && !matchUri(plr, client.postLogout)) {
    event({ type: "logout_rejected", reason: "invalid_post_logout_redirect_uri", plr, client: client.clientId });
    return send(res, 400, errPage("Invalid redirect uri"));
  }
  if (!hint) {
    event({ type: "logout_confirm_page", client: client?.clientId, plr });
    return send(res, 200, errPage("Do you want to log out? (confirmation page — no id_token_hint was sent)"));
  }
  if (sid && sso.get(sid)) sso.get(sid).active = false;
  event({ type: "logout_ok", sid, client: client?.clientId, plr });
  if (!plr) return send(res, 200, errPage("You are logged out"));
  const u = new URL(plr);
  if (q.get("state")) u.searchParams.set("state", q.get("state"));
  return redirect(res, u.toString());
}

const HANG = !!process.env.MOCK_HANG; // accept connections, never answer (a hung IdP)
const server = http.createServer(async (req, res) => {
  if (HANG) return;
  const url = new URL(req.url || "/", ORIGIN);
  const p = url.pathname;
  try {
    if (p === `/realms/${REALM}/.well-known/openid-configuration`) return send(res, 200, discoveryDoc());
    if (p === `${OIDC}/certs`) return send(res, 200, { keys: [KEY.jwk] });
    if (p === `${OIDC}/auth` && req.method === "GET") return handleAuth(res, url.searchParams);
    if (p === `${OIDC}/token` && req.method === "POST") return await handleToken(req, res);
    if (p === `${OIDC}/userinfo`) return await handleUserinfo(req, res);
    if (p === `${OIDC}/logout`) return await handleLogout(req, res, url.searchParams);
    if (p === `/realms/${REALM}`) return send(res, 200, { realm: REALM, "token-service": `${ORIGIN}${OIDC}` });
    // test-only helpers
    if (p === "/mock/health") return send(res, 200, { ok: true, issuer: ISSUER, clients: [...clients.keys()] });
    if (p === "/mock/events") return send(res, 200, events);
    if (p === "/mock/forge" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const t = now();
      const claims = { iat: t, exp: t + ACCESS_TTL, jti: crypto.randomUUID(), iss: ISSUER, ...(body.claims || {}) };
      return send(res, 200, { token: await sign(claims, body.signer === "rogue" ? ROGUE : KEY) });
    }
    return send(res, 404, { error: "not_found", path: p });
  } catch (e) {
    console.error("mock-idp error", e);
    return send(res, 500, { error: "server_error", error_description: String(e?.message || e) });
  }
});
server.listen(PORT, HOST, () => console.log(`mock-idp listening ${ISSUER} (kid ${KEY.kid}) clients=${[...clients.keys()].join(",")}${HANG ? " HANG" : ""}`));
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { server.close(); process.exit(0); });
