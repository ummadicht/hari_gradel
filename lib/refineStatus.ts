/**
 * IS THE GRADE STILL BEING WORKED OUT, OR DID THE WORK DIE? (SUP-63)
 *
 * A capture stores `cosmetic.refining = true` and finishes the grade in a
 * detached task (app/api/sessions/[id]/cosmetic/route.ts): the background
 * upload grades after answering, and a Flash grade is settled on Pro after it.
 * When that task ends it clears the flag, with a result or with `endRefining`.
 * When the process dies under it (a restart, a deploy, an out-of-memory kill)
 * nothing clears it, and the report showed "Full inspection still running"
 * with a pulsing dot for ever, over a session nobody would ever grade.
 *
 * This module only DECIDES; it never writes. A read of a session must change
 * no rows, so a stuck flag is presented as "did not finish" on every read
 * instead of being repaired by the first one. The stored record stays exactly
 * as the background task left it: a staff re-grade (POST /reprocess) replaces
 * it, and a late result that does land still persists and shows on the next
 * read, because nothing here touched the `_submitId` it checks.
 *
 * Pure (no imports) so it is tested without a database. The limit itself comes
 * from the vision settings: lib/visionProvider.ts refineUnfinishedAfterMs(), and
 * readers call refineStatusNow() there, which judges against the clock.
 */

/**
 * Head-room on top of the longest Pro call. It covers what runs before the Pro
 * call on the same flag (the background upload's own Flash grade, the photo
 * crop) and a D grade's corroborating second pass, which typically answers in
 * 10-30 s. A refinement slower than this still lands; it is only shown as
 * unfinished until it does.
 */
export const REFINE_MARGIN_MS = 120_000;

/**
 * How long `refining` may stand before a reader calls it unfinished: one Pro
 * call that runs out its timeout, its one retry after the longest pause, and
 * the margin. With the default 150 s Pro timeout that is 2 × 150 s + 1.2 s +
 * 120 s = 421.2 s, about 7 minutes.
 */
export function refineLimitMs(proTimeoutMs: number, retryPauseMaxMs: number, marginMs: number = REFINE_MARGIN_MS): number {
  const t = Number.isFinite(proTimeoutMs) && proTimeoutMs > 0 ? proTimeoutMs : 0;
  const p = Number.isFinite(retryPauseMaxMs) && retryPauseMaxMs > 0 ? retryPauseMaxMs : 0;
  const m = Number.isFinite(marginMs) && marginMs > 0 ? marginMs : 0;
  return 2 * t + p + m;
}

export type RefineState =
  /** Nothing is refining: graded, never graded, or a refinement that ended. */
  | "none"
  /** `refining` is set and younger than the limit: the work may still land. */
  | "running"
  /** `refining` is set and older than the limit: the work died. Show it as unfinished. */
  | "unfinished";

export type RefineStatus = {
  state: RefineState;
  /** When the grading started (epoch ms), or null when it is not known. */
  startedAt: number | null;
  /** The limit this was judged against (ms). */
  limitMs: number;
  /** The time it was judged at (epoch ms): `opts.now`. */
  judgedAt: number;
};

/** A plausible epoch-ms timestamp (after 2001, so a small counter is not mistaken for one). */
function epochMs(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : NaN;
  return Number.isFinite(n) && n > 1e12 ? n : null;
}

/**
 * SQLite's `datetime('now')` ("2026-10-22 16:04:32", UTC, no zone), or any ISO
 * string. Null when it does not parse.
 */
export function parseDbTime(v: unknown): number | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const s = v.trim();
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s) ? `${s.replace(" ", "T")}Z` : s;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * Where a session's cosmetic grading stands.
 *
 * The start is the capture's `_submitId` (Date.now() when the photos were
 * submitted). A record without one falls back to the session's `updated_at`,
 * which only ever moves forward, so it can make a stuck grade look younger but
 * never older: the fallback errs towards "running", never towards "unfinished".
 * With no usable time at all the answer is "running", the state the record
 * itself claims.
 *
 * Unfinished is strictly older than the limit: at exactly the limit it is
 * still running.
 */
export function refineStatus(
  cosmetic: unknown,
  opts: { now: number; limitMs: number; updatedAt?: unknown },
): RefineStatus {
  const c = (cosmetic && typeof cosmetic === "object" ? cosmetic : {}) as Record<string, unknown>;
  const { limitMs, now } = opts;
  if (c.refining !== true) return { state: "none", startedAt: null, limitMs, judgedAt: now };
  const startedAt = epochMs(c._submitId) ?? parseDbTime(opts.updatedAt);
  if (startedAt === null) return { state: "running", startedAt: null, limitMs, judgedAt: now };
  return { state: now - startedAt > limitMs ? "unfinished" : "running", startedAt, limitMs, judgedAt: now };
}

/**
 * The same decision as a field on GET /api/sessions/[id] (contracts/grade-result.ts
 * `refine`). The stored `cosmetic.refining` is left as it is in the response:
 * SwapUp reads a grade that is still flagged as refining as not final, which is
 * the honest reading of a grade whose final check never finished.
 */
export function refineField(st: RefineStatus): {
  state: RefineState;
  startedAt: string | null;
  unfinishedAfterSeconds: number;
} {
  return {
    state: st.state,
    startedAt: st.startedAt === null ? null : new Date(st.startedAt).toISOString(),
    unfinishedAfterSeconds: Math.round(st.limitMs / 1000),
  };
}
