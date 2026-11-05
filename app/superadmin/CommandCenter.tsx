"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { withBase } from "@/lib/basePath";
import { sessionAlias } from "@/lib/sessionAlias";
import {
  reachedFunnel,
  exceptions as deriveExceptions,
  STAGE_LABEL,
  SEVERITY_RANK,
  type Stage,
  type SessionTag,
  type Severity,
} from "@/lib/sessionStage";

type Session = {
  id: string;
  imei: string;
  model: string;
  status: string;
  cosmetic_grade: string;
  overall_grade: string;
  review: number | null;
  capture_verdict: string | null;
  photo_count: number | null;
  /** Derived server-side — the SAME derivation the session monitor renders. */
  stage: Stage;
  tags: SessionTag[];
  created_at: string;
  updated_at: string;
};

type Purchase = {
  id: string;
  status: string;
  session_id: string;
  offer?: { value?: number; currency?: string };
};

type LoadState = {
  sessions: Session[];
  purchases: Purchase[];
};

/**
 * `riskFor()` used to live here — a FOURTH opinion on the same facts. It scored
 * `photo_count < 4` as an evidence gap while the funnel directly beside it
 * counted `>= 4` as complete, and neither agreed with the server capture gate
 * that actually decides. Severity now comes from lib/sessionStage.ts, so the
 * dashboard, the exception queue and the session monitor cannot drift apart.
 */
const SEVERITY_TONE: Record<Severity, string> = {
  hold: "chip-red",
  review: "chip-red",
  gap: "chip-yellow",
  stalled: "chip-yellow",
  normal: "chip-green",
};
const SEVERITY_LABEL: Record<Severity, string> = {
  hold: "Hold",
  review: "Review",
  gap: "Identity gap",
  stalled: "Stalled",
  normal: "Normal",
};

