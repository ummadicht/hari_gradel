"use client";
import { useCallback, useEffect, useState } from "react";
import { withBase } from "@/lib/basePath";

/**
 * Re-grade the WHOLE report — pinned to the top, above everything it affects.
 *
 * It used to sit halfway down inside the AI-inspection card, which framed it as
 * "re-run the vision bit". But a re-grade moves the condition, the identity, the
 * diagnostics, the overall grade AND the price, so it belongs above all of them,
 * stating up front what it will refresh and what it cannot.
 *
 * Operator-only. The API enforces that independently — this component just
 * doesn't render for a consumer.
 */

type Run = {
  id: number;
  grade: string;
  tier: string;
  escalated: boolean;
  score: number | null;
  findings: number;
  review: boolean;
  trigger: string;
  actor: string;
  at: string;
};

type CaptureCheck = {
  ok: boolean;
  code: string;
  reasons: string[];
  blurryIndexes: number[];
  distinctViews: number;
  photos: number;
};

type Result = {
  refreshed: string[];
  captureCheck?: CaptureCheck;
  notRefreshed: string[];
  trust?: { score?: number; grade?: string; identity?: string };
  /** Present when Pro was requested but Flash actually graded (quota). */
  degraded?: string | null;
  tierRequested?: string;
  before: { grade?: string; tierUsed?: string; score?: number; findings?: number };
  after: { grade?: string; tierUsed?: string; score?: number; findings?: number; needsHumanReview?: boolean };
  diff: {
    changed: boolean;
    from: string;
    to: string;
    direction: "better" | "worse" | "same" | "unknown";
    findingsFrom: number;
    findingsTo: number;
    components: { id: string; from: string; to: string }[];
  };
  offer?: { value?: number; currency?: string; blocked?: boolean };
  overall?: string;
};

const SYM: Record<string, string> = { USD: "$", INR: "₹", EUR: "€" };
const money = (v?: number, c?: string) =>
  typeof v === "number" ? `${SYM[c || "USD"] || ""}${Math.round(v).toLocaleString("en-US")}` : "—";

