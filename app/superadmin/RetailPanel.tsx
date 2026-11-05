"use client";
import { useCallback, useEffect, useState } from "react";
import { withBase } from "@/lib/basePath";

// Retail desk oversight — the selected client's buyback book: every purchase
// with its stage and payout, the credit line + append-only ledger, and (super
// only) the credit/UPI configuration + payout reversal. The operator-facing
// desk lives at /channel/retail; THIS is the management view of the same data.

type Purchase = {
  id: string;
  status: string;
  customer: { name?: string; phone?: string };
  phone?: string;
  imei?: string;
  model?: string;
  store_id?: string;
  store_name?: string;
  store_info?: { branch?: string; address?: string };
  recorded_at?: string;
  timezone?: string;
  kyc: { idType?: string; idLast4?: string };
  session_id: string;
  offer: { value?: number; currency?: string; grade?: string };
  payout: { method?: string; payoutId?: string; utr?: string; amount?: number; status?: string; reversedAt?: string };
  created_at: string;
  created_by: string;
};
type Ledger = { id: number; delta: number; balance_after: number; ref: string; note: string; at: string };
type Data = {
  purchases: Purchase[];
  credit: number;
  opening: number;
  ledger: Ledger[];
  storeVpa: string;
  razorpayLive: boolean;
  isSuper: boolean;
};

const MONEY: Record<string, string> = { USD: "$", INR: "₹", EUR: "€" };
const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const STATUS_TONE: Record<string, string> = {
  paid: "chip-green",
  paying: "chip-yellow",
  cleared: "chip-yellow",
  offered: "chip-green",
  declined: "chip-red",
  cancelled: "chip-red",
};

