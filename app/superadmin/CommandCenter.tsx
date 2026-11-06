"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  PieChart,
  Pie,
  Cell,
} from "recharts";
import { withBase } from "@/lib/basePath";
import { sessionAlias } from "@/lib/sessionAlias";
import {
  reachedFunnel,
  exceptions as deriveExceptions,
  STAGE_LABEL,
  type Stage,
  type SessionTag,
  type Severity,
} from "@/lib/sessionStage";
import { FUNCTIONAL_TESTS } from "@/lib/tests";
import {
  generateSummaryPdf,
  type DiagnosticSummaryData,
} from "@/lib/summaryPdf";
import type { SensorScanReport } from "@/lib/sensorScan";
import SensorScanner, { type StoreContextMetadata } from "@/app/components/SensorScanner";

type Session = {
  id: string;
  imei: string;
  phone?: string;
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
  recorded_at?: string;
  timezone?: string;
  store_id?: string;
  store_name?: string;
  created_at: string;
  updated_at: string;
  functional_summary?: { pass: number; fail: number; skip: number };
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
  diagnostics: DiagnosticSummaryData;
};

const OUTCOME_COLORS = {
  pass: "#16A34A",
  fail: "#DC2626",
  skip: "#D97706",
};

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

function emptyDiagnostics(): DiagnosticSummaryData {
  return {
    summary: { pass: 0, fail: 0, skip: 0, total: 0, sessionsTested: 0 },
    byTest: FUNCTIONAL_TESTS.map((t) => ({
      id: t.id,
      name: t.name,
      pass: 0,
      fail: 0,
      skip: 0,
      total: 0,
    })),
  };
}

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
  const [chartMode, setChartMode] = useState<"distribution" | "byTest">("distribution");
  const [latestSensorScan, setLatestSensorScan] = useState<SensorScanReport | null>(null);
  const [storeMeta, setStoreMeta] = useState<StoreContextMetadata | null>(null);

  const load = useCallback(async () => {
    setError("");
    try {
      const [sessionRes, retailRes] = await Promise.all([
        fetch(withBase(`/api/portal/sessions?client=${encodeURIComponent(clientId)}&limit=200`)),
        fetch(withBase(`/api/retail/overview?client=${encodeURIComponent(clientId)}`)),
      ]);
      if (!sessionRes.ok) throw new Error("Could not load inspections.");
      const sessionJson = await sessionRes.json();
      const sessions: Session[] = sessionJson.sessions ?? [];
      const diagnostics: DiagnosticSummaryData =
        sessionJson.diagnostics ?? emptyDiagnostics();
      const purchases = retailRes.ok ? ((await retailRes.json()).purchases ?? []) : [];
      setData({ sessions, purchases, diagnostics });
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
    const baseDiag = data?.diagnostics ?? emptyDiagnostics();

    // If no DB sessions have functional outcomes yet for this client, include
    // any live console sensor scan in the active preview so the chart is
    // immediately populated even before the operator saves the session.
    const hasDbDiag = baseDiag.summary.total > 0;
    const activeSummary =
      hasDbDiag || !latestSensorScan
        ? baseDiag.summary
        : {
            pass: latestSensorScan.summary.pass,
            fail: latestSensorScan.summary.fail,
            skip: latestSensorScan.summary.skip,
            total: latestSensorScan.summary.total,
            sessionsTested: 1,
          };

    const activeByTest =
      hasDbDiag || !latestSensorScan
        ? baseDiag.byTest
        : latestSensorScan.items.map((it) => ({
            id: it.id,
            name: it.name,
            pass: it.status === "pass" ? 1 : 0,
            fail: it.status === "fail" ? 1 : 0,
            skip: it.status === "skip" ? 1 : 0,
            total: 1,
          }));

    const distributionData = [
      {
        name: "Pass",
        outcome: "Pass",
        count: activeSummary.pass,
        fill: OUTCOME_COLORS.pass,
      },
      {
        name: "Fail",
        outcome: "Fail",
        count: activeSummary.fail,
        fill: OUTCOME_COLORS.fail,
      },
      {
        name: "Skip",
        outcome: "Skip",
        count: activeSummary.skip,
        fill: OUTCOME_COLORS.skip,
      },
    ];

    return {
      today: sessions.filter((s) => (s.created_at || s.updated_at).startsWith(today)).length,
      funnel: reachedFunnel(sessions),
      exceptions: deriveExceptions(sessions),
      diagnostics: {
        summary: activeSummary,
        byTest: activeByTest,
        isLivePreview: !hasDbDiag && !!latestSensorScan,
      },
      distributionData,
    };
  }, [data, latestSensorScan]);

  function handleDownloadPdf() {
    if (!data) return;
    const nowIso = new Date().toISOString();
    const tz =
      storeMeta?.timezone ||
      (typeof Intl !== "undefined"
        ? Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
        : "UTC");

    const latestSession = data.sessions[0];
    const resolvedMeta = {
      phone: storeMeta?.phone || latestSession?.phone || "",
      imei: storeMeta?.imei || latestSession?.imei || "",
      model: storeMeta?.model || latestSession?.model || "",
      storeId: storeMeta?.storeId || latestSession?.store_id || `${clientId}-store-01`,
      storeName: storeMeta?.storeName || latestSession?.store_name || clientId,
      storeBranch: storeMeta?.storeBranch || "Main Branch",
      storePhone: storeMeta?.storePhone || storeMeta?.phone || "",
      storeAddress: storeMeta?.storeAddress || "",
      timezone: tz,
      datetime: nowIso,
    };

    void fetch(withBase("/api/sensor-scans"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-timezone": tz,
      },
      body: JSON.stringify({
        action: "save-report",
        client: clientId === "all" ? "default" : clientId,
        sessionId: latestSession?.id || "",
        phone: resolvedMeta.phone,
        imei: resolvedMeta.imei,
        model: resolvedMeta.model,
        storeId: resolvedMeta.storeId,
        storeName: resolvedMeta.storeName,
        storeBranch: resolvedMeta.storeBranch,
        storePhone: resolvedMeta.storePhone,
        storeAddress: resolvedMeta.storeAddress,
        scannedAt: nowIso,
        timezone: tz,
        totalSessions: data.sessions.length,
        diagnostics: {
          summary: view.diagnostics.summary,
          byTest: view.diagnostics.byTest,
        },
        reportPayload: {
          inspectionsToday: view.today,
          totalSessions: data.sessions.length,
          gradesIssued: view.funnel.find((f) => f.stage === "graded")?.count ?? 0,
          openExceptions: view.exceptions.length,
          purchasesCount: data.purchases.length,
          diagnostics: view.diagnostics,
          storeMeta: resolvedMeta,
        },
      }),
    }).catch(() => {});

    generateSummaryPdf({
      clientId,
      inspectionsToday: view.today,
      totalSessions: data.sessions.length,
      gradesIssued: view.funnel.find((f) => f.stage === "graded")?.count ?? 0,
      openExceptions: view.exceptions.length,
      purchasesCount: data.purchases.length,
      funnel: view.funnel,
      diagnostics: {
        summary: view.diagnostics.summary,
        byTest: view.diagnostics.byTest,
      },
      latestSensorScan,
      storeMeta: resolvedMeta,
      sessions: data.sessions,
    });
  }

  if (!data) return <div className="card p-6 text-sm text-[var(--muted)]">{error || "Loading operations…"}</div>;

  const diagSummary = view.diagnostics.summary;
  const passRate =
    diagSummary.total > 0 ? Math.round((diagSummary.pass / diagSummary.total) * 100) : 0;

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
            <button
              className="rounded-[980px] bg-[#0071e3] px-5 py-2.5 text-[14px] font-medium text-white whitespace-nowrap shrink-0"
              onClick={onStartInspection}
            >
              Start an inspection
            </button>
            <button
              className="rounded-[980px] border border-white/25 bg-white/10 px-5 py-2.5 text-[14px] font-medium text-white hover:bg-white/15 whitespace-nowrap shrink-0"
              onClick={handleDownloadPdf}
            >
              Download Summary PDF
            </button>
            <button
              className="rounded-[980px] border border-white/25 px-5 py-2.5 text-[14px] font-medium whitespace-nowrap shrink-0"
              onClick={() => void load()}
            >
              Refresh
            </button>
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

      {/* Diagnostic Outcomes Summary Chart (Recharts) */}
      <section className="card p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h3 className="text-lg font-extrabold">
              Diagnostic outcomes distribution ({clientId === "all" ? "All clients" : clientId})
            </h3>
            <p className="mt-1 text-[12px] text-[var(--muted)]">
              Pass, Fail, and Skip distribution across functional hardware and sensor checks for the selected client.
              {view.diagnostics.isLivePreview ? " Showing live console sensor scan preview." : ""}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 rounded-xl border border-[var(--border)] bg-[var(--bg-soft)] p-1">
              <button
                type="button"
                onClick={() => setChartMode("distribution")}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                  chartMode === "distribution"
                    ? "bg-[var(--card)] text-[var(--text)] shadow-xs"
                    : "text-[var(--muted)] hover:text-[var(--text)]"
                }`}
              >
                Outcome summary
              </button>
              <button
                type="button"
                onClick={() => setChartMode("byTest")}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                  chartMode === "byTest"
                    ? "bg-[var(--card)] text-[var(--text)] shadow-xs"
                    : "text-[var(--muted)] hover:text-[var(--text)]"
                }`}
              >
                By hardware check
              </button>
            </div>
            <button
              type="button"
              onClick={handleDownloadPdf}
              className="rounded-xl border border-[var(--border)] bg-[var(--card)] px-3.5 py-2 text-xs font-semibold text-[var(--text)] hover:bg-[var(--bg-soft)] whitespace-nowrap shrink-0"
            >
              Export Summary PDF
            </button>
          </div>
        </div>

        {/* KPI Strip */}
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
          <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-soft)] p-3.5">
            <div className="text-[11px] font-semibold text-[var(--muted)]">Total checks</div>
            <div className="mt-1 text-2xl font-black tabular-nums">{diagSummary.total}</div>
          </div>
          <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-soft)] p-3.5">
            <div className="text-[11px] font-semibold text-[var(--muted)]">Passed</div>
            <div className="mt-1 text-2xl font-black tabular-nums" style={{ color: OUTCOME_COLORS.pass }}>
              {diagSummary.pass}
            </div>
          </div>
          <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-soft)] p-3.5">
            <div className="text-[11px] font-semibold text-[var(--muted)]">Failed</div>
            <div className="mt-1 text-2xl font-black tabular-nums" style={{ color: OUTCOME_COLORS.fail }}>
              {diagSummary.fail}
            </div>
          </div>
          <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-soft)] p-3.5">
            <div className="text-[11px] font-semibold text-[var(--muted)]">Skipped</div>
            <div className="mt-1 text-2xl font-black tabular-nums" style={{ color: OUTCOME_COLORS.skip }}>
              {diagSummary.skip}
            </div>
          </div>
          <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-soft)] p-3.5 col-span-2 sm:col-span-1">
            <div className="text-[11px] font-semibold text-[var(--muted)]">Pass rate</div>
            <div className="mt-1 text-2xl font-black tabular-nums">{passRate}%</div>
          </div>
        </div>

        {/* Recharts Visualization */}
        {chartMode === "distribution" ? (
          <div className="mt-5 grid items-center gap-6 lg:grid-cols-[1.25fr_.75fr]">
            <div className="h-[280px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={view.distributionData}
                  margin={{ top: 12, right: 20, left: 0, bottom: 8 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.08)" />
                  <XAxis dataKey="outcome" tick={{ fontSize: 12, fontWeight: 600 }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                  <Tooltip
                    formatter={(value: any) => [value, "Checks"]}
                    contentStyle={{
                      borderRadius: 12,
                      border: "1px solid rgba(0,0,0,0.1)",
                      fontSize: 12,
                    }}
                  />
                  <Bar dataKey="count" name="Diagnostic Checks" radius={[8, 8, 0, 0]} maxBarSize={72} isAnimationActive={false}>
                    {view.distributionData.map((entry) => (
                      <Cell key={entry.name} fill={entry.fill} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="h-[280px] w-full">
              {diagSummary.total > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={view.distributionData}
                      dataKey="count"
                      nameKey="outcome"
                      cx="50%"
                      cy="50%"
                      innerRadius={58}
                      outerRadius={92}
                      paddingAngle={3}
                      isAnimationActive={false}
                    >
                      {view.distributionData.map((entry) => (
                        <Cell key={entry.name} fill={entry.fill} />
                      ))}
                    </Pie>
                    <Tooltip
                      formatter={(value: any, name: any) => [
                        `${value} (${Math.round((Number(value) / diagSummary.total) * 100)}%)`,
                        name,
                      ]}
                      contentStyle={{
                        borderRadius: 12,
                        border: "1px solid rgba(0,0,0,0.1)",
                        fontSize: 12,
                      }}
                    />
                    <Legend verticalAlign="bottom" height={32} />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <div className="flex h-full flex-col items-center justify-center rounded-2xl border border-dashed border-[var(--border)] bg-[var(--bg-soft)] p-6 text-center">
                  <div className="text-sm font-bold text-[var(--text)]">No diagnostic outcomes recorded yet</div>
                  <p className="mt-1 max-w-xs text-xs text-[var(--muted)]">
                    Run a live hardware sensor scan below or start a device inspection to populate Pass / Fail / Skip metrics for {clientId === "all" ? "all clients" : clientId}.
                  </p>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="mt-5 h-[320px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={view.diagnostics.byTest}
                margin={{ top: 12, right: 20, left: 0, bottom: 48 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.08)" />
                <XAxis
                  dataKey="name"
                  angle={-25}
                  textAnchor="end"
                  interval={0}
                  height={64}
                  tick={{ fontSize: 11 }}
                />
                <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                <Tooltip
                  contentStyle={{
                    borderRadius: 12,
                    border: "1px solid rgba(0,0,0,0.1)",
                    fontSize: 12,
                  }}
                />
                <Legend verticalAlign="top" height={32} />
                <Bar dataKey="pass" name="Pass" stackId="a" fill={OUTCOME_COLORS.pass} radius={[0, 0, 0, 0]} isAnimationActive={false} />
                <Bar dataKey="fail" name="Fail" stackId="a" fill={OUTCOME_COLORS.fail} radius={[0, 0, 0, 0]} isAnimationActive={false} />
                <Bar dataKey="skip" name="Skip" stackId="a" fill={OUTCOME_COLORS.skip} radius={[6, 6, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>

      {/* Interactive Sensor Scan Suite */}
      <SensorScanner
        clientId={clientId}
        onScanComplete={(report, meta) => {
          setLatestSensorScan(report);
          setStoreMeta(meta);
        }}
        onSessionSaved={() => void load()}
        onMetadataChange={(meta) => setStoreMeta(meta)}
      />

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