export default function RegradeBar({
  sessionId,
  overall,
  trustScore,
  lastGraded,
  tierUsed,
  proOnly,
  onDone,
  unfinished,
}: {
  sessionId: string;
  overall: string;
  /** Omit in the console, where the detail payload doesn't carry it. */
  trustScore?: number;
  lastGraded: string;
  tierUsed?: string;
  /** Pro-only mode: Flash is switched off, so no tier choice is offered. */
  proOnly?: boolean;
  /** When set (SPA console), refresh in place instead of a full page reload. */
  onDone?: (result: Result) => void;
  /**
   * SUP-63: the stored grade claims `refining` but the background work died
   * (lib/refineStatus.ts). The bar then leads with "Grading did not finish":
   * this re-grade is the way out, so it is the first thing staff see.
   */
  unfinished?: { since: string | null; afterMinutes: number };
}) {
  const [tier, setTier] = useState<"pro" | "flash">("pro");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [res, setRes] = useState<Result | null>(null);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  const loadRuns = useCallback(() => {
    fetch(withBase(`/api/sessions/${sessionId}/runs`))
      .then((r) => (r.ok ? r.json() : { runs: [] }))
      .then((d) => setRuns(d.runs || []))
      .catch(() => setRuns([]));
  }, [sessionId]);
  useEffect(loadRuns, [loadRuns]);

  async function run() {
    setBusy(true);
    setErr("");
    setRes(null);
    try {
      const r = await fetch(withBase(`/api/sessions/${sessionId}/reprocess`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tier }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        // A silent no-op after a 40-second wait reads as "re-graded, nothing
        // changed" — a completely different claim from "it never answered".
        setErr(d.error || `Re-grade failed (${r.status}).`);
        return;
      }
      setRes(d);
      loadRuns();
      onDone?.(d);
    } catch {
      setErr("Couldn't reach the grading service — nothing was changed.");
    } finally {
      setBusy(false);
    }
  }

  const dirChip =
    !res || !res.diff.changed
      ? ""
      : res.diff.direction === "worse"
        ? "chip-red"
        : res.diff.direction === "better"
          ? "chip-green"
          : "chip-yellow";

  return (
    <section className="card mt-3 p-4" style={{ borderColor: "var(--brand)" }}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          {unfinished && !res && (
            <div
              className="mb-2 rounded-xl px-3 py-2 text-[13px]"
              style={{ background: "rgba(220,38,38,0.08)" }}
              role="status"
            >
              <b>Grading did not finish.</b>{" "}
              {unfinished.since ? `The background grade started ${unfinished.since} and ` : "The background grade "}
              no result came back within {unfinished.afterMinutes} minutes. Nothing is still working on
              it, so waiting will not change it. Re-grade to settle it.
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[15px] font-bold">Re-grade this report</h2>
            <span className="pill" style={{ fontSize: 10 }}>operator</span>
            {runs && runs.length > 0 && (
              <button
                className="pill"
                style={{ fontSize: 10 }}
                onClick={() => setShowHistory((v) => !v)}
              >
                {runs.length} run{runs.length === 1 ? "" : "s"} {showHistory ? "▴" : "▾"}
              </button>
            )}
          </div>
          <p className="mt-1 text-[12px] text-[var(--muted)]">
            Re-checks the stored images against the current capture bar, re-runs every
            cosmetic check on them, and refreshes{" "}
            <b>condition, identity, diagnostics, overall grade and price</b> together.
            Functional test results stay as measured — those need the device.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {proOnly ? (
            /* Flash is switched off for this operator, so don't offer a choice
               that the server will only override — show what will actually run. */
            <span className="pill" style={{ fontSize: 11 }} title="Flash is disabled — every grade runs on Pro">
              Pro only
            </span>
          ) : (
            <select
              className="input"
              style={{ maxWidth: 130, padding: "6px 8px", fontSize: 12 }}
              value={tier}
              onChange={(e) => setTier(e.target.value as "pro" | "flash")}
              disabled={busy}
              aria-label="Model tier"
            >
              <option value="pro">Pro (settle)</option>
              <option value="flash">Flash (quick)</option>
            </select>
          )}
          <button
            className="btn"
            style={{ padding: "9px 16px", fontSize: 13 }}
            onClick={run}
            disabled={busy}
          >
            {busy ? "Re-grading…" : unfinished && !res ? "↻ Re-grade now" : "↻ Re-grade everything"}
          </button>
        </div>
      </div>

      {/* Where the record stands right now — so the operator can see what they
          are about to replace without scrolling. */}
      <div className="mt-3 flex flex-wrap gap-2 text-[12px]">
        <Chip label="Overall" value={overall || "—"} />
        {typeof trustScore === "number" && <Chip label="Trust" value={`${trustScore}/100`} />}
        <Chip label="Graded by" value={tierUsed || "—"} />
        <Chip label="Last updated" value={lastGraded} />
      </div>

      {busy && (
        <p className="mt-3 text-[12px] text-[var(--muted)]">
          Inspecting every stored angle{tier === "pro" ? " on Pro" : " on Flash"} — this takes
          around {tier === "pro" ? "30–60" : "10–20"} seconds. Nothing is changed until it finishes.
        </p>
      )}

      {err && (
        <div className="mt-3 rounded-2xl px-4 py-3 text-[13px]" style={{ background: "rgba(220,38,38,0.10)" }}>
          <b>Not re-graded.</b> {err}
        </div>
      )}

      {res && (
        <div className="mt-3 rounded-2xl border border-[var(--border)] p-4">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-bold uppercase tracking-wide text-[var(--muted)]">
              Re-grade result
            </span>
            <span className={`pill ${dirChip}`} style={{ fontSize: 10, fontWeight: 800 }}>
              {res.diff.changed ? `${res.diff.from || "—"} → ${res.diff.to || "—"}` : "condition unchanged"}
            </span>
            <span className={`pill ${res.degraded ? "chip-red" : ""}`} style={{ fontSize: 10 }}>
              {res.after.tierUsed}
              {res.degraded ? ` (you asked for ${res.tierRequested})` : ""}
            </span>
            {res.after.needsHumanReview && (
              <span className="pill chip-yellow" style={{ fontSize: 10 }}>needs review</span>
            )}
          </div>

          {/* A cheaper tier answered than the one requested. Say so loudly: the
              letter below is a quick-tier opinion, not the settled grade the
              operator asked for, and the two genuinely disagree on this kind of
              device (Flash reports no findings where Pro reports several). */}
          {res.degraded && (
            <div
              className="mb-2 rounded-xl px-3 py-2 text-[12px] font-semibold"
              style={{ background: "rgba(220,38,38,0.08)", color: "var(--bad)" }}
            >
              ⚠ {res.degraded}
            </div>
          )}

          {/* The photos themselves, re-checked against the CURRENT capture bar.
              A grade drawn from photos that no longer qualify is reported as
              exactly that, rather than presented as a clean result. */}
          {res.captureCheck && !res.captureCheck.ok && (
            <div className="mb-3 rounded-xl px-3 py-2 text-[12px]" style={{ background: "rgba(251,191,36,0.14)" }}>
              <b>⚑ These photos are below the current capture standard.</b>{" "}
              {res.captureCheck.reasons.join(" ")}
              {res.captureCheck.blurryIndexes?.length
                ? ` Blurred angle${res.captureCheck.blurryIndexes.length === 1 ? "" : "s"}: ${res.captureCheck.blurryIndexes
                    .map((i) => i + 1)
                    .join(", ")}.`
                : ""}{" "}
              The grade below still comes from them — re-shoot for a reliable one.
            </div>
          )}
          {res.captureCheck?.ok && (
            <div className="mb-3 text-[11px] text-[var(--muted)]">
              ✓ Images re-checked: {res.captureCheck.photos} photos, {res.captureCheck.distinctViews} distinct
              views, all sharp enough for today&apos;s bar.
            </div>
          )}

          <div className="grid gap-2 text-[13px] sm:grid-cols-4">
            <Stat label="Cosmetic" from={res.before.grade} to={res.after.grade} />
            <Stat label="Overall" from={undefined} to={res.overall} />
            <Stat label="Findings" from={res.diff.findingsFrom} to={res.diff.findingsTo} />
            <Stat
              label="Offer"
              from={undefined}
              to={res.offer?.blocked ? "on hold" : money(res.offer?.value, res.offer?.currency)}
            />
          </div>

          {res.diff.components.length > 0 && (
            <ul className="mt-2 space-y-1 text-[12px] text-[var(--muted)]">
              {res.diff.components.map((c) => (
                <li key={c.id}>
                  • <b className="capitalize">{c.id}</b>: {c.from || "not assessed"} → {c.to || "not assessed"}
                </li>
              ))}
            </ul>
          )}

          <p className="mt-2 text-[11px] text-[var(--muted)]">
            Refreshed: {res.refreshed.join(", ")}
            {res.notRefreshed?.length ? ` · unchanged: ${res.notRefreshed.join(", ")}` : ""}
            {res.trust?.score != null ? ` · trust now ${res.trust.score}/100` : ""}
          </p>

          <button
            className="btn mt-3"
            style={{ padding: "8px 14px", fontSize: 12 }}
            onClick={() => (onDone ? onDone(res) : window.location.reload())}
          >
            {onDone ? "Refresh this session" : "Reload the report with these results"}
          </button>
        </div>
      )}

      {showHistory && runs && runs.length > 0 && (
        <div className="mt-3" style={{ overflowX: "auto" }}>
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wide text-[var(--muted)]">
                <th className="py-1 pr-3">When</th>
                <th className="py-1 pr-3">Grade</th>
                <th className="py-1 pr-3">Tier</th>
                <th className="py-1 pr-3">Score</th>
                <th className="py-1 pr-3">Findings</th>
                <th className="py-1 pr-3">Trigger</th>
                <th className="py-1 pr-3">By</th>
              </tr>
            </thead>
            <tbody>
              {[...runs].reverse().map((r) => (
                <tr key={r.id} className="border-t border-[var(--border)]">
                  <td className="whitespace-nowrap py-1 pr-3 text-[var(--muted)]">{r.at}</td>
                  <td className="py-1 pr-3 font-bold">{r.grade || "—"}</td>
                  <td className="py-1 pr-3">
                    {r.tier}
                    {r.escalated ? " ↑" : ""}
                  </td>
                  <td className="py-1 pr-3">{r.score != null ? Math.round(r.score) : "—"}</td>
                  <td className="py-1 pr-3">{r.findings}</td>
                  <td className="py-1 pr-3">{r.trigger}</td>
                  <td className="py-1 pr-3 text-[var(--muted)]">{r.actor || "flow"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Chip({ label, value }: { label: string; value: string }) {
  return (
    <span className="rounded-lg border border-[var(--border)] px-2.5 py-1">
      <span className="text-[10px] uppercase tracking-wide text-[var(--muted)]">{label}</span>{" "}
      <b>{value}</b>
    </span>
  );
}

function Stat({ label, from, to }: { label: string; from?: string | number; to?: string | number }) {
  const moved = from !== undefined && String(from) !== String(to);
  return (
    <div className="rounded-xl border border-[var(--border)] px-3 py-2">
      <div className="text-[10px] font-bold uppercase tracking-wide text-[var(--muted)]">{label}</div>
      <div className="mt-0.5">
        {moved && <span className="text-[var(--muted)] line-through">{String(from || "—")}</span>}{" "}
        <b>{String(to ?? "—")}</b>
      </div>
    </div>
  );
}
