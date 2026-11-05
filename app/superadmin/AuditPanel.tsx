"use client";
import { useCallback, useEffect, useState } from "react";
import { withBase } from "@/lib/basePath";

// Audit log — every recorded event across sessions, filterable by the things an
// operator actually asks about: time window, client, model, grade, step, event.
// Scope is enforced server-side; a client admin's filters can only narrow within
// their own tenant.

type Row = {
  id: number;
  session_id: string;
  step: string;
  event: string;
  detail: Record<string, any>;
  at: string;
  client_id: string;
  model: string;
  cosmetic_grade: string;
};

type Facets = { models: string[]; grades: string[]; steps: string[]; events: string[] };

const EVENT_TONE: Record<string, string> = {
  "capture-rejected": "chip-yellow",
  "offer-blocked": "chip-red",
  "accept-blocked": "chip-red",
  accepted: "chip-green",
  graded: "chip-green",
  "pro-refined": "chip-green",
};

function ago(at: string): string {
  const t = Date.parse(at.replace(" ", "T") + "Z");
  if (!Number.isFinite(t)) return at;
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function AuditPanel({
  clientId,
  isSuper,
  onOpenSession,
}: {
  clientId: string;
  isSuper: boolean;
  onOpenSession: (id: string) => void;
}) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [facets, setFacets] = useState<Facets>({ models: [], grades: [], steps: [], events: [] });
  const [f, setF] = useState({ client: "", model: "", grade: "", step: "", event: "", since: "", until: "" });

  // Super admin defaults to the selected client but can clear it for all.
  useEffect(() => {
    setF((p) => ({ ...p, client: isSuper ? clientId : "" }));
  }, [clientId, isSuper]);

  const load = useCallback(() => {
    setRows(null);
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v) q.set(k, v);
    fetch(withBase(`/api/portal/audit?${q}`))
      .then((r) => (r.ok ? r.json() : { rows: [], facets }))
      .then((d) => {
        setRows(d.rows);
        if (d.facets) setFacets(d.facets);
      });
  }, [f]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(load, [load]);

  const quick = (days: number) => {
    const d = new Date(Date.now() - days * 86400000);
    setF((p) => ({ ...p, since: d.toISOString().slice(0, 19).replace("T", " "), until: "" }));
  };

  const Sel = ({ k, label, opts }: { k: keyof typeof f; label: string; opts: string[] }) => (
    <select
      className="input"
      style={{ maxWidth: 190 }}
      value={f[k]}
      onChange={(e) => setF((p) => ({ ...p, [k]: e.target.value }))}
    >
      <option value="">{label}</option>
      {opts.map((o) => (
        <option key={o} value={o}>{o}</option>
      ))}
    </select>
  );

  return (
    <div className="flex flex-col gap-4">
      <section className="card p-4">
        <div className="flex flex-wrap items-center gap-2">
          {isSuper && <Sel k="client" label="All clients" opts={["swapmore", "swapmore-in", "denovo", "default"]} />}
          <Sel k="model" label="All models" opts={facets.models} />
          <Sel k="grade" label="All grades" opts={facets.grades} />
          <Sel k="step" label="All steps" opts={facets.steps} />
          <Sel k="event" label="All events" opts={facets.events} />
          <span className="mx-1 text-[11px] uppercase tracking-wide text-[var(--muted)]">Time</span>
          {[
            ["1h", 1 / 24],
            ["24h", 1],
            ["7d", 7],
            ["30d", 30],
          ].map(([label, d]) => (
            <button key={label as string} className="pill" style={{ fontSize: 12 }} onClick={() => quick(d as number)}>
              {label}
            </button>
          ))}
          <button
            className="pill"
            style={{ fontSize: 12 }}
            onClick={() => setF({ client: isSuper ? clientId : "", model: "", grade: "", step: "", event: "", since: "", until: "" })}
          >
            Reset
          </button>
          <span className="ml-auto text-[12px] text-[var(--muted)]">
            {rows ? `${rows.length} event${rows.length === 1 ? "" : "s"}` : "…"}
          </span>
        </div>
      </section>

      <section className="card p-5">
        {!rows ? (
          <p className="text-sm text-[var(--muted)]">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">No events match these filters.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-[var(--muted)]">
                  <th className="py-2 pr-3">When</th>
                  <th className="py-2 pr-3">Session</th>
                  <th className="py-2 pr-3">Client</th>
                  <th className="py-2 pr-3">Device</th>
                  <th className="py-2 pr-3">Grade</th>
                  <th className="py-2 pr-3">Step</th>
                  <th className="py-2 pr-3">Event</th>
                  <th className="py-2 pr-3">Detail</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-[var(--border)]">
                    <td className="whitespace-nowrap py-2 pr-3 text-[var(--muted)]" title={r.at}>{ago(r.at)}</td>
                    <td className="py-2 pr-3">
                      <button className="mono font-semibold text-[var(--brand)]" onClick={() => onOpenSession(r.session_id)}>
                        #{r.session_id}
                      </button>
                    </td>
                    <td className="py-2 pr-3">{r.client_id}</td>
                    <td className="py-2 pr-3">{r.model || "—"}</td>
                    <td className="py-2 pr-3 font-bold">{r.cosmetic_grade || "—"}</td>
                    <td className="py-2 pr-3">{r.step}</td>
                    <td className="py-2 pr-3">
                      <span className={`pill ${EVENT_TONE[r.event] || ""}`} style={{ fontSize: 10, fontWeight: 700 }}>{r.event}</span>
                    </td>
                    <td className="mono py-2 pr-3 text-[11px] text-[var(--muted)]">
                      {Object.entries(r.detail || {})
                        .filter(([, v]) => v !== null && v !== undefined && v !== "")
                        .slice(0, 4)
                        .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("|") : v}`)
                        .join("  ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
