import { db } from "./db";
import { hasRetailKey, hasServerKey } from "./serverKey";
import { clientIpFrom } from "./uaInfo";
import { isClientId } from "./clients";

/**
 * THE SHARED LIMITER: who is asking, and how much they may spend.
 *
 * Two budgets live here, on the same caller rules (lookupGrant below):
 *   1. paid IMEI lookups (SUP-72) — this comment;
 *   2. anonymous uploads and vision-model calls (SUP-80) — further down,
 *      "UPLOADS AND AI CALLS".
 * Both reserve BEFORE the work is done, synchronously, so a burst of parallel
 * requests cannot all see "under the limit".
 *
 * WHO MAY SPEND A PAID IMEI LOOKUP, AND HOW MANY.
 *
 * A session is created with nothing but a POST, and every new IMEI on it used
 * to cost Phonecheck calls (station GetDeviceInfo, then GSMA CheckEsn). Anyone
 * could run up the bill by posting made-up IMEIs to /api/sessions, and the
 * session routes behind it (/offer, /accept, /ocr) paid again for an IMEI the
 * create had skipped.
 *
 * Who gets the paid lookup on a cache miss (a cache hit is free for everyone):
 *   • server  — SwapUp's server, proven by x-gradeiq-server-key. No limit.
 *   • retail  — CounterIQ's server, proven by x-gradeiq-retail-key
 *               (GRADEIQ_RETAIL_KEY). No limit: every desk on a CounterIQ
 *               deployment reaches us from that VM's one address, so a per-IP
 *               limit would switch the blacklist check off for all of them.
 *   • staff   — a portal / Keycloak sign-in. No limit.
 *   • channel — an anonymous caller from a KNOWN channel: a tenant's consumer
 *               embed (?client=swapmore, any client other than "default"), or a
 *               retail desk that sends no key (channel "retail"). Limited to
 *               GRADEIQ_ANON_LOOKUP_CAP paid lookups per IP per UTC day AND to
 *               GRADEIQ_ANON_LOOKUP_TOTAL_CAP across all IPs per UTC day.
 *   • anonymous — anyone else (no channel, the default client). No paid lookup.
 *
 * The channel is the caller's own claim, so it is never trusted on its own: it
 * only decides whether the anonymous allowance applies at all. The per-IP limit
 * stops one address; the daily total stops many (a proxy pool, a block of IPv6
 * addresses) — without it the bill had no upper bound. Over either limit, or
 * with no right to a lookup, the session is still created — with the free TAC
 * answer, marked `skipped`, so the identity reads as unverified.
 *
 * The IP is the first X-Forwarded-For entry. Caddy sets that header to the
 * address it saw; with no proxy in front, `next start` fills it from the socket.
 * (A caller who can reach the app port directly, past Caddy, can write their
 * own X-Forwarded-For — keep :3700 closed to the internet.)
 */

export const DEFAULT_ANON_LOOKUP_CAP = 20;
export const DEFAULT_ANON_LOOKUP_TOTAL_CAP = 200;

