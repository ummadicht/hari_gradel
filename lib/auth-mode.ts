// Which staff sign-in is live. Edge-safe: no node imports, no DB — the
// middleware runs in the edge runtime and imports this.
//
// GradeIQ was switched to Keycloak-only sign-in for every staff route before a
// Keycloak instance existed. The result was a total lockout: /superadmin,
// /console, /enterprise, /settings and /channel/retail all redirected to an OIDC
// start that threw "KEYCLOAK_ISSUER is not set", which redirected to a /login
// page whose only control linked back to the same failing start. A closed loop
// with no way in.
//
// So the mode is a FLAG, defaulting to the auth that actually works, and it
// flips with an env var and a restart — no rebuild, no code change. The edge
// sandbox reads process.env when the server starts (only NEXT_PUBLIC_* is baked
// in at build), so `pm2 restart gradeiq` after editing .env.local is the flip.
//
//   GIQ_AUTH_MODE=oidc     Keycloak. Password sign-in is OFF (the routes 404).
//   GIQ_AUTH_MODE=legacy   an explicit rollback to the username+password logins.
//   (unset)                legacy — today's behaviour, until the cutover.
//
// The flag is trusted as written. It used to be second-guessed — `oidc` with no
// KEYCLOAK_ISSUER quietly became `legacy` — which meant losing ONE env line
// silently re-opened every built-in default password (admin/admin, …). Now a
// half-configured `oidc` stays `oidc`: /auth/login sends staff to a page that
// says single sign-on isn't configured and logs exactly which env names are
// missing, password sign-in stays off, and signed-in sessions keep working.
// Rolling back is a deliberate act: GIQ_AUTH_MODE=legacy + restart.
export type AuthMode = "legacy" | "oidc";
export type AuthModeFlag = AuthMode | "unset";

/** The flag exactly as configured. "unset" covers empty and unrecognised values. */
export function authModeFlag(): AuthModeFlag {
  const v = String(process.env.GIQ_AUTH_MODE || "").trim().toLowerCase();
  return v === "oidc" ? "oidc" : v === "legacy" ? "legacy" : "unset";
}

/** The staff sign-in mechanism in force. */
export function effectiveAuthMode(): AuthMode {
  return authModeFlag() === "oidc" ? "oidc" : "legacy";
}

/** Env a staff (human) Keycloak login cannot work without. Names only. */
export const OIDC_REQUIRED_ENV = ["KEYCLOAK_ISSUER", "OIDC_CLIENT_SECRET", "OIDC_REDIRECT_URI"] as const;

/** Which of OIDC_REQUIRED_ENV are missing. Empty = configured. Never values. */
export function oidcMissingEnv(): string[] {
  return OIDC_REQUIRED_ENV.filter((k) => !String(process.env[k] || "").trim());
}

/** Cookies that count as "signed in", per mode. */
export const OIDC_COOKIE = "giq_session";
export const LEGACY_COOKIES = ["giq_portal", "ent_session"] as const;
