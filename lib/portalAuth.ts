import { createHash } from "node:crypto";
import { db } from "./db";
import { isClientId, type ClientId } from "./clients";
import { currentSession, oidcCutoverAt } from "./oidc-session";
import { cookies } from "next/headers";
import { authModeFlag, effectiveAuthMode } from "./auth-mode";

/**
 * Super-admin portal auth — account → role → tenant scope.
 *
 *   admin / admin              → SUPER: sees and edits EVERY client
 *   denovo / denovo            → client admin, scoped to "denovo"
 *   swapmoreus / swapmoreus    → client admin, scoped to "swapmore" (US)
 *   swapmoreind / swapmoreind  → client admin, scoped to "swapmore-in" (India)
 *
 * Passwords default to the username (per the operator's spec) and are
 * overridable via PORTAL_PW_<USERNAME> env vars for production hardening.
 *
 * Same trust level as lib/entAuth.ts: a staff gate, not a hardened identity
 * system — the cookie is a non-reversible hash of the current credentials, so
 * rotating a password invalidates that user's sessions.
 *
 * THE SCOPE RULE (enforced in scopedClient below, used by every portal API):
 * a client admin can only ever act on their own tenant; only SUPER may name
 * another client. Presentation never grants data access.
 */

export type PortalRole = "super" | "client";
export type PortalUser = {
  username: string;
  role: PortalRole;
  /** null = all clients (super). */
  clientId: ClientId | null;
};

const USERS: Array<PortalUser & { defaultPw: string }> = [
  { username: "admin", role: "super", clientId: null, defaultPw: "admin" },
  // Altaf Khan — platform super admin (mirrors the swapmore.vercel.app demo).
  { username: "altaf", role: "super", clientId: null, defaultPw: "altaf" },
  { username: "denovo", role: "client", clientId: "denovo", defaultPw: "denovo" },
  { username: "swapmoreus", role: "client", clientId: "swapmore", defaultPw: "swapmoreus" },
  { username: "swapmoreind", role: "client", clientId: "swapmore-in", defaultPw: "swapmoreind" },
  // Gadget Rebirth (India) — retail vendor; also the login for /channel/retail.
  { username: "inzman", role: "client", clientId: "inzman", defaultPw: "inzman" },
];

const COOKIE = "giq_portal";