/** A non-negative whole number from env `name`, else `fallback` (unset or junk). */
function envCap(name: string, fallback: number): number {
  const raw = String(process.env[name] ?? "").trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** Paid lookups one IP may trigger anonymously per UTC day (GRADEIQ_ANON_LOOKUP_CAP). */
export function anonLookupCap(): number {
  return envCap("GRADEIQ_ANON_LOOKUP_CAP", DEFAULT_ANON_LOOKUP_CAP);
}

/** Paid lookups ALL anonymous callers together may trigger per UTC day (GRADEIQ_ANON_LOOKUP_TOTAL_CAP). */
export function anonLookupTotalCap(): number {
  return envCap("GRADEIQ_ANON_LOOKUP_TOTAL_CAP", DEFAULT_ANON_LOOKUP_TOTAL_CAP);
}

export type LookupCaller = "server" | "retail" | "staff" | "channel" | "anonymous" | "internal";
/** daily-cap: this IP's limit · total-cap: every IP's limit together · no-channel: no right to one. */
export type SkipReason = "daily-cap" | "total-cap" | "no-channel";

export type LookupGrant = {
  caller: LookupCaller;
  /** First X-Forwarded-For entry ("" when there is none). */
  ip: string;
};

/** The channel context a session carries: CounterIQ's retail desk or a tenant's embed. */
export function isKnownChannel(ctx: { channel?: unknown; client?: unknown }): boolean {
  const channel = String(ctx.channel ?? "").toLowerCase().trim();
  if (channel === "retail" || channel === "embed") return true;
  const client = String(ctx.client ?? "").toLowerCase().trim();
  return isClientId(client) && client !== "default";
}

/** The request's client IP, as Caddy (or `next start`) recorded it. */
export function requestIp(req: Request): string {
  return clientIpFrom(req.headers).slice(0, 64);
}

/**
 * Who is asking, for the paid-lookup rules above.
 *
 * `ctx` is the channel context: the request body's client/channel at session
 * create, the stored session's client/channel on the session routes. Never
 * throws — an unreadable auth store means "not staff".
 */
export async function lookupGrant(req: Request, ctx: { channel?: unknown; client?: unknown }): Promise<LookupGrant> {
  const ip = requestIp(req);
  if (hasServerKey(req)) return { caller: "server", ip };
  if (hasRetailKey(req)) return { caller: "retail", ip };
  try {
    const { portalUser } = await import("./portalAuth");
    if (await portalUser()) return { caller: "staff", ip };
  } catch {
    /* no request scope, or the auth store is unreadable — not staff */
  }
  return { caller: isKnownChannel(ctx) ? "channel" : "anonymous", ip };
}

/** UTC calendar day, yyyy-mm-dd. */
export function utcDay(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** paid: a call was made · skipped: held back for this caller · ceiling: held back by the daily total. */
type Outcome = "paid" | "skipped" | "ceiling";

function bump(day: string, g: LookupGrant, outcome: Outcome, by: number): void {
  db.prepare(
    `INSERT INTO paid_lookups (day, ip, caller, outcome, n) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(day, ip, caller, outcome) DO UPDATE SET n = CASE WHEN paid_lookups.n + excluded.n > 0 THEN paid_lookups.n + excluded.n ELSE 0 END`
  ).run(day, g.ip, g.caller, outcome, by);
}

/** Paid lookups this IP has made anonymously today (the number the limit is checked against). */
export function anonPaidToday(ip: string, now: number = Date.now()): number {
  const r = db
    .prepare("SELECT COALESCE(SUM(n), 0) AS n FROM paid_lookups WHERE day = ? AND ip = ? AND caller = 'channel' AND outcome = 'paid'")
    .get(utcDay(now), ip) as { n: number };
  return Number(r?.n ?? 0);
}

/** Paid lookups ALL anonymous callers together have made today (checked against the daily total). */
export function anonPaidTodayAll(now: number = Date.now()): number {
  const r = db
    .prepare("SELECT COALESCE(SUM(n), 0) AS n FROM paid_lookups WHERE day = ? AND caller = 'channel' AND outcome = 'paid'")
    .get(utcDay(now)) as { n: number };
  return Number(r?.n ?? 0);
}

/** The day the "total reached" line was last written to the log (once a day is enough). */
let warnedDay = "";

/**
 * Reserve ONE paid lookup for this caller, before the call is made.
 *
 * Reserving first (rather than counting after the call returns) is what makes
 * the limits hold under load: better-sqlite3 is synchronous, so both checks and
 * the increment run with no await between them, and a burst of parallel
 * requests cannot all see "under the limit" before any of them is counted. A
 * refusal is counted too — 'skipped' for this caller's limit, 'ceiling' for
 * the daily total.
 */
export function reservePaidLookup(g: LookupGrant, now: number = Date.now()): { ok: true } | { ok: false; reason: SkipReason } {
  const day = utcDay(now);
  if (g.caller === "anonymous") {
    bump(day, g, "skipped", 1);
    return { ok: false, reason: "no-channel" };
  }
  if (g.caller === "channel") {
    if (anonPaidToday(g.ip, now) >= anonLookupCap()) {
      bump(day, g, "skipped", 1);
      return { ok: false, reason: "daily-cap" };
    }
    const total = anonLookupTotalCap();
    if (anonPaidTodayAll(now) >= total) {
      bump(day, g, "ceiling", 1);
      if (warnedDay !== day) {
        warnedDay = day;
        // The alert: one line in the server log (pm2 logs gradeiq) per day, and
        // the console's Integrations tab shows it until midnight UTC.
        console.warn(
          `[lookups] ${day}: anonymous callers reached the daily total of ${total} paid IMEI lookups (GRADEIQ_ANON_LOOKUP_TOTAL_CAP). ` +
            "Until 00:00 UTC, sessions from the embed and keyless retail desks get the free TAC answer only. The server key, the retail key and staff are not affected."
        );
      }
      return { ok: false, reason: "total-cap" };
    }
  }
  bump(day, g, "paid", 1);
  return { ok: true };
}

/** Give a reservation back: the lookup turned out to cost nothing (no credentials configured). */
export function releasePaidLookup(g: LookupGrant, now: number = Date.now()): void {
  bump(utcDay(now), g, "paid", -1);
}

export type PaidLookupStats = {
  day: string;
  /** Lookups that spent a Phonecheck call today. */
  total: number;
  byCaller: Record<"server" | "retail" | "staff" | "channel" | "internal", number>;
  /** Lookups held back today (a limit reached, or no right to one). */
  skipped: number;
  skippedByReason: Record<SkipReason, number>;
  /** The per-IP daily limit for anonymous callers. */
  cap: number;
  /** IPs that reached the limit today. */
  ipsAtCap: number;
  /** The daily total for all anonymous callers together. */
  totalCap: number;
  /** Anonymous callers reached the daily total today: they get no paid lookup until midnight UTC. */
  totalReached: boolean;
};

/** Today's paid-lookup counts, for staff. */
export function paidLookupStats(now: number = Date.now()): PaidLookupStats {
  const day = utcDay(now);
  const rows = db
    .prepare("SELECT caller, outcome, SUM(n) AS n FROM paid_lookups WHERE day = ? GROUP BY caller, outcome")
    .all(day) as { caller: string; outcome: string; n: number }[];
  const byCaller = { server: 0, retail: 0, staff: 0, channel: 0, internal: 0 };
  const skippedByReason: Record<SkipReason, number> = { "daily-cap": 0, "total-cap": 0, "no-channel": 0 };
  for (const r of rows) {
    const n = Number(r.n) || 0;
    if (r.outcome === "paid" && r.caller in byCaller) byCaller[r.caller as keyof typeof byCaller] += n;
    if (r.outcome === "skipped") skippedByReason[r.caller === "anonymous" ? "no-channel" : "daily-cap"] += n;
    if (r.outcome === "ceiling") skippedByReason["total-cap"] += n;
  }
  const cap = anonLookupCap();
  const totalCap = anonLookupTotalCap();
  const atCap = db
    .prepare(
      "SELECT COUNT(*) AS n FROM (SELECT ip FROM paid_lookups WHERE day = ? AND caller = 'channel' AND outcome = 'paid' GROUP BY ip HAVING SUM(n) >= ?) AS sub"
    )
    .get(day, cap) as { n: number };
  return {
    day,
    total: byCaller.server + byCaller.retail + byCaller.staff + byCaller.channel + byCaller.internal,
    byCaller,
    skipped: skippedByReason["daily-cap"] + skippedByReason["total-cap"] + skippedByReason["no-channel"],
    skippedByReason,
    cap,
    ipsAtCap: Number(atCap?.n ?? 0),
    totalCap,
    totalReached: byCaller.channel >= totalCap,
  };
}

// ═══ UPLOADS AND AI CALLS (SUP-80) ═══════════════════════════════════════════
//
// The session routes take photos, frames and video from anyone holding a
// session id, write them to data/uploads and send them to a paid vision model —
// and a session is created with nothing but a POST. With no limit, one script
// could fill the VM's disk and run up the model bill.
//
// Same callers as above. NEVER limited: SwapUp's server key, CounterIQ's retail
// key, staff (a portal / Keycloak sign-in). Everyone else — a seller's phone,
// SwapUp's store tablet camera page, a scripted caller — shares two limits,
// counted per call (one POST = one call, whatever it carries):
//   • per session: GRADEIQ_ANON_UPLOAD_SESSION_CAP calls per UTC day;
//   • per IP:      GRADEIQ_ANON_UPLOAD_IP_HOURLY_CAP calls per UTC hour.
// Over either, the route answers 429 before it reads the body: nothing is
// written and no model is called. The refusal is counted here, logged to the
// session trail by the route (lib/uploadLimits.ts), and the first refusal for
// an address or a session each hour writes one line to the server log.
//
// The defaults are derived from what GradeIQ's own pages send — the working is
// in docs/UPLOAD-LIMITS.md. A session needs about 9 calls (SwapUp's tablet plus
// the seller's phone) and about 22 with heavy retakes and re-runs, so 60 a day
// is well over twice that. A store's tablets and the phones on its Wi-Fi share
// one address: three desks at one 10-minute session each is 18 sessions an
// hour, ~160 calls (~400 if every one is heavy), so 600 an hour stays clear of
// a busy store.
//
// There is deliberately no all-addresses total here (SUP-72 has one for
// lookups): running out of lookups degrades to the free TAC answer, but running
// out of uploads would stop every store grading at once.

export const DEFAULT_ANON_UPLOAD_SESSION_CAP = 60;
export const DEFAULT_ANON_UPLOAD_IP_HOURLY_CAP = 600;

/** Uploads / vision calls one session may make anonymously per UTC day (GRADEIQ_ANON_UPLOAD_SESSION_CAP). */
export function anonUploadSessionCap(): number {
  return envCap("GRADEIQ_ANON_UPLOAD_SESSION_CAP", DEFAULT_ANON_UPLOAD_SESSION_CAP);
}

/** Uploads / vision calls one IP may make anonymously per UTC hour (GRADEIQ_ANON_UPLOAD_IP_HOURLY_CAP). */
export function anonUploadIpHourlyCap(): number {
  return envCap("GRADEIQ_ANON_UPLOAD_IP_HOURLY_CAP", DEFAULT_ANON_UPLOAD_IP_HOURLY_CAP);
}

/** SwapUp's server key, CounterIQ's retail key, staff and the server's own work are never limited. */
export function isUnlimitedCaller(g: LookupGrant): boolean {
  return g.caller === "server" || g.caller === "retail" || g.caller === "staff" || g.caller === "internal";
}

/** UTC calendar hour, yyyy-mm-ddThh. */
export function utcHour(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 13);
}

/** ip-hourly: this address's hourly limit · session-daily: this session's daily limit. */
export type UploadRefusal = "ip-hourly" | "session-daily";

export type UploadReservation =
  | { ok: true }
  | {
      ok: false;
      reason: UploadRefusal;
      limit: number;
      /** Seconds until the window turns over. */
      retryAfter: number;
    };

const UPLOADS = "uploads";
type Scope = "ip" | "session";

function countCalls(win: string, scope: Scope, k: string): number {
  const r = db
    .prepare("SELECT n FROM call_budget WHERE budget = ? AND win = ? AND scope = ? AND k = ? AND outcome = 'allowed'")
    .get(UPLOADS, win, scope, k) as { n: number } | undefined;
  return Number(r?.n ?? 0);
}

function bumpCalls(win: string, scope: Scope, k: string, outcome: "allowed" | "refused"): void {
  db.prepare(
    `INSERT INTO call_budget (budget, win, scope, k, outcome, n) VALUES (?, ?, ?, ?, ?, 1)
     ON CONFLICT(budget, win, scope, k, outcome) DO UPDATE SET n = call_budget.n + 1`
  ).run(UPLOADS, win, scope, k, outcome);
}

/** Calls this IP has been let through this UTC hour. */
export function uploadCallsThisHour(ip: string, now: number = Date.now()): number {
  return countCalls(utcHour(now), "ip", ip);
}

/** Calls this session has been let through this UTC day. */
export function uploadCallsToday(sessionId: string, now: number = Date.now()): number {
  return countCalls(utcDay(now), "session", sessionId);
}

/** Refusals counted for an address this hour, or for a session today. */
export function uploadRefusals(scope: Scope, k: string, now: number = Date.now()): number {
  const win = scope === "ip" ? utcHour(now) : utcDay(now);
  const r = db
    .prepare("SELECT n FROM call_budget WHERE budget = ? AND win = ? AND scope = ? AND k = ? AND outcome = 'refused'")
    .get(UPLOADS, win, scope, k) as { n: number } | undefined;
  return Number(r?.n ?? 0);
}

/** What has been warned about this hour ("reason|ip-or-session"): a flood writes one log line, not thousands. */
const warned = new Set<string>();
let warnedHour = "";
/** The last hour the counter was pruned. */
let prunedHour = "";
/** Counters are kept this long, then dropped (each refusal also stays in its session's trail). */
const KEEP_DAYS = 14;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const secondsUntil = (now: number, period: number) =>
  Math.max(1, Math.ceil(((Math.floor(now / period) + 1) * period - now) / 1000));

/**
 * Reserve ONE upload / vision call for this caller, before the body is read.
 *
 * The reads and the increment run in one IMMEDIATE transaction with no await
 * in between, so parallel requests (or two app processes on one database)
 * cannot all slip under a limit. A caller that is never limited gets `ok` and
 * is not counted. `sessionId` is null on a route with no session yet
 * (/api/imei/ocr): only the per-IP limit applies there.
 */
export function reserveUploadCall(g: LookupGrant, sessionId: string | null, now: number = Date.now()): UploadReservation {
  if (isUnlimitedCaller(g)) return { ok: true };
  const hour = utcHour(now);
  const day = utcDay(now);
  if (prunedHour !== hour) {
    prunedHour = hour;
    try {
      db.prepare("DELETE FROM call_budget WHERE win < ?").run(utcDay(now - KEEP_DAYS * DAY_MS));
    } catch {
      /* housekeeping — never a reason to refuse or fail a call */
    }
  }
  const ipCap = anonUploadIpHourlyCap();
  const sessionCap = anonUploadSessionCap();
  const verdict = db
    .transaction((): UploadReservation => {
      if (countCalls(hour, "ip", g.ip) >= ipCap) {
        bumpCalls(hour, "ip", g.ip, "refused");
        return { ok: false, reason: "ip-hourly", limit: ipCap, retryAfter: secondsUntil(now, HOUR_MS) };
      }
      if (sessionId && countCalls(day, "session", sessionId) >= sessionCap) {
        bumpCalls(day, "session", sessionId, "refused");
        return { ok: false, reason: "session-daily", limit: sessionCap, retryAfter: secondsUntil(now, DAY_MS) };
      }
      bumpCalls(hour, "ip", g.ip, "allowed");
      if (sessionId) bumpCalls(day, "session", sessionId, "allowed");
      return { ok: true };
    })
    .immediate();

  if (!verdict.ok) {
    if (warnedHour !== hour) {
      warnedHour = hour;
      warned.clear();
    }
    const key = `${verdict.reason}|${verdict.reason === "ip-hourly" ? g.ip : sessionId}`;
    if (!warned.has(key)) {
      warned.add(key);
      // The alert: one line per address (or session) per hour in `pm2 logs gradeiq`.
      console.warn(
        verdict.reason === "ip-hourly"
          ? `[uploads] ${hour}: ${g.ip || "(no address)"} reached ${verdict.limit} anonymous uploads / vision calls this hour (GRADEIQ_ANON_UPLOAD_IP_HOURLY_CAP). Refusing with 429 until the hour turns. The server key, the retail key and staff are not affected.`
          : `[uploads] ${day}: session ${sessionId} reached ${verdict.limit} anonymous uploads / vision calls today (GRADEIQ_ANON_UPLOAD_SESSION_CAP). Refusing with 429 until 00:00 UTC. The server key, the retail key and staff are not affected.`
      );
    }
  }
  return verdict;
}
