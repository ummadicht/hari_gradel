"use client";
import { useEffect, useState } from "react";
import { withBase } from "@/lib/basePath";
import { sessionAlias } from "@/lib/sessionAlias";
import QR from "./QR";
import ImeiScanner from "./ImeiScanner";
import GradeBadge from "./GradeBadge";
import Login from "./Login";
import { DEMOGRAPHICS, SEGMENT_LIST, Demographic } from "@/lib/profiles";
import { Account, loadAccount, clearAccount } from "@/lib/accounts";
import type { ImeiInfo } from "@/lib/imei";
import { isLiveImeiSource } from "@/lib/imeiSource";

type Session = {
  id: string;
  imei: string;
  model: string;
  status: string;
  overall_grade: string;
  functional_grade: string;
  cosmetic_grade: string;
  created_at: string;
};

export default function Dashboard() {
  const [account, setAccount] = useState<Account | null | undefined>(undefined);
  const [imei, setImei] = useState("");
  const [model, setModel] = useState("");
  const [imeiInfo, setImeiInfo] = useState<ImeiInfo | null>(null);
  const [imeiLoading, setImeiLoading] = useState(false);
  const [demographic, setDemographic] = useState<Demographic>("standard");
  const [scan, setScan] = useState(false);
  const [active, setActive] = useState<Session | null>(null);
  const [recent, setRecent] = useState<Session[]>([]);
  const [origin, setOrigin] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setOrigin(window.location.origin);
    setAccount(loadAccount() ?? null);
  }, []);

  async function load() {
    const r = await fetch(withBase("/api/sessions"));
    if (r.ok) setRecent(await r.json());
  }
  useEffect(() => {
    if (!account) return;
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [account]);

  // Live IMEI check once 15 digits are in — auto-fills model, shows status.
  useEffect(() => {
    if (imei.length !== 15) {
      setImeiInfo(null);
      return;
    }
    let cancelled = false;
    setImeiLoading(true);
    const t = setTimeout(async () => {
      try {
        const r = await fetch(withBase(`/api/imei/${imei}`));
        const info: ImeiInfo = await r.json();
        if (cancelled) return;
        setImeiInfo(info);
        if (info.model) setModel((m) => m || info.model);
      } catch {
        /* ignore */
      } finally {
        if (!cancelled) setImeiLoading(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [imei]);

  async function create() {
    if (!account) return;
    setBusy(true);
    const r = await fetch(withBase("/api/sessions"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Channel is fixed by the logged-in account — not chosen per device.
      body: JSON.stringify({ imei, model, segment: account.segment, demographic }),
    });
    setBusy(false);
    if (r.ok) {
      const s = await r.json();
      setActive({
        ...s,
        status: "open",
        overall_grade: "",
        functional_grade: "",
        cosmetic_grade: "",
      });
      setImei("");
      setModel("");
      setImeiInfo(null);
      load();
    }
  }

  // Auth gate.
  if (account === undefined) return null; // hydrating
  if (account === null)
    return <Login onLogin={() => setAccount(loadAccount() ?? null)} />;

  const seg = SEGMENT_LIST.find((s) => s.segment === account.segment)!;

  return (
    <div className="container">
      <header className="flex items-center justify-between py-2">
        <div className="flex items-center gap-3">
          <div className="brandmark h-11 w-11 text-xl">IQ</div>
          <div>
            <div className="text-xl font-extrabold">
              Grade<span className="grad-text">IQ</span>
            </div>
            <div className="text-xs text-[var(--muted)]">
              {account.emoji} {account.name}
            </div>
          </div>
        </div>
        <div className="flex gap-2">
          <a className="pill" href={withBase("/configurator")}>
            💬 Config
          </a>
          <a className="pill" href={withBase("/settings")}>
            ⚙︎
          </a>
          <button
            className="pill"
            onClick={() => {
              clearAccount();
              setAccount(null);
            }}
          >
            Sign out
          </button>
        </div>
      </header>

      {/* Channel is fixed by the account. */}
      <div className="card mt-3 flex items-center justify-between p-3">
        <div className="text-sm">
          <span className="text-[var(--muted)]">Channel</span>{" "}
          <b>{seg.label}</b>
        </div>
        <div className="flex gap-1">
          <span className="pill" style={{ fontSize: 11 }}>
            {seg.mode === "blitz" ? "⚡ Blitz" : "🎮 Gauntlet"}
          </span>
          <span className="pill" style={{ fontSize: 11 }}>
            {seg.coverage === "strict" ? "100%" : "fast"}
          </span>
          {seg.requireWipe && (
            <span className="pill" style={{ fontSize: 11 }}>
              wipe
            </span>
          )}
        </div>
      </div>

      {/* New session */}
      <section className="card mt-4 p-5">
        <h2 className="mb-1 text-lg font-bold">Start a grading session</h2>
        <p className="mb-3 text-sm text-[var(--muted)]">
          Dial <span className="mono">*#06#</span> on the device and scan/snap
          the IMEI. Then take photos, then hand it the QR to self-test.
        </p>
        <div className="flex gap-2">
          <input
            className="input mono"
            placeholder="IMEI (15 digits)"
            value={imei}
            inputMode="numeric"
            maxLength={15}
            onChange={(e) => setImei(e.target.value.replace(/[^0-9]/g, ""))}
          />
          <button className="btn btn-ghost" onClick={() => setScan(true)}>
            📷 Scan
          </button>
        </div>
        {/* IMEI check result */}
        {imei.length === 15 && (
          <div className="card mt-2 p-3">
            {imeiLoading || !imeiInfo ? (
              <div className="text-sm text-[var(--muted)]">
                🔎 Checking IMEI…
              </div>
            ) : (
              <div className="text-sm">
                <div className="flex items-center justify-between">
                  <div className="font-semibold">
                    {imeiInfo.brand} {imeiInfo.model}
                  </div>
                  <span className="pill" style={{ fontSize: 10 }}>
                    {isLiveImeiSource(imeiInfo.source) ? "IMEI API" : "TAC check"}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <span
                    className={`pill ${imeiInfo.valid ? "chip-green" : "chip-red"}`}
                    style={{ fontSize: 11 }}
                  >
                    {imeiInfo.valid ? "✓ Valid IMEI" : "✗ Bad checksum"}
                  </span>
                  <span
                    className={`pill ${
                      imeiInfo.blacklist === "clean"
                        ? "chip-green"
                        : imeiInfo.blacklist === "blacklisted"
                          ? "chip-red"
                          : "chip-yellow"
                    }`}
                    style={{ fontSize: 11 }}
                  >
                    {imeiInfo.blacklist === "clean"
                      ? "✓ Not blacklisted"
                      : imeiInfo.blacklist === "blacklisted"
                        ? "⛔ Blacklisted"
                        : "? Blacklist unknown"}
                  </span>
                  <span
                    className={`pill ${
                      imeiInfo.lock === "unlocked"
                        ? "chip-green"
                        : imeiInfo.lock === "locked"
                          ? "chip-yellow"
                          : "chip-yellow"
                    }`}
                    style={{ fontSize: 11 }}
                  >
                    {imeiInfo.lock === "unlocked"
                      ? "🔓 Unlocked"
                      : imeiInfo.lock === "locked"
                        ? "🔒 Carrier-locked"
                        : "? Lock unknown"}
                  </span>
                </div>
              </div>
            )}
          </div>
        )}

        <input
          className="input mt-2"
          placeholder="Model (optional — auto-filled from IMEI)"
          value={model}
          onChange={(e) => setModel(e.target.value)}
        />

        {/* Demographic / accessibility — the tester in front of the device. */}
        <div className="mt-4 text-xs font-bold uppercase tracking-wide text-[var(--muted)]">
          Tester profile
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          {(Object.keys(DEMOGRAPHICS) as Demographic[]).map((d) => (
            <button
              key={d}
              onClick={() => setDemographic(d)}
              className="pill"
              style={{
                borderColor:
                  demographic === d ? "var(--brand)" : "var(--border)",
              }}
            >
              {DEMOGRAPHICS[d].label}
            </button>
          ))}
        </div>

        <button className="btn mt-4 w-full" onClick={create} disabled={busy}>
          {busy ? "Creating…" : "Create session →"}
        </button>
      </section>

      {/* Active session — photos first, then game, then offer */}
      {active && origin && (
        <section className="card mt-4 p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-bold">Session started</h2>
            <span className="pill mono" title={active.id}>#{sessionAlias(active.id)}</span>
          </div>

          {/* Step 1 — photos on THIS iPad/phone */}
          <a className="btn w-full" href={withBase(`/staff/${active.id}`)}>
            ① 📸 Take photos (AI cosmetic grade)
          </a>

          {/* Step 2 — hand the QR to the device to self-test */}
          <div className="mt-3 flex items-center gap-3 rounded-2xl border border-[var(--border)] p-3">
            <QR text={`${origin}${withBase(`/s/${active.id}`)}`} size={110} />
            <div className="flex-1 text-sm">
              <div className="font-semibold">② Hand it the QR to self-test</div>
              <p className="mono mt-1 break-all text-xs text-[var(--brand-2)]">
                {origin}
                {withBase(`/s/${active.id}`)}
              </p>
            </div>
          </div>

          {/* Step 3 — the AI offer */}
          <a className="btn btn-ghost mt-3 w-full" href={withBase(`/report/${active.id}`)}>
            ③ 💸 View AI offer
          </a>
        </section>
      )}

      {/* Consumer via SwapMore app */}
      {origin && (
        <section className="card mt-4 p-5">
          <h3 className="text-sm font-bold">🙋 Consumer trade-in</h3>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Consumers don&apos;t use this console. The <b>SwapMore</b> app shows
            them this QR — it opens a self-serve trade-in straight on their phone.
          </p>
          <div className="mt-3 flex items-center gap-4">
            <QR text={`${origin}${withBase("/trade-in")}`} size={120} />
            <div className="text-sm">
              <div className="pill" style={{ background: "var(--grad-gold)" }}>
                Powered by SwapMore
              </div>
              <p className="mono mt-2 break-all text-xs text-[var(--brand-2)]">
                {origin}
                {withBase("/trade-in")}
              </p>
            </div>
          </div>
        </section>
      )}

      {/* Recent */}
      <section className="mt-6">
        <h3 className="mb-2 text-sm font-bold uppercase tracking-wide text-[var(--muted)]">
          Recent sessions
        </h3>
        <div className="flex flex-col gap-2">
          {recent.length === 0 && (
            <div className="card p-4 text-sm text-[var(--muted)]">
              No sessions yet.
            </div>
          )}
          {recent.map((s) => (
            <a
              key={s.id}
              href={withBase(`/report/${s.id}`)}
              className="card flex items-center justify-between p-4"
            >
              <div>
                <div className="font-semibold">
                  {s.model || "Unknown model"}{" "}
                  <span className="mono text-xs text-[var(--muted)]" title={s.id}>
                    #{sessionAlias(s.id)}
                  </span>
                </div>
                <div className="mono text-xs text-[var(--muted)]">
                  {s.imei || "no IMEI"} · {s.status}
                </div>
              </div>
              <GradeBadge grade={s.overall_grade} small />
            </a>
          ))}
        </div>
      </section>

      <footer className="py-8 text-center text-xs text-[var(--muted)]">
        GradeIQ · a SwapMore company · zero-install gamified grading
      </footer>

      {scan && (
        <ImeiScanner
          onResult={(v) => {
            setImei(v);
            setScan(false);
          }}
          onClose={() => setScan(false)}
        />
      )}
    </div>
  );
}
