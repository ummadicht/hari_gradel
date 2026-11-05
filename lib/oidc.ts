import crypto from "crypto";
import { cookies } from "next/headers";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { insertSession, newSid, markOidcCutover, revokeCurrentSession, SESSION_COOKIE, SESSION_TTL_S } from "./oidc-session";
import { accessFromClaims } from "./oidcClaims";
import { effectiveAuthMode } from "./auth-mode";
import { safeReturnTo } from "./authUrls";

// Keycloak OIDC for GradeIQ — one human login for the portal + enterprise console
// (auth-code + PKCE). Role = resource_access.gradeiq.roles (super|client); client
// scope = the giq_client claim (lib/oidcClaims.ts). Replaces entAuth + portalAuth
// cookie schemes when GIQ_AUTH_MODE=oidc.

const TX_COOKIE = "giq_oidc_tx";
const ISSUER = (process.env.KEYCLOAK_ISSUER || "").replace(/\/$/, "");
const CLIENT_ID = process.env.OIDC_CLIENT_ID || "gradeiq";
const CLIENT_SECRET = process.env.OIDC_CLIENT_SECRET || "";
const REDIRECT_URI = process.env.OIDC_REDIRECT_URI || "";

/**
 * Every call to Keycloak gives up after this long. Discovery used to have no
 * timeout at all: with the IdP unreachable, /auth/login hung for ~11 s before
 * failing, on every click.
 */
const IDP_TIMEOUT_MS = 4000;
/** After a failed discovery, fail fast for this long instead of re-waiting. */
const IDP_RETRY_AFTER_MS = 15_000;

/**
 * A sign-in that cannot work, and why. `code` is what /login explains to staff;
 * the message (never a secret) goes to the server log.
 *   idp_unavailable    Keycloak didn't answer (down, network, 5xx, timeout)
 *   sso_misconfigured  Keycloak answered, but this server's settings don't match it
 */
export class IdpError extends Error {
  code: "idp_unavailable" | "sso_misconfigured";
  constructor(code: "idp_unavailable" | "sso_misconfigured", message: string) {
    super(message);
    this.code = code;
  }
}

/** Loud, greppable: `pm2 logs gradeiq | grep '\[auth\]'`. */
export function authLog(msg: string): void {
  console.error(`[auth] ${msg}`);
}

const why = (e: unknown) => (e instanceof Error ? (e.name === "TimeoutError" ? `no answer within ${IDP_TIMEOUT_MS / 1000}s` : e.message) : String(e));

type Discovery = { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string; end_session_endpoint?: string };
const g = globalThis as unknown as {
  __giqDisc?: Discovery;
  __giqDiscDownUntil?: number;
  __giqJwks?: ReturnType<typeof createRemoteJWKSet>;
};

async function discovery(): Promise<Discovery> {
  if (!ISSUER) throw new IdpError("sso_misconfigured", "KEYCLOAK_ISSUER is not set");
  if (g.__giqDisc) return g.__giqDisc;
  if ((g.__giqDiscDownUntil ?? 0) > Date.now()) {
    throw new IdpError("idp_unavailable", `Keycloak at ${ISSUER} was unreachable moments ago; retrying shortly`);
  }
  let res: Response;
  try {
    res = await fetch(`${ISSUER}/.well-known/openid-configuration`, { cache: "no-store", signal: AbortSignal.timeout(IDP_TIMEOUT_MS) });
  } catch (e) {
    g.__giqDiscDownUntil = Date.now() + IDP_RETRY_AFTER_MS;
    throw new IdpError("idp_unavailable", `Keycloak discovery at ${ISSUER} failed: ${why(e)}`);
  }
  if (res.status >= 500) {
    g.__giqDiscDownUntil = Date.now() + IDP_RETRY_AFTER_MS;
    throw new IdpError("idp_unavailable", `Keycloak discovery at ${ISSUER} answered HTTP ${res.status}`);
  }
  if (!res.ok) throw new IdpError("sso_misconfigured", `Keycloak discovery at ${ISSUER} answered HTTP ${res.status} — is the realm name in KEYCLOAK_ISSUER right?`);
  const d = (await res.json().catch(() => ({}))) as Partial<Discovery>;
  // The id_token is verified against KEYCLOAK_ISSUER. If Keycloak calls itself
  // something else (http vs https, a different hostname, a trailing path), every
  // login would fail AFTER the password step — say so up front instead.
  if (String(d.issuer || "").replace(/\/$/, "") !== ISSUER) {
    throw new IdpError("sso_misconfigured", `Keycloak reports issuer "${d.issuer}" but KEYCLOAK_ISSUER is "${ISSUER}" — they must match exactly`);
  }
  if (!d.authorization_endpoint || !d.token_endpoint || !d.jwks_uri) {
    throw new IdpError("sso_misconfigured", `Keycloak discovery at ${ISSUER} is missing endpoints`);
  }
  g.__giqDisc = d as Discovery;
  return g.__giqDisc;
}
async function jwks() {
  const d = await discovery();
  if (!g.__giqJwks) g.__giqJwks = createRemoteJWKSet(new URL(d.jwks_uri), { timeoutDuration: IDP_TIMEOUT_MS });
  return g.__giqJwks;
}