export default function CommandCenter({
  clientId,
  onOpenSession,
  onStartInspection,
}: {
  clientId: string;
  onOpenSession: (id: string) => void;
  onStartInspection: () => void;
}) {
  const [data, setData] = useState<LoadState | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const [sessionRes, retailRes] = await Promise.all([
        fetch(withBase(`/api/portal/sessions?client=${encodeURIComponent(clientId)}&limit=200`)),
        fetch(withBase(`/api/retail/overview?client=${encodeURIComponent(clientId)}`)),
      ]);
      if (!sessionRes.ok) throw new Error("Could not load inspections.");
      const sessions = (await sessionRes.json()).sessions ?? [];
      const purchases = retailRes.ok ? ((await retailRes.json()).purchases ?? []) : [];
      setData({ sessions, purchases });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load operations.");
    }
  }, [clientId]);

  useEffect(() => {
    setData(null);
    void load();
    const timer = window.setInterval(() => void load(), 15000);
    return () => window.clearInterval(timer);
  }, [load]);

  const view = useMemo(() => {
    const sessions = data?.sessions ?? [];
    const today = new Date().toISOString().slice(0, 10);
    return {
      today: sessions.filter((s) => (s.created_at || s.updated_at).startsWith(today)).length,
      // Cumulative, because this panel is a CONVERSION view: "how many reached
      // at least this far". The session monitor shows the terminal version of
      // the same derivation — where each phone stopped.
      funnel: reachedFunnel(sessions),
      // The rows already carry server-derived stage + tags; severity reads them
      // back out rather than recomputing from columns the browser never receives.
      exceptions: deriveExceptions(sessions),
    };
  }, [data]);

  if (!data) return <div className="card p-6 text-sm text-[var(--muted)]">{error || "Loading operations…"}</div>;

  return (
    <div className="space-y-5">
      {error && <div className="card chip-red p-3 text-sm font-semibold">{error}</div>}

      <section className="overflow-hidden rounded-[18px] bg-[#1d1d1f] p-8 text-white">
        <div className="flex flex-wrap items-end justify-between gap-5">
          <div className="max-w-2xl">
            <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-white/50">Inspection command center</div>
            <h2 className="mt-2 text-[32px] font-semibold leading-tight tracking-[-0.028em]">Prove the phone before money moves.</h2>
            <p className="mt-2 text-sm leading-6 text-white/65">
              One operational view for device identity, functional testing, photo evidence, grading, purchase and custody exceptions.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {/* Was a link to /channel/retail, which is discontinued, and briefly
                to CounterIQ — a SEPARATE app with its own credentials, so it
                sent an operator to a sign-in their console login cannot pass.
                The in-console Desk tester starts an inspection for the selected
                client with the session they already have. */}
            <button
              className="rounded-[980px] bg-[#0071e3] px-5 py-2.5 text-[14px] font-medium text-white"
              onClick={onStartInspection}
            >
              Start an inspection
            </button>
            <button className="rounded-[980px] border border-white/25 px-5 py-2.5 text-[14px] font-medium" onClick={() => void load()}>Refresh</button>
          </div>
        </div>
        <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[
            ["Inspections today", view.today],
            ["Open exceptions", view.exceptions.length],
            ["Grades issued", view.funnel.find((f) => f.stage === "graded")?.count ?? 0],
            ["Purchases", data.purchases.length],
          ].map(([label, value]) => (
            <div key={label} className="rounded-2xl border border-white/10 bg-white/[0.06] p-4">
              <div className="text-[11px] font-bold uppercase tracking-wide text-white/45">{label}</div>
              <div className="mt-1 text-3xl font-black tabular-nums">{value}</div>
            </div>
          ))}
        </div>
      </section>

      <div className="grid items-start gap-5 xl:grid-cols-[1.35fr_.65fr]">
        <section className="card p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-lg font-extrabold">Product 1 qualification line</h3>
              <p className="mt-1 text-[12px] text-[var(--muted)]">Live conversion through the evidence chain—not vanity totals.</p>
            </div>
            <span className="pill chip-green">Live</span>
          </div>
          <div className="mt-5 grid gap-2 md:grid-cols-5">
            {view.funnel.map(({ stage, count }, index) => {
              const pct = data.sessions.length ? Math.round((count / data.sessions.length) * 100) : 0;
              return (
                <div key={stage} className="relative rounded-2xl border border-[var(--border)] p-3">
                  <div className="text-[10px] font-bold uppercase tracking-wide text-[var(--muted)]">0{index + 1}</div>
                  <div className="mt-4 text-2xl font-black tabular-nums">{count}</div>
                  <div className="text-[12px] font-bold">{STAGE_LABEL[stage]}</div>
                  <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--bg-soft)]">
                    <div className="h-full rounded-full bg-[#0071e3]" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="mt-1 text-[10px] text-[var(--muted)]">{pct}% of created</div>
                </div>
              );
            })}
          </div>
          <div className="mt-4 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--bg-soft)] p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-extrabold">Shipment custody is the next required control</div>
                <p className="mt-1 text-[12px] text-[var(--muted)]">Add tamper-seal ID, packed weight, carrier event, warehouse unboxing and IMEI re-verification before settlement.</p>
              </div>
              <span className="pill chip-yellow">Not implemented</span>
            </div>
          </div>
        </section>

        <section className="card overflow-hidden">
          <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4">
            <div>
              <h3 className="text-lg font-extrabold">Fraud & evidence queue</h3>
              <p className="text-[11px] text-[var(--muted)]">Highest-risk exceptions first</p>
            </div>
            <span className={`pill ${view.exceptions.length ? "chip-red" : "chip-green"}`}>{view.exceptions.length}</span>
          </div>
          {view.exceptions.length === 0 ? (
            <div className="p-6 text-sm text-[var(--muted)]">No open capture or review exceptions.</div>
          ) : (
            <div className="divide-y divide-[var(--border)]">
              {view.exceptions.slice(0, 8).map(({ session, level, reason }) => (
                <button key={session.id} className="flex w-full items-start gap-3 px-5 py-4 text-left hover:bg-[var(--bg-soft)]" onClick={() => onOpenSession(session.id)}>
                  <span className={`pill ${SEVERITY_TONE[level]}`} style={{ fontSize: 10 }}>{SEVERITY_LABEL[level]}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-bold">{session.model || "Unknown device"} · #{sessionAlias(session.id)}</span>
                    <span className="mt-0.5 block text-[11px] leading-4 text-[var(--muted)]">{reason}</span>
                  </span>
                  <span className="text-[12px] text-[var(--muted)]">Open →</span>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>

      <section className="card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-extrabold">Identity strength</h3>
            <p className="mt-1 text-[12px] text-[var(--muted)]">Browser signals narrow the device class; they never replace an IMEI attestation.</p>
          </div>
          <span className="pill">Evidence, not fingerprint theater</span>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-4">
          {[
            ["1. Assert", "Scan *#06# or Settings IMEI; validate checksum and TAC."],
            ["2. Corroborate", "Compare Android model hint, OS, viewport and camera capabilities."],
            ["3. Bind", "Use a session nonce plus live IMEI-screen and guided device photos."],
            ["4. Reconcile", "Re-scan IMEI and defect map when packed and when warehouse receives."],
          ].map(([title, copy]) => (
            <div key={title} className="rounded-2xl bg-[var(--bg-soft)] p-4">
              <div className="text-sm font-extrabold">{title}</div>
              <p className="mt-1 text-[12px] leading-5 text-[var(--muted)]">{copy}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
