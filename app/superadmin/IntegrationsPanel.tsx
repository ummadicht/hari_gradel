"use client";
import { useEffect, useState } from "react";
import { withBase } from "@/lib/basePath";

// Platform integrations, INSIDE the console (was a separate /settings page with
// its own trip out of the portal). Reads need staff auth; writes are super-admin
// only and the API enforces that independently — a client admin sees the state
// of the platform they run on but cannot change it.

const FIELDS = [
  { id: "gemini_key", label: "Gemini API key", hint: "Google AI Studio → API keys. Used when the provider is Gemini (3.1 Pro).", secret: true },
  { id: "kimi_key", label: "Kimi (Moonshot) API key", hint: "platform.kimi.ai → API keys. Used when the provider is Kimi (K3).", secret: true },
  { id: "phonecheck_url", label: "Phonecheck API URL", hint: "Default: https://clientapiv2.phonecheck.com", secret: false },
  { id: "phonecheck_username", label: "Phonecheck username", hint: "Your Phonecheck account username.", secret: false },
  { id: "phonecheck_key", label: "Phonecheck API key (Apikey)", hint: "Cloud Portal → General Settings → API Key. Covers BOTH the station database and the GSMA registry (make, model, lost/stolen for any IMEI).", secret: true },
  // Everything below is ONLY needed for SIM lock and iCloud/Find My. Make,
  // model and blacklist already work on the Apikey above — the old copy here
  // implied the opposite, which is why this looked mandatory.
  { id: "phonecheck_v2_password", label: "Phonecheck account password (optional)", hint: "Adds SIM-lock + iCloud/Find My via api.phonecheck.com, which the API key cannot reach. Its tokens expire every 24h, so GradeIQ signs in and refreshes them itself. Leave blank to run without lock status.", secret: true },
  { id: "phonecheck_v2_api_token", label: "Phonecheck v2 API token (optional)", hint: "Preferred over the password if Phonecheck support issues you one — revocable on its own.", secret: true },
  { id: "phonecheck_v2_token", label: "Phonecheck v2 JWT (testing only)", hint: "A hand-pasted token. Expires within 24 hours — not for permanent use.", secret: true },
  { id: "imei_url", label: "IMEI API URL", hint: "imeicheck.com / imei.info style endpoint.", secret: false },
  { id: "imei_key", label: "IMEI API key", hint: "", secret: true },
];