const b64url = (b: Buffer) => b.toString("base64url");
function pkce() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export async function startLogin(returnTo = "/superadmin"): Promise<string> {
  const d = await discovery();
  const { verifier, challenge } = pkce();
  const state = b64url(crypto.randomBytes(16));
  const nonce = b64url(crypto.randomBytes(16));
  const jar = await cookies();
  jar.set(TX_COOKIE, JSON.stringify({ state, verifier, nonce, returnTo: safeReturnTo(returnTo) }), {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 600,
  });
  const u = new URL(d.authorization_endpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", CLIENT_ID);
  u.searchParams.set("redirect_uri", REDIRECT_URI);
  u.searchParams.set("scope", "openid email profile");
  u.searchParams.set("state", state);
  u.searchParams.set("nonce", nonce);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

export async function finishLogin(reqUrl: URL): Promise<{ ok: true; returnTo: string } | { ok: false; error: string }> {
  const jar = await cookies();
  const raw = jar.get(TX_COOKIE)?.value;
  jar.delete(TX_COOKIE);
  if (!raw) return { ok: false, error: "missing_tx" };
  let tx: { state: string; verifier: string; nonce: string; returnTo: string };
  try { tx = JSON.parse(raw); } catch { return { ok: false, error: "bad_tx" }; }

  // Keycloak sends ?error=… back when the user cancels or the login is refused.
  const idpError = reqUrl.searchParams.get("error");
  if (idpError) {
    authLog(`Keycloak returned error "${idpError}" to the callback`);
    return { ok: false, error: idpError === "access_denied" ? "access_denied" : "callback_failed" };
  }
  const code = reqUrl.searchParams.get("code");
  const state = reqUrl.searchParams.get("state");
  if (!code || !state || state !== tx.state) return { ok: false, error: "state_mismatch" };

  const d = await discovery();
  const body = new URLSearchParams({
    grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code_verifier: tx.verifier,
  });
  let tokRes: Response;
  try {
    tokRes = await fetch(d.token_endpoint, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, cache: "no-store",
      signal: AbortSignal.timeout(IDP_TIMEOUT_MS),
    });
  } catch (e) {
    throw new IdpError("idp_unavailable", `Keycloak token endpoint failed: ${why(e)}`);
  }
  if (!tokRes.ok) {
    // 401 = Keycloak does not accept OUR client credentials: a wrong
    // OIDC_CLIENT_SECRET (or client id). Every login will fail the same way.
    if (tokRes.status === 401) {
      authLog(`Keycloak rejected client "${CLIENT_ID}" at the token endpoint (HTTP 401) — check OIDC_CLIENT_SECRET / OIDC_CLIENT_ID`);
      return { ok: false, error: "sso_misconfigured" };
    }
    authLog(`Keycloak token exchange failed: HTTP ${tokRes.status}`);
    return { ok: false, error: "token_exchange_failed" };
  }
  const tok = (await tokRes.json()) as { access_token: string; id_token: string };

  const keys = await jwks();
  let idClaims: JWTPayload, accessClaims: JWTPayload;
  try {
    idClaims = (await jwtVerify(tok.id_token, keys, { issuer: ISSUER, audience: CLIENT_ID, algorithms: ["RS256"] })).payload;
    accessClaims = (await jwtVerify(tok.access_token, keys, { issuer: ISSUER, algorithms: ["RS256"] })).payload;
  } catch (e) {
    authLog(`Keycloak tokens failed verification: ${why(e)}`);
    return { ok: false, error: "token_verify_failed" };
  }
  if (idClaims.nonce !== tx.nonce) return { ok: false, error: "nonce_mismatch" };
  // Roles are read from the access token, so it must be the one issued to THIS client.
  if (accessClaims.azp !== CLIENT_ID) {
    authLog(`refused sign-in: access token was issued to "${String(accessClaims.azp)}", not "${CLIENT_ID}"`);
    return { ok: false, error: "token_verify_failed" };
  }

  const email = String(idClaims.email ?? "").toLowerCase();
  const name = String(idClaims.preferred_username ?? idClaims.name ?? email);
  const access = accessFromClaims(accessClaims as Record<string, unknown>, CLIENT_ID);
  if ("denied" in access) {
    authLog(`refused sign-in for "${name}": ${access.denied}`);
    return { ok: false, error: "no_access" };
  }

  const sid = newSid();
  insertSession({ sid, sub: String(idClaims.sub ?? ""), email, name, role: access.role, clientId: access.clientId, id_token: tok.id_token });
  markOidcCutover();
  jar.set(SESSION_COOKIE, sid, {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: SESSION_TTL_S,
  });
  return { ok: true, returnTo: safeReturnTo(tx.returnTo) };
}

/**
 * Sign out. ALWAYS revokes the GradeIQ session first (row + cookie) — that
 * part never depends on Keycloak — then returns where to send the browser:
 * Keycloak's end-session (so the SSO session ends too) when it is reachable,
 * else straight to `postLogoutRedirect`.
 */
export async function endLogin(postLogoutRedirect: string): Promise<string> {
  const { idToken } = await revokeCurrentSession();
  // Nothing to end at Keycloak for someone who never signed in through it,
  // unless Keycloak is the live sign-in.
  if (!idToken && effectiveAuthMode() !== "oidc") return postLogoutRedirect;
  let d: Discovery;
  try {
    d = await discovery();
  } catch (e) {
    authLog(`signed out of GradeIQ; Keycloak end-session skipped: ${why(e)}`);
    return postLogoutRedirect;
  }
  if (!d.end_session_endpoint) return postLogoutRedirect;
  const u = new URL(d.end_session_endpoint);
  if (idToken) u.searchParams.set("id_token_hint", idToken);
  u.searchParams.set("post_logout_redirect_uri", postLogoutRedirect);
  u.searchParams.set("client_id", CLIENT_ID);
  return u.toString();
}
