"use client";
import { useCallback, useEffect, useState } from "react";
import { withBase } from "@/lib/basePath";
import {
  CURRENCY_SYMBOL,
  FAULT_IDS,
  FAULT_LABELS,
  GRADES,
  money,
  type StoredCatalog,
} from "@/lib/priceCatalogTypes";

// Grade & fault pricing catalog editor — the money model behind every offer,
// per client and in that client's own currency. Everything here is what the
// offer engine actually multiplies by; nothing is converted between currencies.

export default function CatalogPanel({ clientId }: { clientId: string }) {
  const [cat, setCat] = useState<StoredCatalog | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  const load = useCallback(() => {
    setCat(null);
    setDirty(false);
    setMsg("");
    fetch(withBase(`/api/portal/catalog?client=${clientId}`))
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((d) => setCat(d.catalog))
      .catch(() => setMsg("Could not load this client's catalog."));
  }, [clientId]);
  useEffect(load, [load]);

  if (!cat) {
    return <section className="card p-5 text-sm text-[var(--muted)]">{msg || "Loading catalog…"}</section>;
  }

  const sym = CURRENCY_SYMBOL[cat.currency];
  const set = (patch: Partial<StoredCatalog>) => {
    setCat({ ...cat, ...patch });
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    const r = await fetch(withBase(`/api/portal/catalog?client=${clientId}`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ catalog: cat }),
    });
    const d = await r.json().catch(() => ({}));
    setSaving(false);
    if (r.ok) {
      setCat(d.catalog);
      setDirty(false);
      setMsg(`Saved — every offer for ${clientId} now prices from this catalog.`);
    } else {
      setMsg(d.error || "Save failed.");
    }
  };

  const reset = async () => {
    setSaving(true);
    const r = await fetch(withBase(`/api/portal/catalog?client=${clientId}`), { method: "DELETE" });
    const d = await r.json().catch(() => ({}));
    setSaving(false);
    if (r.ok) {
      setCat(d.catalog);
      setDirty(false);
      setMsg("Reverted to the starter defaults for this currency.");
    }
  };

  // Live worked example, so an operator sees what a change does to a real offer
  // before saving it. Uses a nominal base rather than a specific model.
  const nominal = cat.currency === "INR" ? 50000 : 600;
  const example = GRADES.map((g) => {
    const graded = Math.round(nominal * cat.gradeFactors[g]);
    const refurb = cat.cosmeticRefurb[g];
    const margin = Math.round(graded * cat.marginRate);
    return { g, graded, refurb, margin, net: Math.max(0, graded - refurb - margin) + (cat.promoBonus || 0) };
  });

  const Num = ({
    value,
    onChange,
    step = 1,
    prefix,
    suffix,
    width = 110,
  }: {
    value: number;
    onChange: (n: number) => void;
    step?: number;
    prefix?: string;
    suffix?: string;
    width?: number;
  }) => (
    <span className="inline-flex items-center gap-1">
      {prefix && <span className="text-[12px] text-[var(--muted)]">{prefix}</span>}
      <input
        className="input"
        type="number"
        step={step}
        min={0}
        style={{ width, padding: "6px 8px", fontSize: 13 }}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {suffix && <span className="text-[12px] text-[var(--muted)]">{suffix}</span>}
    </span>
  );

  return (
    <div className="flex flex-col gap-4">
      <section className="card p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-lg font-bold">Grade &amp; fault catalog · {clientId}</h2>
            <p className="mt-1 text-[12px] text-[var(--muted)]">
              What a grade is worth and what a fault costs, in {cat.currency}. The offer engine
              reads these exact numbers — nothing is converted from another currency.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="pill" style={{ fontSize: 11 }}>{cat.currency} {sym}</span>
            <span
              className={`pill ${cat.source === "catalog" ? "chip-green" : "chip-yellow"}`}
              style={{ fontSize: 11 }}
              title={
                cat.source === "catalog"
                  ? `Saved by ${cat.updatedBy || "an operator"}${cat.updatedAt ? ` on ${cat.updatedAt}` : ""}`
                  : "No one has priced this client yet — these are starter defaults"
              }
            >
              {cat.source === "catalog" ? "saved catalog" : "starter defaults — review"}
            </span>
          </div>
        </div>
        {msg && <p className="mt-3 text-[12px] text-[var(--brand)]">{msg}</p>}
      </section>

      <section className="card p-5">
        <h3 className="mb-1 text-sm font-bold uppercase tracking-wide">Cosmetic grades</h3>
        <p className="mb-3 text-[12px] text-[var(--muted)]">
          Value is the share of the Grade-A market base. Refurb is what it costs to bring that
          grade back to sellable.
        </p>
        <div style={{ overflowX: "auto" }}>
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-[var(--muted)]">
                <th className="py-2 pr-3">Grade</th>
                <th className="py-2 pr-3">Value (× base)</th>
                <th className="py-2 pr-3">Cosmetic refurb</th>
                <th className="py-2 pr-3">On a {money(nominal, cat.currency)} device</th>
              </tr>
            </thead>
            <tbody>
              {example.map(({ g, graded, refurb, margin, net }) => (
                <tr key={g} className="border-t border-[var(--border)]">
                  <td className="py-2 pr-3 font-bold">{g}</td>
                  <td className="py-2 pr-3">
                    <Num
                      value={cat.gradeFactors[g]}
                      step={0.01}
                      width={90}
                      suffix={`= ${Math.round(cat.gradeFactors[g] * 100)}%`}
                      onChange={(n) => set({ gradeFactors: { ...cat.gradeFactors, [g]: n } })}
                    />
                  </td>
                  <td className="py-2 pr-3">
                    <Num
                      value={cat.cosmeticRefurb[g]}
                      prefix={sym}
                      onChange={(n) => set({ cosmeticRefurb: { ...cat.cosmeticRefurb, [g]: n } })}
                    />
                  </td>
                  <td className="mono py-2 pr-3 text-[11px] text-[var(--muted)]">
                    {money(graded, cat.currency)} − {money(refurb, cat.currency)} refurb −{" "}
                    {money(margin, cat.currency)} margin ={" "}
                    <strong className="text-[var(--fg)]">{money(net, cat.currency)}</strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card p-5">
        <h3 className="mb-1 text-sm font-bold uppercase tracking-wide">Fault repair costs</h3>
        <p className="mb-3 text-[12px] text-[var(--muted)]">
          Deducted when that functional test FAILS. A fault priced at {sym}0 is not deducted at
          all — set a real cost or the offer over-pays for a broken component.
        </p>
        <div className="grid gap-x-6 gap-y-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}>
          {FAULT_IDS.map((id) => (
            <label key={id} className="flex items-center justify-between gap-2">
              <span className="text-[13px]">
                {FAULT_LABELS[id] || id} <span className="mono text-[10px] text-[var(--muted)]">{id}</span>
              </span>
              <Num
                value={cat.faultCosts[id] ?? 0}
                prefix={sym}
                onChange={(n) => set({ faultCosts: { ...cat.faultCosts, [id]: n } })}
              />
            </label>
          ))}
        </div>
      </section>

      <section className="card p-5">
        <h3 className="mb-3 text-sm font-bold uppercase tracking-wide">Battery, margin &amp; promo</h3>
        <div className="flex flex-wrap items-center gap-6">
          <label className="flex items-center gap-2 text-[13px]">
            Replace battery below
            <Num
              value={cat.batteryThreshold}
              suffix="%"
              width={80}
              onChange={(n) => set({ batteryThreshold: n })}
            />
          </label>
          <label className="flex items-center gap-2 text-[13px]">
            Battery cost
            <Num value={cat.batteryCost} prefix={sym} onChange={(n) => set({ batteryCost: n })} />
          </label>
          <label className="flex items-center gap-2 text-[13px]">
            Dealer margin
            <Num
              value={cat.marginRate}
              step={0.01}
              width={90}
              suffix={`= ${Math.round(cat.marginRate * 100)}%`}
              onChange={(n) => set({ marginRate: n })}
            />
          </label>
          <label className="flex items-center gap-2 text-[13px]">
            Promo bonus
            <Num value={cat.promoBonus} prefix={sym} onChange={(n) => set({ promoBonus: n })} />
          </label>
        </div>
      </section>

      <section className="card flex flex-wrap items-center gap-3 p-4">
        <button className="btn" disabled={!dirty || saving} onClick={save}>
          {saving ? "Saving…" : dirty ? "Save catalog" : "Saved"}
        </button>
        <button className="pill" disabled={saving} onClick={reset}>
          Revert to defaults
        </button>
        {dirty && <span className="text-[12px] text-[var(--muted)]">Unsaved changes — offers still use the last saved catalog.</span>}
      </section>
    </div>
  );
}
