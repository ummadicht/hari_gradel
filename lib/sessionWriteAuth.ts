import { db } from "./db";
import { portalUser } from "./portalAuth";
import { hasServerKey } from "./serverKey";
import { lockReason } from "./sessionWriteRules";

/**
 * The request side of lib/sessionWriteRules.ts: who is writing, and is the
 * session already final. Kept apart so the rules stay pure and testable.
 */

/**
 * The signed-in member of staff who may override THIS session, or null.
 *
 * Any portal / Keycloak sign-in counts (portalUser — the same check as
 * isEntAuthed, in both GIQ_AUTH_MODE settings), scoped by tenant the way every
 * portal API is: super for anything, a client admin for their own tenant's
 * sessions and for untenanted "default" ones — the standalone /enterprise desk
 * creates those, and its testers sign in as a client admin. A client admin of
 * another tenant is not staff for this session; their write is judged like
 * anyone else's.
 *
 * Never throws: no request scope, or an unreadable auth store, means "not staff".
 */
export async function staffFor(session: { client_id?: string | null }): Promise<string | null> {
  let user: Awaited<ReturnType<typeof portalUser>> = null;
  try {
    user = await portalUser();
  } catch {
    return null;
  }
  if (!user) return null;
  const tenant = String(session.client_id || "default");
  const inScope = user.role === "super" || tenant === "default" || (!!user.clientId && user.clientId === tenant);
  return inScope ? user.username || "staff" : null;
}

/**
 * SwapUp's server, proven by the shared GRADEIQ_SERVER_KEY (lib/serverKey.ts).
 *
 * SwapUp keeps its own authoritative copy of the phone's test results and
 * forwards the whole map; when the customer re-runs a failed test in SwapUp
 * Check, a pass legitimately replaces the fail. Only its server holds the key,
 * so it may do what staff may do on /functional. With no key configured this is
 * always false. (SwapUp sends the key on its IMEI calls today, not yet on
 * /functional — see docs/SESSION-WRITES.md.)
 */
export function isServerCaller(req: Request): boolean {
  return hasServerKey(req);
}

/** The status of the retail purchase built on this session, if any. */
export function purchaseStatusFor(sessionId: string): string | null {
  try {
    const r = db.prepare("SELECT status FROM purchases WHERE session_id = ? LIMIT 1").get(sessionId) as
      | { status?: string }
      | undefined;
    return r?.status ? String(r.status) : null;
  } catch {
    // No purchases table: this server has never run a retail purchase.
    return null;
  }
}

/** Why this session is final (and closed to anonymous writes), or null. */
export function sessionLock(s: { id: string; accepted?: number | null; verification?: Record<string, unknown> | null }): string | null {
  return lockReason({ accepted: s.accepted, verification: s.verification, purchaseStatus: purchaseStatusFor(s.id) });
}
