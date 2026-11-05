"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { withBase } from "@/lib/basePath";
import { sessionAlias } from "@/lib/sessionAlias";
import {
  exceptions as deriveExceptions,
  SEVERITY_RANK,
  ACTIONABLE,
  STAGE_LABEL,
  TAG_LABEL,
  type Severity,
  type Stage,
  type SessionTag,
} from "@/lib/sessionStage";

/**
 * Everything needing a human, worst first — a destination rather than a card.
 *
 * This used to be a panel on Operations showing the top 8, which meant the
 * ninth exception was invisible and there was nowhere to work through a
 * backlog. Exceptions are the only screen in this console with a queue shape:
 * a list you empty, not a dashboard you read.
 *
 * Severity is NOT computed here. The rows arrive with server-derived stage and
 * tags, and lib/sessionStage.ts turns those into a level — the same derivation
 * the dashboard and the session monitor use, so a phone cannot be a "hold" on
 * one screen and clean on another.
 */

type Row = {
  id: string;
  model: string;
  imei: string;
  client_id: string;
  cosmetic_grade: string;
  stage: Stage;
  tags: SessionTag[];
  photo_count: number | null;
  created_at: string;
  updated_at: string;
};

const TONE: Record<Severity, string> = {
  hold: "chip-red",
  review: "chip-red",
  gap: "chip-yellow",
  stalled: "chip-yellow",
  normal: "chip-green",
};
const LABEL: Record<Severity, string> = {
  hold: "Hold",
  review: "Review",
  gap: "Identity gap",
  stalled: "Stalled",
  normal: "Normal",
};
/** Worst first, and the order the filter chips read in. */
const LEVELS: Severity[] = ["hold", "review", "gap", "stalled"];

export default function ExceptionQueue({
  clientId,
  onOpenSession,
}: {
  clientId: string;
  onOpenSession: (id: string) => void;
}) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState("");
  /** Opens on what needs a decision. "All" (including stalled) is one click. */
  const [only, setOnly] = useState<Severity | "" | "actionable">("actionable");

  const load = useCallback(async () => {
    setErr("");
    try {
      const r = await fetch(withBase(`/api/portal/sessions?client=${encodeURIComponent(clientId)}&limit=200`));
      if (!r.ok) throw new Error("Could not load sessions.");
      setRows((await r.json()).sessions ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not load exceptions.");
    }
  }, [clientId]);

  useEffect(() => {
    setRows(null);
    void load();
    const t = window.setInterval(() => void load(), 20000);
    return () => window.clearInterval(t);
  }, [load]);

  const all = useMemo(() => deriveExceptions(rows ?? []), [rows]);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const x of all) c[x.level] = (c[x.level] ?? 0) + 1;
    return c;
  }, [all]);
  const shown =
    only === "actionable"
      ? all.filter((x) => ACTIONABLE.includes(x.level))
      : only
        ? all.filter((x) => x.level === only)
        : all;

  if (!rows) return <div className="card p-6 text-sm text-[var(--muted)]">{err || "Loading exceptions…"}</div>;

  return (
    <div className="space-y-4">
      {err && <div className="card chip-red p-3 text-sm font-semibold">{err}</div>}

      <div className="flex flex-wrap items-center gap-2">
        <button
          className="pill"
          style={{ fontWeight: 600, border: only === "actionable" ? "2px solid var(--brand)" : "1px solid var(--border)" }}
          onClick={() => setOnly("actionable")}
        >
          Needs a decision {all.filter((x) => ACTIONABLE.includes(x.level)).length}
        </button>
        <button
          className="pill"
          style={{ fontWeight: 600, border: only === "" ? "2px solid var(--brand)" : "1px solid var(--border)" }}
          onClick={() => setOnly("")}
        >
          All {all.length}
        </button>
        {LEVELS.map((lv) => (
          <button
            key={lv}
            className={`pill ${counts[lv] ? TONE[lv] : ""}`}
            style={{ fontWeight: 700, border: only === lv ? "2px solid var(--brand)" : "1px solid var(--border)" }}
            onClick={() => setOnly(only === lv ? "" : lv)}
          >
            {LABEL[lv]} {counts[lv] ?? 0}
          </button>
        ))}
        <span className="ml-auto text-[12px] text-[var(--muted)]">
          {rows.length - all.length} of {rows.length} clean
        </span>
      </div>

      {shown.length === 0 ? (
        <div className="card p-8 text-center">
          <div className="text-2xl">✓</div>
          <div className="mt-2 text-sm font-bold">
            {only === "actionable" ? "Nothing needs a decision" : "Nothing needs a human"}
          </div>
          <p className="mt-1 text-[12px] text-[var(--muted)]">
            {rows.length} session{rows.length === 1 ? "" : "s"} checked.
          </p>
        </div>
      ) : (
        <div className="card divide-y divide-[var(--border)] overflow-hidden">
          {shown.map(({ session, level, reason }) => (
            <button
              key={session.id}
              className="flex w-full items-start gap-3 px-5 py-4 text-left hover:bg-[var(--bg-soft)]"
              onClick={() => onOpenSession(session.id)}
            >
              <span className={`pill ${TONE[level]}`} style={{ fontSize: 10, minWidth: 78, textAlign: "center" }}>
                {LABEL[level]}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-bold">
                  {session.model || "Unknown device"} · #{sessionAlias(session.id)}
                </span>
                <span className="mt-0.5 block text-[11px] leading-4 text-[var(--muted)]">{reason}</span>
                <span className="mt-1.5 flex flex-wrap gap-1">
                  <span className="pill" style={{ fontSize: 9 }}>{STAGE_LABEL[session.stage]}</span>
                  {(session.tags ?? []).map((t) => (
                    <span key={t} className="pill" style={{ fontSize: 9 }}>
                      {TAG_LABEL[t] ?? t}
                    </span>
                  ))}
                </span>
              </span>
              <span className="whitespace-nowrap text-right text-[11px] text-[var(--muted)]">
                <span className="block">{session.updated_at?.slice(5, 16)}</span>
                <span className="block">Open →</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Badge count for the sidebar — ACTIONABLE only.
 *
 * Counting stalled sessions here made the badge read 110 of 110 on a real
 * database. A number that is always maxed out is not information.
 */
export function countExceptions(rows: { stage: Stage; tags: SessionTag[] }[]): number {
  return deriveExceptions(rows).filter((x) => ACTIONABLE.includes(x.level)).length;
}

export { SEVERITY_RANK };
