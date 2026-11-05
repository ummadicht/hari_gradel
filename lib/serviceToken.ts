import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

// M2M for GradeIQ — verify inbound Keycloak client_credentials tokens (JWKS), and
// mint outbound ones (for the GradeIQ → SuperIQ diagnostics push). Same realm as
// human login; independent of next/headers so any route handler can use it.
//
// Independent of GIQ_AUTH_MODE: machine callers need only KEYCLOAK_ISSUER, so
// M2M can go live while staff still sign in the legacy way. Without an issuer
// the routes use the shared secrets instead (lib/m2m.ts); with Keycloak
// unreachable a bearer call answers a clean 503 — it used to throw and surface
// as a bare 500.

/** The realm issuer, read when asked (not at import), "" when unset. */
export function keycloakIssuer(): string {
  return (process.env.KEYCLOAK_ISSUER || "").trim().replace(/\/$/, "");
}
const IDP_TIMEOUT_MS = 4000;
const g = globalThis as unknown as {
  __giqSvcJwks?: ReturnType<typeof createRemoteJWKSet>;
  __giqTokenEndpoint?: string;
  /** The issuer the cached JWKS + token endpoint belong to. */
  __giqSvcIssuer?: string;
};

/** Keycloak is not configured or not reachable — our side, not the caller's. */
export class ServiceAuthError extends Error {}

async function discovery(issuer: string): Promise<{ jwks_uri: string; token_endpoint: string }> {
  if (!issuer) throw new ServiceAuthError("KEYCLOAK_ISSUER is not set");
  let res: Response;
  try {
    res = await fetch(`${issuer}/.well-known/openid-configuration`, { cache: "no-store", signal: AbortSignal.timeout(IDP_TIMEOUT_MS) });
  } catch (e) {
    throw new ServiceAuthError(`Keycloak discovery failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) throw new ServiceAuthError(`OIDC discovery failed: ${res.status}`);
  return res.json();
}
async function jwks() {
  const issuer = keycloakIssuer();
  if (!g.__giqSvcJwks || g.__giqSvcIssuer !== issuer) {
    const d = await discovery(issuer);
    g.__giqTokenEndpoint = d.token_endpoint;
    g.__giqSvcJwks = createRemoteJWKSet(new URL(d.jwks_uri), { timeoutDuration: IDP_TIMEOUT_MS });
    g.__giqSvcIssuer = issuer;
  }
  return g.__giqSvcJwks;
}

export type ServiceResult =
  | { ok: true; svc: { clientId: string; client?: string; raw: JWTPayload } }
  | { ok: false; status: number; error: string };

export async function verifyServiceJwt(
  token: string,
  key: Parameters<typeof jwtVerify>[1],
  opts: { issuer: string; audience: string; azp?: string | string[] }
): Promise<ServiceResult> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, key, { issuer: opts.issuer, audience: opts.audience, algorithms: ["RS256"] }));
  } catch (e) {
    // The JWKS could not be fetched (Keycloak down, nothing cached): that is
    // not the caller's fault and must not read as "your token is bad".
    const code = (e as { code?: string })?.code;
    if (code === "ERR_JWKS_TIMEOUT" || (e instanceof Error && /fetch failed|ECONNREFUSED|ENOTFOUND/i.test(e.message))) {
      return { ok: false, status: 503, error: "temporarily_unavailable" };
    }
    return { ok: false, status: 401, error: "invalid_token" };
  }
  const azp = typeof payload.azp === "string" ? payload.azp : undefined;
  if (opts.azp) {
    const allowed = Array.isArray(opts.azp) ? opts.azp : [opts.azp];
    if (!azp || !allowed.includes(azp)) return { ok: false, status: 403, error: "unauthorized_client" };
  }
  return { ok: true, svc: { clientId: azp ?? "", client: payload.giq_client as string | undefined, raw: payload } };
}

/** Verify `Authorization: Bearer <jwt>` as a machine token for this app (audience "gradeiq"). */
export async function requireServiceToken(
  req: Request,
  opts: { audience?: string; azp?: string | string[] } = {}
): Promise<ServiceResult> {
  const auth = req.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (!m) return { ok: false, status: 401, error: "missing_bearer_token" };
  const issuer = keycloakIssuer();
  // Not an outage, a configuration: no stack, no error log (lib/m2m.ts routes
  // never get here without an issuer; this keeps any other caller clean too).
  if (!issuer) return { ok: false, status: 503, error: "not_configured" };
  let keys: Awaited<ReturnType<typeof jwks>>;
  try {
    keys = await jwks();
  } catch (e) {
    console.error(`[auth] M2M token check unavailable: ${e instanceof Error ? e.message : String(e)}`);
    return { ok: false, status: 503, error: "temporarily_unavailable" };
  }
  return verifyServiceJwt(m[1], keys, { issuer, audience: opts.audience ?? "gradeiq", azp: opts.azp });
}

// Outbound: mint a client_credentials access token (for calling SuperIQ). Cached
// until shortly before expiry.
const tcache = globalThis as unknown as { __giqSvcTok?: { token: string; exp: number; issuer: string } };
export async function fetchServiceToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const issuer = keycloakIssuer();
  if (tcache.__giqSvcTok && tcache.__giqSvcTok.issuer === issuer && tcache.__giqSvcTok.exp - 30 > now) return tcache.__giqSvcTok.token;
  await jwks(); // ensure token_endpoint discovered
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.SVC_CLIENT_ID || "gradeiq-svc",
    client_secret: process.env.SVC_CLIENT_SECRET || "",
  });
  let res: Response;
  try {
    res = await fetch(g.__giqTokenEndpoint!, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, cache: "no-store",
      signal: AbortSignal.timeout(IDP_TIMEOUT_MS),
    });
  } catch (e) {
    throw new ServiceAuthError(`client_credentials failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) throw new ServiceAuthError(`client_credentials failed: ${res.status}`);
  const tok = (await res.json()) as { access_token: string; expires_in?: number };
  tcache.__giqSvcTok = { token: tok.access_token, exp: now + (tok.expires_in ?? 300), issuer };
  return tok.access_token;
}
