import { createHash, timingSafeEqual } from "node:crypto";
import { fetchServiceToken, keycloakIssuer, ServiceAuthError } from "./serviceToken";

/**
 * MACHINE-TO-MACHINE AUTH, WITH OR WITHOUT KEYCLOAK.
 *
 * The three machine routes moved to Keycloak client_credentials before any
 * Keycloak existed, and live GradeIQ has no KEYCLOAK_ISSUER — so SwapMore's
 * pricebook push, the console's "→ SuperIQ" push and the Pandas-style customers
 * API all failed, the push with a "KEYCLOAK_ISSUER is not set" error.
 *
 * Which path is in force is keyed on KEYCLOAK_ISSUER alone, never on
 * GIQ_AUTH_MODE: machine callers can move to Keycloak before or after staff
 * sign-in does (docs/KEYCLOAK-CUTOVER.md).
 *
 *   issuer set     Keycloak tokens only (lib/serviceToken.ts), as before.
 *   issuer unset   the shared secrets the callers already hold:
 *                  • pricebook  ← SwapMore sends `x-sync-secret`, compared in
 *                    constant time with PRICEBOOK_SYNC_SECRET;
 *                  • push-superiq → SuperIQ's legacy ingest takes a static
 *                    Bearer: SUPERIQ_TOKEN (SuperIQ's Phonecheck webhook secret);
 *                  • customers API → 503 "not configured" (it has no pre-
 *                    Keycloak scheme worth reviving).
 *
 * Nothing here throws: an unset secret is a 503 that names the env variable
 * (never its value), a wrong one a 401.
 */

/** Is machine-to-machine auth on Keycloak? (KEYCLOAK_ISSUER set.) */
export function keycloakM2M(): boolean {
  return !!keycloakIssuer();
}

export const SYNC_SECRET_HEADER = "x-sync-secret";

export type M2MCheck = { ok: true } | { ok: false; status: number; error: string };

/** Compare digests, not strings: same length always, so no timing or length leak. */
function sameSecret(got: string, want: string): boolean {
  const a = createHash("sha256").update(got).digest();
  const b = createHash("sha256").update(want).digest();
  return timingSafeEqual(a, b);
}

/** SwapMore's pricebook push without Keycloak: `x-sync-secret` against PRICEBOOK_SYNC_SECRET. */
export function checkSyncSecret(req: Request): M2MCheck {
  const want = (process.env.PRICEBOOK_SYNC_SECRET || "").trim();
  if (!want) return { ok: false, status: 503, error: "not configured: PRICEBOOK_SYNC_SECRET is not set on GradeIQ" };
  const got = (req.headers.get(SYNC_SECRET_HEADER) || "").trim();
  if (!got || !sameSecret(got, want)) return { ok: false, status: 401, error: "unauthorized" };
  return { ok: true };
}

export type BearerResult = { ok: true; token: string; via: "keycloak" | "static" } | { ok: false; status: number; error: string };

/**
 * The Bearer GradeIQ sends to SuperIQ's diagnostics ingest: a minted
 * `gradeiq-svc` token with Keycloak, else SUPERIQ_TOKEN.
 */
export async function superiqBearer(): Promise<BearerResult> {
  if (keycloakM2M()) {
    try {
      return { ok: true, token: await fetchServiceToken(), via: "keycloak" };
    } catch (e) {
      // Keycloak not reachable / misconfigured is OUR side (503); anything else
      // went wrong talking to it (502).
      return { ok: false, status: e instanceof ServiceAuthError ? 503 : 502, error: e instanceof Error ? e.message : "token request failed" };
    }
  }
  const token = (process.env.SUPERIQ_TOKEN || "").trim();
  if (!token) return { ok: false, status: 503, error: "SuperIQ push not configured: set SUPERIQ_TOKEN on GradeIQ (or KEYCLOAK_ISSUER for Keycloak)." };
  return { ok: true, token, via: "static" };
}

/** The customers API without Keycloak: a clean 503 in that route's own error shape. */
export const CUSTOMERS_NOT_CONFIGURED = {
  status: 503,
  body: { error: { code: "not_configured", message: "Machine-to-machine access is not configured on this server." } },
} as const;