export default function IntegrationsPanel({ isSuper }: { isSuper: boolean }) {
  const [status, setStatus] = useState<Record<string, any>>({});
  const [values, setValues] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState("");

  async function load() {
    const r = await fetch(withBase("/api/settings"));
    if (r.ok) setStatus(await r.json());
  }
  useEffect(() => {
    load();
  }, []);

  async function save() {
    setErr("");
    const r = await fetch(withBase("/api/settings"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    });
    if (!r.ok) {
      setErr(r.status === 403 ? "Super admin only." : "Save failed.");
      return;
    }
    setValues({});
    setSaved(true);
    load();
    setTimeout(() => setSaved(false), 2000);
  }

  const provider = (values.vision_provider ?? status.vision_provider?.preview ?? "gemini") || "gemini";

  return (
    <div className="flex flex-col gap-4 pb-24">
      {!isSuper && (
        <div className="card p-4 text-[13px] text-[var(--muted)]">
          These are <b>platform-wide</b> settings shared by every client — read-only for client admins.
        </div>
      )}

      {/* Provider switch */}
      <section className="card p-5">
        <h2 className="text-lg font-bold">AI vision provider</h2>
        <p className="mb-3 text-[12px] text-[var(--muted)]">
          Which model inspects the photos. The other stays a fallback if the chosen one is briefly unavailable.
        </p>
        <div className="flex flex-wrap gap-2">
          {[
            { id: "gemini", label: "Gemini 3.1 Pro", needs: "gemini_key" },
            { id: "kimi", label: "Kimi K3", needs: "kimi_key" },
          ].map((p) => {
            const active = provider === p.id;
            const keyReady = status[p.needs]?.set;
            return (
              <button
                key={p.id}
                disabled={!isSuper}
                onClick={() => setValues((v) => ({ ...v, vision_provider: p.id }))}
                className="pill"
                style={{
                  minWidth: 180,
                  padding: "10px 14px",
                  fontWeight: 700,
                  textAlign: "left",
                  opacity: isSuper ? 1 : 0.6,
                  border: active ? "2px solid var(--brand)" : "1px solid var(--border)",
                  background: active ? "color-mix(in oklch, var(--brand) 10%, transparent)" : "transparent",
                }}
              >
                {p.label}
                <span style={{ display: "block", fontSize: 10, fontWeight: 500, opacity: 0.7 }}>
                  {keyReady ? "key set ✓" : "no key yet"}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {/* Paid IMEI lookups today (lib/lookupBudget.ts) */}
      {status.paidLookups && (
        <section className="card p-5">
          <h2 className="text-lg font-bold">Paid IMEI lookups today</h2>
          <p className="mb-3 text-[12px] text-[var(--muted)]">
            Phonecheck calls made since midnight UTC ({status.paidLookups.day}). A repeat of the same IMEI within 24 hours
            is free. SwapUp, CounterIQ (with its retail key) and staff are never limited. Callers without a key — a
            client&apos;s embed, a retail desk that sends no key — get {status.paidLookups.cap} per address and{" "}
            {status.paidLookups.totalCap ?? "?"} between them per day; past that, and for anyone else, the session is
            created without a lookup and its identity shows as unverified.
          </p>
          <div className="flex flex-wrap gap-2 text-[13px]">
            <span className="pill chip-green">{status.paidLookups.total} paid</span>
            <span className="pill">SwapUp server {status.paidLookups.byCaller?.server ?? 0}</span>
            <span className="pill">CounterIQ (retail key) {status.paidLookups.byCaller?.retail ?? 0}</span>
            <span className="pill">Staff {status.paidLookups.byCaller?.staff ?? 0}</span>
            <span className={`pill ${status.paidLookups.totalReached ? "chip-yellow" : ""}`}>
              Embed / no key {status.paidLookups.byCaller?.channel ?? 0}
              {status.paidLookups.totalReached ? " · daily total reached" : ""}
            </span>
            <span className={`pill ${status.paidLookups.skipped ? "chip-yellow" : ""}`}>
              {status.paidLookups.skipped} held back
              {status.paidLookups.ipsAtCap ? ` · ${status.paidLookups.ipsAtCap} address(es) at the daily limit` : ""}
            </span>
          </div>
        </section>
      )}

      {/* Keys */}
      <div className="grid gap-3 xl:grid-cols-2">
        {FIELDS.map((f) => {
          const st = status[f.id];
          return (
            <div key={f.id} className="card p-4">
              <div className="mb-1 flex items-center justify-between gap-2">
                <label className="text-[14px] font-semibold">{f.label}</label>
                <span className={`pill ${st?.set ? "chip-green" : "chip-yellow"}`} style={{ fontSize: 11 }}>
                  {st?.set ? `set · ${st.preview}` : "not set"}
                </span>
              </div>
              {f.hint && <p className="mb-2 text-[11px] text-[var(--muted)]">{f.hint}</p>}
              <input
                className="input"
                type={f.secret ? "password" : "text"}
                disabled={!isSuper}
                placeholder={st?.set ? "•••••• (leave blank to keep)" : "Not set"}
                value={values[f.id] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.value }))}
              />
            </div>
          );
        })}
      </div>

      {isSuper && (Object.keys(values).length > 0 || saved) && (
        <div className="fixed bottom-5 right-5 z-40 flex items-center gap-3 rounded-2xl border border-[var(--border)] bg-[var(--card)] px-4 py-3 shadow-xl">
          <span className="text-[13px] text-[var(--muted)]">{saved ? "Saved ✓" : "Unsaved changes"}</span>
          {!saved && <button className="btn" onClick={save}>Save integrations</button>}
          {err && <span className="text-[13px] text-[var(--bad)]">{err}</span>}
        </div>
      )}
    </div>
  );
}