export default function RetailPanel({ clientId }: { clientId: string }) {
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState("");
  const [creditEdit, setCreditEdit] = useState("");
  const [vpaEdit, setVpaEdit] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setErr("");
    try {
      const r = await fetch(withBase(`/api/retail/overview?client=${encodeURIComponent(clientId)}`));
      const j = await r.json();
      if (!r.ok) {
        setErr(j.error || "Failed to load.");
        setD(null);
        return;
      }
      setD(j);
      setCreditEdit(String(j.opening));
      setVpaEdit(j.storeVpa || "");
    } catch {
      setErr("Failed to load.");
    }
  }, [clientId]);
  useEffect(() => {
    void load();
  }, [load]);

  async function config(action: "set-credit" | "set-vpa", value: string) {
    setBusy(true);
    setErr("");
    try {
      const r = await fetch(withBase("/api/retail/overview"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, client: clientId, value }),
      });
      const j = await r.json();
      if (!r.ok) setErr(j.error || "Failed.");
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function reverse(p: Purchase) {
    const reason = window.prompt(`Reverse the ${inr(p.payout?.amount ?? 0)} payout for ${p.customer?.name}? Type the reason (e.g. "Razorpay reversed the UPI payout"):`);
    if (!reason) return;
    setBusy(true);
    setErr("");
    try {
      const r = await fetch(withBase(`/api/retail/purchases/${p.id}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reverse", reason }),
      });
      const j = await r.json();
      if (!r.ok) setErr(j.error || "Reverse failed.");
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (!d) {
    return <div className="card p-6 text-sm text-[var(--muted)]">{err || "Loading retail book…"}</div>;
  }

  const used = d.opening - d.credit;

  return (
    <div className="space-y-5">
      {err && <div className="card chip-red p-3 text-sm font-semibold">{err}</div>}

      {/* credit line */}
      <div className="card p-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="text-[11px] font-bold uppercase tracking-wide text-[var(--muted)]">Credit line</div>
            <div className="mt-1 flex items-baseline gap-3">
              <span className="text-3xl font-black tabular-nums">{inr(d.credit)}</span>
              <span className="text-sm text-[var(--muted)]">available of {inr(d.opening)} · {inr(used)} used</span>
            </div>
            <div className="mt-2 h-2 w-full max-w-md overflow-hidden rounded-full" style={{ background: "var(--bg-soft)" }}>
              <div className="h-full rounded-full" style={{ width: `${d.opening ? Math.min(100, (used / d.opening) * 100) : 0}%`, background: "var(--grad)" }} />
            </div>
          </div>
          <div className="text-right text-[12px] text-[var(--muted)]">
            Payouts: <b>{d.razorpayLive ? "Razorpay LIVE" : "Razorpay mock"}</b>
            <br />
            Store UPI: <b>{d.storeVpa || "— not set"}</b>
          </div>
        </div>

        {d.isSuper && (
          <div className="mt-4 flex flex-wrap gap-2 border-t border-[var(--border)] pt-4">
            <input className="input" style={{ maxWidth: 180 }} value={creditEdit} onChange={(e) => setCreditEdit(e.target.value.replace(/[^\d]/g, ""))} placeholder="Opening credit ₹" />
            <button className="pill" disabled={busy} onClick={() => config("set-credit", creditEdit)}>Set credit line</button>
            <span className="mx-2" />
            <input className="input" style={{ maxWidth: 220 }} value={vpaEdit} onChange={(e) => setVpaEdit(e.target.value)} placeholder="store@upi" />
            <button className="pill" disabled={busy} onClick={() => config("set-vpa", vpaEdit)}>Set store UPI</button>
          </div>
        )}
      </div>

      {/* purchases */}
      <div className="card overflow-hidden">
        <div className="border-b border-[var(--border)] px-5 py-3 text-sm font-extrabold">
          Purchases <span className="font-normal text-[var(--muted)]">· {d.purchases.length}</span>
        </div>
        {d.purchases.length === 0 ? (
          <p className="p-6 text-center text-sm text-[var(--muted)]">No purchases here. New collections now start at the counter (swapmore.com/counter), which keeps its own ledger — this panel shows GradeIQ purchase history only.</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="w-full text-left text-[13px]">
              <thead className="text-[11px] uppercase tracking-wide text-[var(--muted)]">
                <tr>
                  <th className="px-5 py-2.5">Customer & Phone</th>
                  <th className="px-3 py-2.5">IMEI & Model</th>
                  <th className="px-3 py-2.5">Store & Operator</th>
                  <th className="px-3 py-2.5">Date/Time & TZ</th>
                  <th className="px-3 py-2.5">Offer</th>
                  <th className="px-3 py-2.5">Status</th>
                  <th className="px-3 py-2.5">Payout</th>
                  <th className="px-3 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {d.purchases.map((p) => {
                  const reversed = !!p.payout?.reversedAt;
                  return (
                    <tr key={p.id} className="border-t border-[var(--border)]">
                      <td className="px-5 py-2.5">
                        <div className="font-bold">{p.customer?.name || "—"}</div>
                        <div className="text-[11px] text-[var(--muted)]">{p.phone || p.customer?.phone || "—"} · #{p.id.slice(2, 8)}</div>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="font-mono text-xs">{p.imei || "—"}</div>
                        <div className="text-[11px] text-[var(--muted)]">{p.model || "—"}</div>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="font-semibold">{p.store_name || p.store_id || "—"}</div>
                        <div className="text-[11px] text-[var(--muted)]">
                          {p.store_info?.branch ? `${p.store_info.branch} · ` : ""}by {p.created_by}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-[11px] text-[var(--muted)] tabular-nums">
                        <div>{(p.recorded_at || p.created_at || "").slice(0, 16).replace("T", " ")}</div>
                        <div>{p.timezone || "UTC"}</div>
                      </td>
                      <td className="px-3 py-2.5 font-bold tabular-nums">
                        {p.offer?.value ? `${MONEY[p.offer.currency ?? "INR"] ?? ""}${p.offer.value.toLocaleString(p.offer.currency === "INR" ? "en-IN" : "en-US")}` : "—"}
                        {p.offer?.grade ? <span className="ml-1 font-normal text-[var(--muted)]">({p.offer.grade})</span> : null}
                      </td>
                      <td className="px-3 py-2.5">
                        <span className={`pill ${STATUS_TONE[p.status] ?? ""}`} style={{ fontSize: 11, fontWeight: 700 }}>
                          {reversed ? "reversed" : p.status}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 font-mono text-[11px] text-[var(--muted)]">
                        {p.payout?.payoutId ? (
                          <>
                            {p.payout.payoutId}
                            {p.payout.utr ? <><br />UTR {p.payout.utr}</> : null}
                          </>
                        ) : "—"}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        {p.session_id && (
                          <a className="pill" href={withBase(`/report/${p.session_id}`)} target="_blank" rel="noreferrer">Report</a>
                        )}
                        {d.isSuper && p.status === "paid" && !reversed && p.payout?.amount ? (
                          <button className="pill chip-red ml-1" disabled={busy} onClick={() => reverse(p)}>Reverse</button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ledger */}
      <div className="card overflow-hidden">
        <div className="border-b border-[var(--border)] px-5 py-3 text-sm font-extrabold">
          Credit ledger <span className="font-normal text-[var(--muted)]">· append-only</span>
        </div>
        {d.ledger.length === 0 ? (
          <p className="p-6 text-center text-sm text-[var(--muted)]">No movements yet.</p>
        ) : (
          <table className="w-full text-left text-[13px]">
            <tbody>
              {d.ledger.map((l) => (
                <tr key={l.id} className="border-t border-[var(--border)]">
                  <td className={`px-5 py-2 font-bold tabular-nums ${l.delta < 0 ? "" : "text-[var(--good)]"}`} style={l.delta < 0 ? { color: "var(--bad)" } : undefined}>
                    {l.delta < 0 ? "−" : "+"}{inr(Math.abs(l.delta))}
                  </td>
                  <td className="px-3 py-2 text-[var(--muted)]">{l.note}</td>
                  <td className="px-3 py-2 tabular-nums text-[var(--muted)]">bal {inr(l.balance_after)}</td>
                  <td className="px-3 py-2 text-right text-[11px] text-[var(--muted)]">{l.at}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
