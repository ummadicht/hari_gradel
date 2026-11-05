import { isClientId, type ClientId } from "./clients";

// What a Keycloak access token entitles its holder to in GradeIQ. Pure (no
// next/headers, no DB) so it can be unit-tested — lib/oidcClaims.test.mjs.
//
// The realm is SHARED with SuperIQ, so most people in it have nothing to do
// with GradeIQ. This used to default anyone without the `super` role to
// `client` — with no tenant — and that session then read every tenant's
// sessions, the integration settings and the per-client consoles. Access is
// now granted, never assumed:
//   super                        → every client
//   client + a known giq_client  → that one client
//   anything else                → refused, no session is created

export type GiqAccess =
  | { role: "super"; clientId: null }
  | { role: "client"; clientId: ClientId }
  | { denied: string };

export function accessFromClaims(payload: Record<string, unknown>, clientId = "gradeiq"): GiqAccess {
  const ra = payload.resource_access as Record<string, { roles?: unknown }> | undefined;
  const raw = ra?.[clientId]?.roles;
  const roles = Array.isArray(raw) ? raw.filter((r): r is string => typeof r === "string") : [];
  if (roles.includes("super")) return { role: "super", clientId: null };
  if (!roles.includes("client")) return { denied: `no GradeIQ role (needs the "${clientId}" client role "super" or "client")` };

  // A user attribute mapper emits a string; a multivalued one emits an array.
  // One value is a tenant; several is ambiguous and refused.
  let giq = payload.giq_client;
  if (Array.isArray(giq)) giq = giq.length === 1 ? giq[0] : undefined;
  const id = typeof giq === "string" ? giq.trim().toLowerCase() : "";
  if (!id) return { denied: `role "client" but no giq_client claim (set the user's giq_client attribute)` };
  if (!isClientId(id)) return { denied: `role "client" but giq_client "${id}" is not a GradeIQ client` };
  return { role: "client", clientId: id };
}
