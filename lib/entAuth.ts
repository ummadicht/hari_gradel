import crypto from "node:crypto";
import { portalUser, builtinDefaultsAllowed } from "./portalAuth";
import { effectiveAuthMode } from "./auth-mode";

// Soft auth gate for GradeIQ Enterprise (the desk-tester console). Credentials
// default to denovo/denovo, overridable via env. This is a staff gate, not a
// hardened identity system — the cookie is a hash of the current credentials.
//
// UNIFIED with the super-admin portal: a portal sign-in (admin / denovo /
// swapmoreus / swapmoreind) satisfies this gate too, so enterprise, settings and
// the console are ONE flow with ONE login. The legacy ent cookie keeps working
// so nothing bookmarked breaks.

export const ENT_COOKIE = "ent_session";

export function entCreds() {
  return {
    user: process.env.ENT_USER || "denovo",
    pass: process.env.ENT_PASS || "denovo",
  };
}

function token(): string {
  const { user, pass } = entCreds();
  return crypto
    .createHash("sha256")
    .update(`gradeiq-enterprise:${user}:${pass}`)
    .digest("hex")
    .slice(0, 40);
}

export function makeSession(): string {
  return token();
}

export function validCreds(u: string, p: string): boolean {
  // Legacy-only, and the denovo/denovo default only while the built-in
  // defaults are allowed (see builtinDefaultsAllowed in lib/portalAuth.ts).
  if (effectiveAuthMode() !== "legacy") return false;
  if (!process.env.ENT_PASS && !builtinDefaultsAllowed()) return false;
  const c = entCreds();
  return u === c.user && p === c.pass;
}

export async function isEntAuthed(): Promise<boolean> {
  // Any authenticated staff (a Keycloak portal login of any role) satisfies the
  // console gate — enterprise + portal are one sign-in.
  return (await portalUser()) !== null;
}
