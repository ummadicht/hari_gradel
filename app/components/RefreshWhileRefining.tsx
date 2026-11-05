"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { withBase } from "@/lib/basePath";

/**
 * Pulls the report forward when grading finishes behind it.
 *
 * THE BUG THIS FIXES: `/api/sessions/[id]/cosmetic` answers early and finishes
 * the real Pro pass in a detached `void (async () => …)`. The report page is
 * `force-dynamic` and server-rendered with NO client refresh — so it shows
 * whatever was in the database at page load. Open it while the pass is still
 * running and you get the provisional result with no damage boxes, and it stays
 * that way until someone manually reloads. The annotations were never missing;
 * the page simply never asked again.
 *
 * Polls only while the session says it is `refining`, then refreshes once and
 * stops. No timer runs on a finished report.
 *
 * SUP-63: it stops on the server's word, not on a guess. GET /api/sessions/[id]
 * says `refine.state`: "running" while the grade may still land, "unfinished"
 * once the flag is older than the Pro timeout + retry + margin (the stored
 * flag stays set, so `cosmetic.refining` alone would never let go). Either way
 * out, the page re-renders: with the grade, or with "Grading did not finish".
 * It used to give up silently after ~2 minutes and leave a stale page.
 */
export default function RefreshWhileRefining({
  sessionId,
  refining,
  remainingMs,
}: {
  sessionId: string;
  refining: boolean;
  /** How long until the server calls this grade unfinished (from the page render). */
  remainingMs?: number;
}) {
  const router = useRouter();
  const [waiting, setWaiting] = useState(refining);

  useEffect(() => {
    if (!refining) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    // Past the server's limit plus slack for clock and polling, stop asking.
    const capMs = (typeof remainingMs === "number" ? Math.max(0, remainingMs) : 0) + 120_000;

    const tick = async () => {
      if (stopped) return;
      try {
        const r = await fetch(withBase(`/api/sessions/${sessionId}`), { cache: "no-store" });
        if (r.ok) {
          const s = await r.json();
          const state = s?.refine?.state;
          const settled = typeof state === "string" ? state !== "running" : !s?.cosmetic?.refining;
          if (settled) {
            stopped = true;
            setWaiting(false);
            // Re-render the server component with the finished grade, findings
            // and boxes (or the unfinished notice), rather than reloading and
            // losing the scroll position.
            router.refresh();
            return;
          }
        }
      } catch {
        /* a failed poll just means we try again */
      }
      const elapsed = Date.now() - started;
      if (elapsed > capMs) {
        stopped = true;
        setWaiting(false);
        return;
      }
      // A Pro pass is usually seconds: ask often at first, then ease off.
      timer = setTimeout(tick, elapsed < 120_000 ? 3000 : 15_000);
    };

    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [refining, remainingMs, sessionId, router]);

  if (!waiting) return null;

  return (
    <div className="mt-4 flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg-soft)] px-4 py-3">
      <span
        className="inline-block h-3 w-3 shrink-0 animate-pulse rounded-full"
        style={{ background: "var(--brand)" }}
      />
      <span className="text-[13px] text-[var(--muted)]">
        Full inspection still running — damage marks and the final grade appear here
        automatically.
      </span>
    </div>
  );
}