// ── Stored users — created from the superadmin Users tab, no redeploy ────────
// Passwords are stored as sha256 only; the cookie token binds to that hash, so
// resetting a password invalidates the user's sessions (same rotation semantics
// as the built-in accounts). Built-ins always win a username collision.
db.exec(`
  CREATE TABLE IF NOT EXISTS portal_users (
    username   TEXT PRIMARY KEY,
    role       TEXT NOT NULL DEFAULT 'client',
    client_id  TEXT,
    pw_sha256  TEXT NOT NULL,
    created_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

type StoredUser = { username: string; role: PortalRole; clientId: ClientId | null; pwHash: string };

function storedUser(username: string): StoredUser | null {
  const r = db.prepare("SELECT * FROM portal_users WHERE username = ?").get(username) as
    | { username: string; role: string; client_id: string | null; pw_sha256: string }
    | undefined;
  if (!r) return null;
  return {
    username: r.username,
    role: r.role === "super" ? "super" : "client",
    clientId: r.client_id && isClientId(r.client_id) ? (r.client_id as ClientId) : null,
    pwHash: r.pw_sha256,
  };
}

export function listStoredUsers(): Array<{ username: string; role: PortalRole; clientId: string | null; createdBy: string; createdAt: string }> {
  return (db.prepare("SELECT * FROM portal_users ORDER BY username").all() as Array<{
    username: string; role: string; client_id: string | null; created_by: string; created_at: string;
  }>).map((r) => ({
    username: r.username,
    role: r.role === "super" ? "super" : "client",
    clientId: r.client_id,
    createdBy: r.created_by,
    createdAt: r.created_at,
  }));
}

export function isBuiltinUser(username: string): boolean {
  return USERS.some((u) => u.username === username.toLowerCase().trim());
}

export function createStoredUser(opts: { username: string; password: string; role: PortalRole; clientId: string | null; createdBy: string }): void {
  const username = opts.username.toLowerCase().trim().replace(/[^a-z0-9._-]/g, "").slice(0, 32);
  if (username.length < 3) throw new Error("Username must be at least 3 characters (a-z, 0-9, . _ -).");
  if (isBuiltinUser(username)) throw new Error(`"${username}" is a built-in account.`);
  if (storedUser(username)) throw new Error(`"${username}" already exists.`);
  if (String(opts.password).length < 4) throw new Error("Password must be at least 4 characters.");
  if (opts.role === "client" && (!opts.clientId || !isClientId(opts.clientId))) {
    throw new Error("A client user needs a valid client.");
  }
  db.prepare(
    "INSERT INTO portal_users (username, role, client_id, pw_sha256, created_by) VALUES (?, ?, ?, ?, ?)"
  ).run(username, opts.role, opts.role === "super" ? null : opts.clientId, sha256(opts.password), opts.createdBy);
}

export function resetStoredUserPassword(username: string, password: string): void {
  if (String(password).length < 4) throw new Error("Password must be at least 4 characters.");
  const r = db.prepare("UPDATE portal_users SET pw_sha256 = ? WHERE username = ?").run(sha256(password), username);
  if (!r.changes) throw new Error("User not found (built-ins rotate via PORTAL_PW_* env).");
}

export function deleteStoredUser(username: string): void {
  const r = db.prepare("DELETE FROM portal_users WHERE username = ?").run(username);
  if (!r.changes) throw new Error("User not found (built-ins can't be deleted).");
}

/**
 * May the built-in accounts still use their DEFAULT password (= username)?
 *
 *   GIQ_AUTH_MODE=oidc     no — and password sign-in is off entirely.
 *   GIQ_AUTH_MODE=legacy   yes: an explicit rollback restores the old world.
 *   unset                  yes until this server has completed a Keycloak
 *                          sign-in (oidcCutoverAt); no after it.
 *
 * The last row is the point. Before the cutover nothing changes. After it, an
 * env that LOST its GIQ_AUTH_MODE line (a deploy that rewrote .env.local, a VM
 * rebuild) must not quietly re-open admin/admin to the internet — so the
 * defaults stay off and only passwords an operator set (PORTAL_PW_*, ENT_PASS,
 * stored users) work until someone sets the flag on purpose.
 */
let warnedPaused = false;
export function builtinDefaultsAllowed(): boolean {
  if (effectiveAuthMode() !== "legacy") return false;
  if (authModeFlag() === "legacy") return true;
  if (oidcCutoverAt() === null) return true;
  if (!warnedPaused) {
    warnedPaused = true;
    console.error(
      "[auth] GIQ_AUTH_MODE is not set, but this server already moved to Keycloak — the built-in default passwords stay OFF. " +
        "Set GIQ_AUTH_MODE=oidc (or GIQ_AUTH_MODE=legacy to roll back on purpose) in .env.local and restart.",
    );
  }
  return false;
}

/** The legacy password sign-in is paused for built-in defaults — /login says so. */
export function defaultsPausedAfterCutover(): boolean {
  return effectiveAuthMode() === "legacy" && !builtinDefaultsAllowed();
}

/** A built-in's live password, or null when it has none it may use. */
function pwFor(u: { username: string; defaultPw: string }): string | null {
  const set = process.env[`PORTAL_PW_${u.username.toUpperCase()}`];
  if (set) return set;
  return builtinDefaultsAllowed() ? u.defaultPw : null;
}

// Non-reversible token bound to (user, current password). Dependency-free, same
// scheme as entAuth — rotate the password and every old cookie dies.
function tokenFor(username: string, pw: string): string {
  let h = 0;
  const s = `${username}::${pw}::gradeiq-portal-2026`;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `gqp_${(h >>> 0).toString(36)}`;
}

/** Check a login attempt; null on bad credentials. Built-ins, then stored. */
export function checkLogin(username: string, password: string): { user: PortalUser; token: string } | null {
  // Password sign-in exists only in legacy mode. The route already 404s in
  // oidc; this keeps the library from being a password oracle on its own.
  if (effectiveAuthMode() !== "legacy") return null;
  const name = username.toLowerCase().trim();
  const u = USERS.find((x) => x.username === name);
  if (u) {
    const pw = pwFor(u);
    if (pw === null || password !== pw) return null;
    return {
      user: { username: u.username, role: u.role, clientId: u.clientId },
      token: `${u.username}.${tokenFor(u.username, pw)}`,
    };
  }
  const s = storedUser(name);
  if (!s || sha256(password) !== s.pwHash) return null;
  // Token binds to the HASH: a password reset rotates it and old cookies die.
  return {
    user: { username: s.username, role: s.role, clientId: s.clientId },
    token: `${s.username}.${tokenFor(s.username, s.pwHash)}`,
  };
}

export const PORTAL_COOKIE = COOKIE;

/** The logged-in portal user, or null — now sourced from the Keycloak session
 *  (role from resource_access.gradeiq.roles, client scope from the giq_client
 *  claim). Same shape as before, so scopedClient() and every caller are untouched. */
export async function portalUser(): Promise<PortalUser | null> {
  // Keycloak session first — it wins whenever one exists, so flipping modes
  // never signs anyone out mid-session.
  const s = await currentSession();
  if (s) {
    // A client with no tenant would be scoped to nothing — and scopedClient()
    // and friends read a null tenant as "unscoped". No such session is issued
    // any more (lib/oidcClaims.ts); one left over is treated as signed out.
    if (s.role === "client" && !s.clientId) return null;
    return { username: s.email || s.name, role: s.role, clientId: s.clientId };
  }

  /* Then the portal cookie.
   *
   * This branch was deleted when sign-in moved to Keycloak, and because no
   * Keycloak was ever stood up it left portalUser() returning null for
   * everybody: the console rendered, then every API answered "not signed in".
   * Restoring it is what makes `legacy` mode a working mode rather than a
   * half-open door. */
  if (effectiveAuthMode() !== "legacy") return null;
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  return userForToken(token);
}

/**
 * Resolve a portal cookie back to its user.
 *
 * The token is a non-reversible hash of (username, current password), so this
 * recomputes each candidate's token and compares. Rotating a password therefore
 * invalidates that user's cookie automatically — which is the property the
 * scheme was designed around.
 */
function userForToken(raw: string): PortalUser | null {
  // checkLogin issues `<username>.<token>` — the name identifies the account,
  // the token proves the password. Both halves must agree; the name alone is
  // just a claim and grants nothing.
  const dot = raw.indexOf(".");
  if (dot <= 0) return null;
  const name = raw.slice(0, dot);
  const token = raw.slice(dot + 1);

  const u = USERS.find((x) => x.username === name);
  if (u) {
    const pw = pwFor(u);
    return pw !== null && tokenFor(u.username, pw) === token
      ? { username: u.username, role: u.role, clientId: u.clientId }
      : null;
  }
  const s = storedUser(name);
  if (!s) return null;
  return tokenFor(s.username, s.pwHash) === token
    ? { username: s.username, role: s.role, clientId: s.clientId }
    : null;
}

/**
 * Resolve which client this user may act on for a request.
 *
 * SUPER: whatever was asked for (must be valid). CLIENT: always their own
 * tenant — a requested id that differs is a 403, not a silent redirect, so a
 * probing client admin learns the boundary exists rather than being quietly
 * remapped.
 */
export function scopedClient(
  user: PortalUser,
  requested: string | null | undefined,
  isValid: (id: string) => boolean,
): { ok: true; clientId: string } | { ok: false; status: number; error: string } {
  if (user.role === "super") {
    const id = (requested || "").toLowerCase().trim();
    if (!id) return { ok: false, status: 400, error: "client required" };
    if (!isValid(id)) return { ok: false, status: 404, error: "unknown client" };
    return { ok: true, clientId: id };
  }
  const own = user.clientId;
  if (!own) return { ok: false, status: 403, error: "forbidden: no client assigned to this login" };
  if (requested && requested.toLowerCase().trim() !== own) {
    return { ok: false, status: 403, error: "forbidden: not your client" };
  }
  return { ok: true, clientId: own };
}
