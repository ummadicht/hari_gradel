"use client";

import { useCallback, useEffect, useState } from "react";
import { withBase } from "@/lib/basePath";
import { fetchDeviceInfo } from "@/lib/deviceFetch";
import { resolveClient } from "@/lib/clients";
import {
  SENSOR_CATALOG,
  runFullSensorScan,
  runSingleSensorScan,
  type SensorScanItem,
  type SensorScanReport,
  type SensorVerdict,
} from "@/lib/sensorScan";

const VERDICT_STYLE: Record<SensorVerdict, { label: string; color: string; bg: string }> = {
  pass: { label: "PASS", color: "#16A34A", bg: "rgba(22, 163, 74, 0.12)" },
  fail: { label: "FAIL", color: "#DC2626", bg: "rgba(220, 38, 38, 0.12)" },
  skip: { label: "SKIP", color: "#D97706", bg: "rgba(217, 119, 6, 0.14)" },
};

export type StoredSensorScanRow = {
  id: number;
  session_id: string;
  client_id: string;
  phone: string;
  imei: string;
  model: string;
  store_id: string;
  store_name: string;
  store_info: Record<string, any>;
  pass_count: number;
  fail_count: number;
  skip_count: number;
  total_count: number;
  duration_ms: number;
  scanned_at: string;
  timezone: string;
  created_at: string;
};

export type StoreContextMetadata = {
  phone: string;
  imei: string;
  model: string;
  storeId: string;
  storeName: string;
  storeBranch: string;
  storePhone: string;
  storeAddress: string;
  timezone: string;
  datetime: string;
};

function detectBrowserTimezone(): string {
  try {
    const iana = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const offsetMin = -new Date().getTimezoneOffset();
    const sign = offsetMin >= 0 ? "+" : "-";
    const abs = Math.abs(offsetMin);
    const hh = String(Math.floor(abs / 60)).padStart(2, "0");
    const mm = String(abs % 60).padStart(2, "0");
    return `${iana} (UTC${sign}${hh}:${mm})`;
  } catch {
    return "UTC";
  }
}

