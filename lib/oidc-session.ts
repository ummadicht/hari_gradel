import crypto from "crypto";
import { cookies } from "next/headers";
import { db } from "./db";
import { isClientId, type ClientId } from "./clients";

// Server-side session store for Keycloak logins (single gradeiq.db). Replaces the
// giq_portal / ent_session hash cookies. Cookie is an opaque sid; the row is the
// state, so deleting it revokes. Role (super|client) + client scope come from the
// Keycloak token claims.

export const SESSION_COOKIE = "giq_session";
export const SESSION_TTL_S = 60 * 60 * 24 * 14; // 14d

db.exec(`CREATE TABLE IF NOT EXISTS oidc_sessions (
  sid TEXT PRIMARY KEY, sub TEXT, email TEXT, name TEXT,
  role TEXT, client_id TEXT, id_token TEXT, created_at INTEGER
)`);

// Durable auth facts that must survive an env wipe (see oidcCutoverAt).
db.exec(`CREATE TABLE IF NOT EXISTS auth_state (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, at INTEGER NOT NULL
)`);

export type GiqRole = "super" | "client";
export type GiqSession = {
  sid: string; sub: string; email: string; name: string;
  role: GiqRole; clientId: ClientId | null; id_token: string | null; created_at: number;
};

const liveAt = (c: number) => c + SESSION_TTL_S >= Math.floor(Date.now() / 1000);

export function newSid(): string {
  return "gsid_" + crypto.randomBytes(24).toString("base64url");
}

export function insertSession(s: { sid: string; sub: string; email: string; name: string; role: GiqRole; clientId: string | null; id_token: string | null }): void {
  db.prepare(
    `INSERT INTO oidc_sessions (sid, sub, email, name, role, client_id, id_token, created_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(sid) DO UPDATE SET
       sub = excluded.sub,
       email = excluded.email,
       name = excluded.name,
       role = excluded.role,
       client_id = excluded.client_id,
       id_token = excluded.id_token,
       created_at = excluded.created_at`
  ).run(s.sid, s.sub, s.email, s.name, s.role, s.clientId, s.id_token, Math.floor(Date.now() / 1000));
}

function rowToSession(r: { sid: string; sub: string; email: string; name: string; role: string; client_id: string | null; id_token: string | null; created_at: number }): GiqSession {
  return {
    sid: r.sid, sub: r.sub, email: r.email, name: r.name,
    role: r.role === "super" ? "super" : "client",
    clientId: r.client_id && isClientId(r.client_id) ? (r.client_id as ClientId) : null,
    id_token: r.id_token, created_at: r.created_at,
  };
}

export function getSession(sid: string): GiqSession | null {
  const r = db.prepare(`SELECT * FROM oidc_sessions WHERE sid = ?`).get(sid) as Parameters<typeof rowToSession>[0] | undefined;
  if (!r) return null;
  if (!liveAt(r.created_at)) { destroySession(sid); return null; }
  return rowToSession(r);
}

export function destroySession(sid: string): void {
  db.prepare(`DELETE FROM oidc_sessions WHERE sid = ?`).run(sid);
}

export async function currentSession(): Promise<GiqSession | null> {
  const c = await cookies();
  const sid = c.get(SESSION_COOKIE)?.value;
  if (!sid) return null;
  return getSession(sid);
}

/**
 * Sign out of GradeIQ locally: delete the session row and clear the cookie.
 * Returns the id_token (for Keycloak's end-session hint), if there was one.
 *
 * This never talks to Keycloak, so it works while Keycloak is down — revoking
 * must not depend on the IdP being reachable.
 */
export async function revokeCurrentSession(): Promise<{ idToken: string | null }> {
  const jar = await cookies();
  const sid = jar.get(SESSION_COOKIE)?.value;
  let idToken: string | null = null;
  if (sid) {
    const r = db.prepare(`SELECT id_token FROM oidc_sessions WHERE sid = ?`).get(sid) as { id_token: string | null } | undefined;
    idToken = r?.id_token ?? null;
    destroySession(sid);
  }
  jar.delete(SESSION_COOKIE);
  return { idToken };
}

/**
 * When this server first completed a Keycloak sign-in, or null.
 *
 * Recorded in the DATABASE on purpose: the env is what gets lost (a deploy that
 * rewrites .env.local, a VM rebuild), and losing GIQ_AUTH_MODE after the cutover
 * would otherwise quietly re-open the built-in default passwords. With this set,
 * an UNSET flag keeps those defaults off; only an explicit GIQ_AUTH_MODE=legacy
 * (a deliberate rollback) turns them back on. See lib/portalAuth.ts.
 */
export function oidcCutoverAt(): number | null {
  const r = db.prepare(`SELECT at FROM auth_state WHERE key = 'oidc_cutover'`).get() as { at: number } | undefined;
  return r?.at ?? null;
}

export function markOidcCutover(): void {
  db.prepare(
    `INSERT INTO auth_state (key, value, at) VALUES ('oidc_cutover', 'first keycloak sign-in', ?)
     ON CONFLICT(key) DO NOTHING`
  ).run(Math.floor(Date.now() / 1000));
}
