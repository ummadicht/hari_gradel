"use client";
import { useCallback, useEffect, useState } from "react";
import { withBase } from "@/lib/basePath";

/**
 * Re-grade desk — a dedicated console surface for re-running grades in bulk.
 *
 * The session monitor re-grades one device at a time in context; this is the
 * separate flow for the other job: an operator who has just changed a pricing
 * catalog, a capture rule, or the vision prompt, and wants to lift a whole
 * batch of already-graded sessions onto the new pipeline. It lists gradeable
 * sessions with their current grade and run count, re-grades each inline (tier
 * of the operator's choice), shows what moved per row, and can sweep a whole
 * filtered set with one button — every run through the same staff-gated endpoint
 * as the report and the monitor.
 */

type Row = {
  id: string;
  model: string;
  client_id: string;
  cosmetic_grade: string;
  overall_grade: string;
  tier: string | null;
  review: number | null;
  photo_count: number | null;
  updated_at: string;
};

type RowState = {
  status: "idle" | "running" | "done" | "error";
  from?: string;
  to?: string;
  direction?: "better" | "worse" | "same" | "unknown";
  offer?: string;
  msg?: string;
};

const MONEY: Record<string, string> = { USD: "$", INR: "₹", EUR: "€" };

export default function RegradePanel({
  clientId,
  isSuper,
  onOpenSession,
}: {
  clientId: string;
  isSuper: boolean;
  onOpenSession: (id: string) => void;
}) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [scope, setScope] = useState(clientId);
  const [tier, setTier] = useState<"pro" | "flash">("pro");
  const [state, setState] = useState<Record<string, RowState>>({});
  const [sweeping, setSweeping] = useState(false);
  const [onlyGradeable, setOnlyGradeable] = useState(true);

  useEffect(() => setScope(clientId), [clientId]);

  const load = useCallback(() => {
    setRows(null);
    setState({});
    fetch(withBase(`/api/portal/sessions?client=${scope}&limit=200`))
      .then((r) => (r.ok ? r.json() : { sessions: [] }))
      .then((d) => setRows(d.sessions || []));
  }, [scope]);
  useEffect(load, [load]);

  // Only sessions that actually have photos to re-read are re-gradeable; a
  // session with no captures would just 400 every time.
  const list = (rows ?? []).filter((r) => (onlyGradeable ? (r.photo_count ?? 0) > 0 : true));

  async function regradeOne(id: string): Promise<void> {
    setState((s) => ({ ...s, [id]: { status: "running" } }));
    try {
      const r = await fetch(withBase(`/api/sessions/${id}/reprocess`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setState((s) => ({ ...s, [id]: { status: "error", msg: d.error || `Failed (${r.status})` } }));
        return;
      }
      setState((s) => ({
        ...s,
        [id]: {
          status: "done",
          from: d.diff?.from,
          to: d.diff?.to,
          direction: d.diff?.direction,
          offer: d.offer?.blocked
            ? "on hold"
            : d.offer?.value != null
              ? `${MONEY[d.offer.currency || "USD"] || ""}${d.offer.value}`
              : "—",
        },
      }));
      // Reflect the new grade in the row itself.
      setRows((prev) =>
        prev
          ? prev.map((x) => (x.id === id ? { ...x, cosmetic_grade: d.after?.grade ?? x.cosmetic_grade, tier: d.after?.tierUsed ?? x.tier } : x))
          : prev,
      );
    } catch {
      setState((s) => ({ ...s, [id]: { status: "error", msg: "Network error — nothing changed" } }));
    }
  }

  /**
   * Sweep the visible set — sequentially, NOT in parallel. Each Pro re-grade is
   * two Pro vision calls; firing 200 at once would hammer the quota and get most
   * of them rate-limited. One at a time is slower but every row actually lands.
   */
  async function sweep() {
    setSweeping(true);
    for (const r of list) {
      if (state[r.id]?.status === "done") continue; // don't redo ones already run this session
      await regradeOne(r.id);
    }
    setSweeping(false);
  }

  const pending = list.filter((r) => state[r.id]?.status !== "done").length;

  return (
    <div className="flex flex-col gap-4">
      <section className="card p-5">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-bold">Re-grade desk</h2>
            <p className="mt-1 text-[12px] text-[var(--muted)]">
              Re-run stored photos through the current pipeline after a catalog, capture-rule or
              prompt change. Each Pro re-grade runs two passes and reconciles them; a re-grade also
              refreshes identity, diagnostics, the overall grade and the price. Functional test
              results stay as measured.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {isSuper && (
              <button className="pill" style={{ fontSize: 12 }} onClick={() => setScope(scope === "all" ? clientId : "all")}>
                {scope === "all" ? "This client" : "All clients"}
              </button>
            )}
            <select
              className="input"
              style={{ maxWidth: 140, padding: "6px 8px", fontSize: 12 }}
              value={tier}
              onChange={(e) => setTier(e.target.value as "pro" | "flash")}
              disabled={sweeping}
            >
              <option value="pro">Pro (settle)</option>
              <option value="flash">Flash (quick)</option>
            </select>
            <button className="btn" style={{ padding: "9px 16px", fontSize: 13 }} onClick={sweep} disabled={sweeping || pending === 0}>
              {sweeping ? "Re-grading…" : `↻ Re-grade ${pending} session${pending === 1 ? "" : "s"}`}
            </button>
          </div>
        </div>
        <label className="mt-3 flex items-center gap-2 text-[12px] text-[var(--muted)]">
          <input type="checkbox" checked={onlyGradeable} onChange={() => setOnlyGradeable((v) => !v)} />
          Only sessions with photos to re-read
        </label>
      </section>

      <section className="card p-5">
        {!rows ? (
          <p className="text-sm text-[var(--muted)]">Loading…</p>
        ) : list.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">No re-gradeable sessions for this client.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-[var(--muted)]">
                  <th className="py-2 pr-3">Session</th>
                  {scope === "all" && <th className="py-2 pr-3">Client</th>}
                  <th className="py-2 pr-3">Device</th>
                  <th className="py-2 pr-3">Grade</th>
                  <th className="py-2 pr-3">Tier</th>
                  <th className="py-2 pr-3">Photos</th>
                  <th className="py-2 pr-3">Result</th>
                  <th className="py-2 pr-3"></th>
                </tr>
              </thead>
              <tbody>
                {list.map((r) => {
                  const st = state[r.id];
                  return (
                    <tr key={r.id} className="border-t border-[var(--border)]">
                      <td className="py-2 pr-3">
                        <button className="mono font-semibold text-[var(--brand)]" onClick={() => onOpenSession(r.id)}>
                          #{r.id}
                        </button>
                      </td>
                      {scope === "all" && <td className="py-2 pr-3">{r.client_id}</td>}
                      <td className="py-2 pr-3">{r.model || "—"}</td>
                      <td className="py-2 pr-3 font-bold">{r.cosmetic_grade || "—"}</td>
                      <td className="py-2 pr-3 text-[12px] text-[var(--muted)]">{r.tier || "—"}</td>
                      <td className="py-2 pr-3">{r.photo_count ?? 0}</td>
                      <td className="py-2 pr-3">
                        {!st || st.status === "idle" ? (
                          <span className="text-[var(--muted)]">—</span>
                        ) : st.status === "running" ? (
                          <span className="text-[var(--muted)]">re-grading…</span>
                        ) : st.status === "error" ? (
                          <span style={{ color: "var(--bad)" }}>{st.msg}</span>
                        ) : (
                          <span className="inline-flex items-center gap-2">
                            <span
                              className={`pill ${
                                st.from === st.to
                                  ? ""
                                  : st.direction === "worse"
                                    ? "chip-red"
                                    : st.direction === "better"
                                      ? "chip-green"
                                      : "chip-yellow"
                              }`}
                              style={{ fontSize: 10, fontWeight: 800 }}
                            >
                              {st.from === st.to ? "unchanged" : `${st.from || "—"} → ${st.to || "—"}`}
                            </span>
                            <span className="text-[12px] text-[var(--muted)]">{st.offer}</span>
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-right">
                        <button
                          className="pill"
                          style={{ fontSize: 11 }}
                          disabled={st?.status === "running" || sweeping}
                          onClick={() => regradeOne(r.id)}
                        >
                          {st?.status === "done" ? "Re-grade again" : "Re-grade"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