export default function SensorScanner({
  clientId,
  onScanComplete,
  onSessionSaved,
  onMetadataChange,
}: {
  clientId: string;
  onScanComplete?: (report: SensorScanReport, meta: StoreContextMetadata) => void;
  onSessionSaved?: (sessionId: string) => void;
  onMetadataChange?: (meta: StoreContextMetadata) => void;
}) {
  const effectiveClient = clientId === "all" ? "default" : clientId;
  const clientDef = resolveClient(effectiveClient);

  const [phone, setPhone] = useState("");
  const [imei, setImei] = useState("");
  const [model, setModel] = useState("");
  const [storeId, setStoreId] = useState(`${effectiveClient}-store-01`);
  const [storeName, setStoreName] = useState(`${clientDef.name} Counter`);
  const [storeBranch, setStoreBranch] = useState("Main Branch");
  const [storePhone, setStorePhone] = useState("");
  const [storeAddress, setStoreAddress] = useState("");
  const [timezone, setTimezone] = useState("UTC");
  const [datetime, setDatetime] = useState(() => new Date().toISOString());

  const [items, setItems] = useState<Record<string, SensorScanItem>>({});
  const [scanningId, setScanningId] = useState<string | null>(null);
  const [runningAll, setRunningAll] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedSessionId, setSavedSessionId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [lastReport, setLastReport] = useState<SensorScanReport | null>(null);
  const [history, setHistory] = useState<StoredSensorScanRow[]>([]);

  useEffect(() => {
    setTimezone(detectBrowserTimezone());
    setDatetime(new Date().toISOString());
    void fetchDeviceInfo()
      .then((info) => {
        if (info?.modelGuess) {
          setModel((prev) => prev || info.modelGuess);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const def = resolveClient(effectiveClient);
    setStoreId(`${effectiveClient}-store-01`);
    setStoreName(`${def.name} Counter`);
  }, [effectiveClient]);

  useEffect(() => {
    onMetadataChange?.({
      phone,
      imei,
      model,
      storeId,
      storeName,
      storeBranch,
      storePhone,
      storeAddress,
      timezone,
      datetime,
    });
  }, [
    phone,
    imei,
    model,
    storeId,
    storeName,
    storeBranch,
    storePhone,
    storeAddress,
    timezone,
    datetime,
    onMetadataChange,
  ]);

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch(
        withBase(`/api/sensor-scans?client=${encodeURIComponent(clientId)}&limit=10`)
      );
      if (!res.ok) return;
      const json = await res.json();
      setHistory(Array.isArray(json.scans) ? json.scans : []);
    } catch {
      /* ignore */
    }
  }, [clientId]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  async function persistToDatabase(
    report: SensorScanReport,
    existingSessionId?: string | null
  ): Promise<string | null> {
    setSaving(true);
    setError("");
    const nowIso = new Date().toISOString();
    const tz = detectBrowserTimezone();
    setDatetime(nowIso);
    setTimezone(tz);

    try {
      const deviceInfo = await fetchDeviceInfo().catch(() => null);
      const resolvedModel = model.trim() || deviceInfo?.modelGuess || "Console Sensor Probe";
      if (!model.trim() && deviceInfo?.modelGuess) {
        setModel(deviceInfo.modelGuess);
      }

      const res = await fetch(withBase("/api/sensor-scans"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-timezone": tz,
        },
        body: JSON.stringify({
          client: effectiveClient,
          sessionId: existingSessionId || savedSessionId || "",
          createSession: true,
          phone: phone.trim(),
          imei: imei.replace(/\D/g, "").slice(0, 15),
          model: resolvedModel,
          storeId: storeId.trim() || `${effectiveClient}-store-01`,
          storeName: storeName.trim() || `${clientDef.name} Counter`,
          storeBranch: storeBranch.trim() || "Main Branch",
          storePhone: storePhone.trim() || phone.trim(),
          storeAddress: storeAddress.trim(),
          scannedAt: nowIso,
          timezone: tz,
          report,
          deviceInfo,
        }),
      });
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || "Could not store sensor scan in database.");
      }
      const json = await res.json();
      const sid = String(json.sessionId || "");
      if (sid) {
        setSavedSessionId(sid);
        onSessionSaved?.(sid);
      }
      await loadHistory();
      return sid;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save sensor scan to database.");
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function handleRunAll() {
    setRunningAll(true);
    setError("");
    const nowIso = new Date().toISOString();
    const tz = detectBrowserTimezone();
    setDatetime(nowIso);
    setTimezone(tz);

    try {
      const report = await runFullSensorScan((item) => {
        setItems((prev) => ({ ...prev, [item.id]: item }));
      });
      setLastReport(report);
      onScanComplete?.(report, {
        phone,
        imei,
        model,
        storeId,
        storeName,
        storeBranch,
        storePhone,
        storeAddress,
        timezone: tz,
        datetime: nowIso,
      });
      // Automatically persist scan + phone + imei + datetime + timezone + store info to DB tables
      await persistToDatabase(report, null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sensor scan failed.");
    } finally {
      setRunningAll(false);
    }
  }

  async function handleRunSingle(sensorId: string) {
    setScanningId(sensorId);
    setError("");
    const nowIso = new Date().toISOString();
    const tz = detectBrowserTimezone();
    setDatetime(nowIso);
    setTimezone(tz);

    try {
      const item = await runSingleSensorScan(sensorId);
      const nextItems = { ...items, [sensorId]: item };
      setItems(nextItems);

      const list = Object.values(nextItems);
      let pass = 0;
      let fail = 0;
      let skip = 0;
      const functionalMap: Record<string, SensorVerdict> = {};
      for (const it of list) {
        if (it.status === "pass") pass++;
        else if (it.status === "fail") fail++;
        else skip++;
        functionalMap[it.id] = it.status;
        functionalMap[it.functionalKey] = it.status;
      }
      const report: SensorScanReport = {
        scannedAt: nowIso,
        totalDurationMs: item.durationMs,
        summary: { pass, fail, skip, total: list.length },
        items: list,
        functionalMap,
      };
      setLastReport(report);
      onScanComplete?.(report, {
        phone,
        imei,
        model,
        storeId,
        storeName,
        storeBranch,
        storePhone,
        storeAddress,
        timezone: tz,
        datetime: nowIso,
      });
      await persistToDatabase(report, savedSessionId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not scan sensor.");
    } finally {
      setScanningId(null);
    }
  }

  const scannedList = SENSOR_CATALOG.map((c) => items[c.id]).filter(Boolean);
  const passCount = scannedList.filter((i) => i.status === "pass").length;
  const failCount = scannedList.filter((i) => i.status === "fail").length;
  const skipCount = scannedList.filter((i) => i.status === "skip").length;

  return (
    <section className="card p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className="text-lg font-extrabold">Hardware & Browser Sensor Scan</h3>
          <p className="mt-1 text-[12px] text-[var(--muted)]">
            Probes hardware sensors and automatically stores results, phone, IMEI, date/time, timezone, and store metadata into the database tables.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="rounded-xl bg-[#1d1d1f] px-4 py-2 text-xs font-semibold text-white whitespace-nowrap shrink-0 disabled:opacity-50"
            onClick={() => void handleRunAll()}
            disabled={runningAll || scanningId !== null || saving}
          >
            {runningAll ? "Scanning & Saving…" : "Run Full Sensor Scan"}
          </button>
          {lastReport && (
            <button
              type="button"
              className="rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-2 text-xs font-semibold text-[var(--text)] whitespace-nowrap shrink-0 hover:bg-[var(--bg-soft)] disabled:opacity-50"
              onClick={() => void persistToDatabase(lastReport, savedSessionId)}
              disabled={saving}
            >
              {saving ? "Saving to DB…" : "Update Database Record"}
            </button>
          )}
        </div>
      </div>

      {/* Device, Phone, IMEI, Timezone & Store Metadata Form */}
      <div className="mt-4 rounded-2xl border border-[var(--border)] bg-[var(--bg-soft)] p-4">
        <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
          <span className="text-[11px] font-bold uppercase tracking-wide text-[var(--muted)]">
            Session, Device & Store Metadata (Persisted to DB Tables)
          </span>
          <span className="text-[11px] font-medium text-[var(--muted)] tabular-nums">
            {datetime.slice(0, 19).replace("T", " ")} · {timezone}
          </span>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className="block text-[11px] font-semibold text-[var(--muted)]">
              Customer / Device Phone
            </label>
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+91 98765 43210"
              className="input mt-1 w-full text-xs"
            />
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-[var(--muted)]">
              IMEI (15 digits)
            </label>
            <input
              type="text"
              inputMode="numeric"
              maxLength={15}
              value={imei}
              onChange={(e) => setImei(e.target.value.replace(/\D/g, "").slice(0, 15))}
              placeholder="356789012345678"
              className="input mt-1 w-full font-mono text-xs"
            />
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-[var(--muted)]">
              Phone Model
            </label>
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="e.g. iPhone 15 Pro"
              className="input mt-1 w-full text-xs"
            />
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-[var(--muted)]">
              Timezone
            </label>
            <input
              type="text"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              placeholder="Asia/Kolkata (UTC+05:30)"
              className="input mt-1 w-full text-xs"
            />
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-[var(--muted)]">
              Store ID / Code
            </label>
            <input
              type="text"
              value={storeId}
              onChange={(e) => setStoreId(e.target.value)}
              placeholder="swapmore-in-store-01"
              className="input mt-1 w-full font-mono text-xs"
            />
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-[var(--muted)]">
              Store Name
            </label>
            <input
              type="text"
              value={storeName}
              onChange={(e) => setStoreName(e.target.value)}
              placeholder="SwapMore India Counter"
              className="input mt-1 w-full text-xs"
            />
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-[var(--muted)]">
              Store Branch / City
            </label>
            <input
              type="text"
              value={storeBranch}
              onChange={(e) => setStoreBranch(e.target.value)}
              placeholder="Mumbai — Andheri West"
              className="input mt-1 w-full text-xs"
            />
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-[var(--muted)]">
              Store Contact / Address
            </label>
            <input
              type="text"
              value={storeAddress}
              onChange={(e) => setStoreAddress(e.target.value)}
              placeholder="Counter #4 / Store phone"
              className="input mt-1 w-full text-xs"
            />
          </div>
        </div>
      </div>

      {error && (
        <p className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-700">
          {error}
        </p>
      )}

      {savedSessionId && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-2 text-xs text-emerald-800">
          <span>
            Stored in <strong className="mono">sessions</strong>, <strong className="mono">sensor_scans</strong>, and <strong className="mono">stores</strong> tables · Session <strong className="mono">{savedSessionId.slice(0, 8)}</strong> ({timezone})
          </span>
          <a
            href={withBase(`/report/${savedSessionId}`)}
            className="font-semibold underline whitespace-nowrap"
          >
            View report →
          </a>
        </div>
      )}

      {scannedList.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-4 border-b border-[var(--border)] pb-3 text-xs text-[var(--muted)] tabular-nums">
          <span>
            Scanned: <strong className="text-[var(--text)]">{scannedList.length} / {SENSOR_CATALOG.length}</strong>
          </span>
          <span aria-hidden="true">·</span>
          <span>
            Pass: <strong style={{ color: "#16A34A" }}>{passCount}</strong>
          </span>
          <span aria-hidden="true">·</span>
          <span>
            Fail: <strong style={{ color: "#DC2626" }}>{failCount}</strong>
          </span>
          <span aria-hidden="true">·</span>
          <span>
            Skip: <strong style={{ color: "#D97706" }}>{skipCount}</strong>
          </span>
        </div>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {SENSOR_CATALOG.map((sensor) => {
          const result = items[sensor.id];
          const isScanning = scanningId === sensor.id || (runningAll && !result);
          const badge = result ? VERDICT_STYLE[result.status] : null;

          return (
            <div
              key={sensor.id}
              className="flex flex-col justify-between rounded-2xl border border-[var(--border)] bg-[var(--bg-soft)] p-3.5"
            >
              <div>
                <div className="flex items-start justify-between gap-2">
                  <div className="text-xs font-bold text-[var(--text)]">{sensor.name}</div>
                  {badge ? (
                    <span
                      className="rounded px-1.5 py-0.5 text-[10px] font-bold tabular-nums shrink-0"
                      style={{ color: badge.color, background: badge.bg }}
                    >
                      {badge.label}
                    </span>
                  ) : (
                    <span className="text-[10px] font-medium text-[var(--muted)] shrink-0">
                      {sensor.category}
                    </span>
                  )}
                </div>
                <div className="mt-1 text-[11px] text-[var(--muted)]">{sensor.api}</div>
                <div className="mt-2.5 min-h-[32px] text-xs font-medium text-[var(--text)] tabular-nums">
                  {isScanning ? (
                    <span className="text-[var(--muted)]">Probing sensor…</span>
                  ) : result ? (
                    result.reading
                  ) : (
                    <span className="text-[var(--muted)]">Not scanned yet</span>
                  )}
                </div>
              </div>

              <div className="mt-3 flex items-center justify-between border-t border-[var(--border)] pt-2.5">
                <span className="text-[10px] text-[var(--muted)] tabular-nums">
                  {result ? `${result.durationMs} ms` : "Idle"}
                </span>
                <button
                  type="button"
                  className="text-xs font-semibold text-[#0071e3] hover:underline whitespace-nowrap disabled:opacity-40"
                  onClick={() => void handleRunSingle(sensor.id)}
                  disabled={runningAll || scanningId !== null || saving}
                >
                  {result ? "Re-scan" : "Scan"}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Stored Sensor Scans Database Table */}
      {history.length > 0 && (
        <div className="mt-5 border-t border-[var(--border)] pt-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-extrabold text-[var(--text)]">
              Recent Database Records (<span className="mono">sensor_scans</span> table · {history.length})
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-[var(--border)] text-[10px] uppercase tracking-wide text-[var(--muted)]">
                <tr>
                  <th className="py-2 pr-3">ID / Session</th>
                  <th className="py-2 pr-3">Phone</th>
                  <th className="py-2 pr-3">IMEI</th>
                  <th className="py-2 pr-3">Model</th>
                  <th className="py-2 pr-3">Store</th>
                  <th className="py-2 pr-3">P / F / S</th>
                  <th className="py-2 pr-3">Date / Time</th>
                  <th className="py-2">Timezone</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {history.map((h) => (
                  <tr key={h.id} className="tabular-nums">
                    <td className="py-2 pr-3 font-mono text-[11px]">
                      #{h.id} · {h.session_id ? h.session_id.slice(0, 8) : "—"}
                    </td>
                    <td className="py-2 pr-3">{h.phone || "—"}</td>
                    <td className="py-2 pr-3 font-mono text-[11px]">{h.imei || "—"}</td>
                    <td className="py-2 pr-3">{h.model || "—"}</td>
                    <td className="py-2 pr-3">
                      <span className="font-semibold">{h.store_name || h.store_id || "—"}</span>
                      {h.store_info?.branch ? (
                        <span className="text-[var(--muted)]"> · {h.store_info.branch}</span>
                      ) : null}
                    </td>
                    <td className="py-2 pr-3 font-semibold">
                      <span style={{ color: "#16A34A" }}>{h.pass_count}</span>
                      {" / "}
                      <span style={{ color: "#DC2626" }}>{h.fail_count}</span>
                      {" / "}
                      <span style={{ color: "#D97706" }}>{h.skip_count}</span>
                    </td>
                    <td className="py-2 pr-3 text-[11px] text-[var(--muted)]">
                      {(h.scanned_at || h.created_at).slice(0, 19).replace("T", " ")}
                    </td>
                    <td className="py-2 text-[11px] text-[var(--muted)]">{h.timezone || "UTC"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
