"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { withBase } from "@/lib/basePath";

/**
 * RetailDesk — retail-channel login + the walk-in PURCHASE pipeline.
 *
 * The desk runs the staged India buyback flow (see lib/purchase.ts):
 *   1. intake     — customer name + mobile only
 *   2. checking   — the 90-second GradeIQ check (linked session)
 *   3. offered    — instant ₹ offer → customer accepts or declines
 *   4. accepted   — NOW record the ID (Aadhaar/PAN last-4 — after acceptance,
 *                   never before; nobody shows their ID to hear a price)
 *   5. clearance  — FMiP + blacklist AUTO-verified from the session's IMEI data,
 *                   operator confirms SIM out + factory reset
 *   6. paid       — Razorpay payout to the store's UPI, store credit reduced
 *
 * Login is the tenant's portal account (e.g. inzman/inzman) — the cookie scopes
 * every fetch to their client, and the header shows their live credit line.
 */

type Me = {
  user: { username: string; role: string; clientId: string | null };
  clients: { id: string; name: string; currency: string }[];
};
type Purchase = {
  id: string;
  client_id: string;
  status: string;
  customer: { name?: string; phone?: string };
  kyc: { idType?: string; idLast4?: string; idName?: string };
  session_id: string;
  offer: { value?: number; currency?: string; grade?: string; note?: string };
  clearance: { fmip?: string; blacklist?: string };
  payout: { method?: string; payoutId?: string; utr?: string; amount?: number; status?: string; note?: string };
  created_at: string;
};
type Detail = {
  purchase: Purchase;
  auto: { fmip: string; blacklist: string };
  credit: number;
  razorpay: boolean;
  storeVpa: string | null;
};

const MONEY: Record<string, string> = { USD: "$", INR: "₹", EUR: "€" };
const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
/** Offer money in ITS OWN currency — never a ₹ in front of a $ figure. */
const offerMoney = (o?: { value?: number; currency?: string }) =>
  o?.value ? `${MONEY[o.currency ?? "INR"] ?? ""}${Math.round(o.value).toLocaleString(o.currency === "INR" ? "en-IN" : "en-US")}` : "—";

const STATUS_META: Record<string, { label: string; cls: string }> = {
  intake: { label: "New — run the check", cls: "bg-slate-100 text-slate-600" },
  checking: { label: "Checking…", cls: "bg-amber-100 text-amber-700" },
  offered: { label: "Offer ready", cls: "bg-[#ccfbf1] text-[#0f766e]" },
  accepted: { label: "Accepted — KYC", cls: "bg-blue-100 text-blue-700" },
  cleared: { label: "Cleared — pay", cls: "bg-violet-100 text-violet-700" },
  paying: { label: "Paying…", cls: "bg-amber-100 text-amber-700" },
  paid: { label: "Paid ✓", cls: "bg-green-100 text-green-700" },
  declined: { label: "Declined", cls: "bg-slate-100 text-slate-400" },
  cancelled: { label: "Cancelled", cls: "bg-slate-100 text-slate-400" },
};

const RUNBOOK = [
  { icon: "🪪", t: "Start with just name + mobile", d: "That's all a quote needs. Full ID comes later, only if they accept." },
  { icon: "📲", t: "Run the 90-second check", d: "Scan the IMEI (*#06#) — GradeIQ tests the phone, photographs all sides, and checks the display." },
  { icon: "💰", t: "Instant ₹ offer", d: "Priced from your live India pricebook by grade. Customer says yes or no — no haggling." },
  { icon: "🪪", t: "KYC after acceptance", d: "Record their govt ID (Aadhaar / PAN — type, last 4, name as printed). Required for the purchase record." },
  { icon: "🔐", t: "Clearance is enforced", d: "Find My / activation lock and the IMEI blacklist are auto-checked from the device data — a locked or flagged phone cannot be paid for." },
  { icon: "🏦", t: "Payout & credit", d: "Razorpay settles the purchase to your store UPI and your credit line reduces by the amount. Every payout is on the ledger." },
];

export default function RetailDesk() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [credit, setCredit] = useState<number | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [actionErr, setActionErr] = useState("");
  const [actionBusy, setActionBusy] = useState(false);

  // new-purchase form
  const [showNew, setShowNew] = useState(false);
  const [custName, setCustName] = useState("");
  const [custPhone, setCustPhone] = useState("");

  // kyc form
  const [idType, setIdType] = useState("aadhaar");
  const [idLast4, setIdLast4] = useState("");
  const [idName, setIdName] = useState("");
  // clearance form
  const [simRemoved, setSimRemoved] = useState(false);
  const [factoryReset, setFactoryReset] = useState(false);
  const [fmipVisuallyOff, setFmipVisuallyOff] = useState(false);

  async function loadMe() {
    try {
      const r = await fetch(withBase("/api/portal/me"));
      if (!r.ok) return setMe(null);
      setMe(await r.json());
    } catch {
      setMe(null);
    }
  }
  useEffect(() => { void loadMe(); }, []);

  const loadPurchases = useCallback(async () => {
    try {
      const r = await fetch(withBase("/api/retail/purchases"));
      if (!r.ok) return;
      const j = await r.json();
      setPurchases(j.purchases ?? []);
      setCredit(typeof j.credit === "number" ? j.credit : null);
    } catch { /* transient */ }
  }, []);

  // Monotonic sequence: a slow poll response that lands AFTER a fresher one
  // (or after an action's reload) is discarded, so the panel can never revert
  // to an earlier stage right after the operator advanced it.
  const detailSeqRef = useRef(0);
  const loadDetail = useCallback(async (id: string) => {
    const seq = ++detailSeqRef.current;
    try {
      const r = await fetch(withBase(`/api/retail/purchases/${id}`));
      if (!r.ok) return;
      const j = await r.json();
      if (seq === detailSeqRef.current) setDetail(j);
    } catch { /* transient */ }
  }, []);

  useEffect(() => { if (me?.user) void loadPurchases(); }, [me, loadPurchases]);
  // Switching purchases: fresh detail AND fresh per-purchase form state — the
  // previous customer's ID digits or ticked compliance boxes must never carry
  // over into another purchase's panel.
  useEffect(() => {
    setActionErr("");
    setIdType("aadhaar"); setIdLast4(""); setIdName("");
    setSimRemoved(false); setFactoryReset(false); setFmipVisuallyOff(false);
    detailSeqRef.current++; // invalidate any in-flight fetch for the old purchase
    if (openId) void loadDetail(openId);
    else setDetail(null);
  }, [openId, loadDetail]);

  // Poll while a check is running (or a detail is open) — offers appear live.
  useEffect(() => {
    if (!me?.user) return;
    const hot =
      purchases.some(
        (p) => p.status === "checking" || p.status === "intake" || (p.status === "paid" && p.payout?.status === "queued")
      ) || !!openId;
    if (!hot) return;
    const t = setInterval(() => {
      void loadPurchases();
      if (openId) void loadDetail(openId);
    }, 4000);
    return () => clearInterval(t);
  }, [me, purchases, openId, loadPurchases, loadDetail]);

  async function login(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      const r = await fetch(withBase("/api/portal/login"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!r.ok) { setErr("Wrong username or password."); return; }
      await loadMe();
    } finally {
      setBusy(false);
    }
  }

  async function createPurchase(e: React.FormEvent) {
    e.preventDefault();
    setActionErr("");
    setActionBusy(true);
    try {
      const r = await fetch(withBase("/api/retail/purchases"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: custName, phone: custPhone }),
      });
      const j = await r.json();
      if (!r.ok) { setActionErr(j.error || "Couldn't create the purchase."); return; }
      setCustName(""); setCustPhone(""); setShowNew(false);
      await loadPurchases();
      setOpenId(j.purchase.id);
    } finally {
      setActionBusy(false);
    }
  }

  async function act(id: string, body: Record<string, unknown>) {
    setActionErr("");
    setActionBusy(true);
    try {
      const r = await fetch(withBase(`/api/retail/purchases/${id}`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) { setActionErr(j.error || "Action failed."); return; }
      await loadDetail(id);
      await loadPurchases();
    } finally {
      setActionBusy(false);
    }
  }

  const client = me?.user
    ? me.clients.find((c) => c.id === (me.user.clientId ?? me.clients[0]?.id)) ?? me.clients[0]
    : null;
  const sym = MONEY[client?.currency ?? "INR"] ?? "₹";

  if (me === undefined) {
    return <div className="grid min-h-dvh place-items-center bg-[#f4f7f6] text-slate-500">Loading…</div>;
  }

  // ── LOGIN ──
  if (!me?.user) {
    return (
      <div className="grid min-h-dvh place-items-center bg-[#f4f7f6] px-6">
        <div className="w-full max-w-sm">
          <div className="mb-6 text-center">
            <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-[#0d9488] text-2xl text-white">🏪</div>
            <h1 className="mt-3 text-2xl font-extrabold text-slate-900">Retail partner login</h1>
            <p className="mt-1 text-sm text-slate-500">Sign in with your GradeIQ client account to start collecting phones.</p>
          </div>
          <form onSubmit={login} className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
            <label className="block text-xs font-bold uppercase tracking-wide text-slate-500">Username</label>
            <input value={username} onChange={(e) => setUsername(e.target.value)} autoCapitalize="none"
              className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-slate-900 outline-none focus:border-[#14b8a6]" placeholder="e.g. inzman" />
            <label className="mt-4 block text-xs font-bold uppercase tracking-wide text-slate-500">Password</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-slate-900 outline-none focus:border-[#14b8a6]" placeholder="••••••••" />
            {err && <p className="mt-3 text-sm font-semibold text-red-600">{err}</p>}
            <button type="submit" disabled={busy || !username || !password}
              className="mt-5 w-full rounded-full bg-[#0d9488] py-3.5 font-bold text-white transition hover:bg-[#0f766e] disabled:opacity-40">
              {busy ? "Signing in…" : "Sign in →"}
            </button>
          </form>
          <p className="mt-4 text-center text-xs text-slate-400">No account? Your GradeIQ administrator creates retail logins per client.</p>
        </div>
      </div>
    );
  }

  const open = detail?.purchase && detail.purchase.id === openId ? detail : null;

  // ── DESK ──
  return (
    <div className="min-h-dvh bg-[#f4f7f6] pb-16 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-4xl items-center gap-3 px-6 py-4">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-[#0d9488] text-lg text-white">🏪</div>
          <div className="leading-tight">
            <div className="font-extrabold">{client?.name ?? "Retail desk"}</div>
            <div className="text-xs text-slate-500">Retail channel · {client?.currency ?? "INR"} · {me.user.username}</div>
          </div>
          {credit != null && (
            <div className="ml-auto rounded-full bg-[#f0fdfa] px-4 py-2 text-right">
              <div className="text-[10px] font-bold uppercase tracking-wide text-[#0f766e]/70">Credit available</div>
              <div className="text-sm font-extrabold tabular-nums text-[#0f766e]">{inr(credit)}</div>
            </div>
          )}
          <form className={credit != null ? "" : "ml-auto"}
            onSubmit={async (e) => { e.preventDefault(); await fetch(withBase("/api/portal/logout"), { method: "POST" }).catch(() => {}); setMe(null); }}>
            <button className="text-sm font-semibold text-slate-400 hover:text-slate-600">Sign out</button>
          </form>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6">
        {/* hero CTA — starts the pipeline with the light-touch intake */}
        <section className="mt-8 rounded-3xl bg-[#0d9488] p-7 text-white sm:p-9">
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-[#ccfbf1]">buy from customer</p>
          <h1 className="mt-1 text-3xl font-extrabold leading-tight sm:text-4xl">Collect a phone in about 90 seconds.</h1>
          <p className="mt-2 max-w-lg text-[#f0fdfa]">
            Name and mobile first, then the guided check → instant {sym} offer → ID after they accept →
            clearance → payout from your credit line.
          </p>
          {!showNew ? (
            <button onClick={() => { setShowNew(true); setActionErr(""); }}
              className="mt-5 inline-flex items-center gap-2 rounded-full bg-white px-7 py-3.5 font-bold text-[#0f766e] transition hover:bg-[#f0fdfa]">
              ＋ New purchase
            </button>
          ) : (
            <form onSubmit={createPurchase} className="mt-5 flex max-w-lg flex-col gap-2 sm:flex-row">
              <input value={custName} onChange={(e) => setCustName(e.target.value)} placeholder="Customer name"
                className="flex-1 rounded-full px-5 py-3 font-semibold text-slate-900 outline-none" />
              <input value={custPhone} onChange={(e) => setCustPhone(e.target.value)} placeholder="+91 mobile" inputMode="tel"
                className="w-full rounded-full px-5 py-3 font-semibold text-slate-900 outline-none sm:w-44" />
              <button type="submit" disabled={actionBusy}
                className="rounded-full bg-slate-900 px-6 py-3 font-bold text-white disabled:opacity-40">Start →</button>
            </form>
          )}
          {showNew && actionErr && <p className="mt-2 text-sm font-semibold text-amber-200">{actionErr}</p>}
        </section>

        {/* purchase book */}
        <section className="mt-8">
          <h2 className="text-lg font-extrabold">Purchases</h2>
          <p className="text-sm text-slate-500">Every walk-in, from first hello to payout.</p>
          <div className="mt-3 space-y-2">
            {purchases.length === 0 && (
              <p className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-400">
                No purchases yet — tap <b>＋ New purchase</b> to buy your first phone.
              </p>
            )}
            {purchases.map((p) => {
              const meta = STATUS_META[p.status] ?? STATUS_META.intake;
              const isOpen = openId === p.id;
              return (
                <div key={p.id} className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
                  <button onClick={() => setOpenId(isOpen ? null : p.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left">
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-bold">{p.customer?.name || "Customer"} <span className="font-normal text-slate-400">· {p.customer?.phone}</span></div>
                      <div className="text-xs text-slate-400">#{p.id.slice(2, 8)} · {new Date(p.created_at + "Z").toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</div>
                    </div>
                    {p.offer?.value ? <div className="font-extrabold tabular-nums text-[#0f766e]">{offerMoney(p.offer)}</div> : null}
                    <span className={`rounded-full px-3 py-1 text-xs font-bold ${meta.cls}`}>{meta.label}</span>
                    <span className="text-slate-300">{isOpen ? "▾" : "▸"}</span>
                  </button>

                  {isOpen && open && (
                    <div className="border-t border-slate-100 bg-slate-50/60 px-4 py-4">
                      {actionErr && <p className="mb-3 rounded-xl bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">{actionErr}</p>}
                      <PurchaseStage
                        d={open}
                        busy={actionBusy}
                        sym={sym}
                        onRun={() => {
                          const href = withBase(`/v2?client=${encodeURIComponent(p.client_id)}&channel=retail&purchase=${encodeURIComponent(p.id)}`);
                          window.open(href, "_blank");
                        }}
                        onAccept={() => act(p.id, { action: "accept" })}
                        onDecline={() => act(p.id, { action: "decline" })}
                        onKyc={() => act(p.id, { action: "kyc", idType, idLast4, idName })}
                        onClear={() => act(p.id, { action: "clearance", simRemoved, factoryReset, fmipVisuallyOff })}
                        onPay={() => act(p.id, { action: "pay" })}
                        kycState={{ idType, setIdType, idLast4, setIdLast4, idName, setIdName }}
                        clearState={{ simRemoved, setSimRemoved, factoryReset, setFactoryReset, fmipVisuallyOff, setFmipVisuallyOff }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {/* runbook */}
        <section className="mt-10">
          <h2 className="text-lg font-extrabold">How the desk works</h2>
          <ol className="mt-3 grid gap-3 sm:grid-cols-2">
            {RUNBOOK.map((s, i) => (
              <li key={s.t} className="flex gap-3 rounded-2xl border border-slate-200 bg-white p-4">
                <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[#f0fdfa] text-lg">{s.icon}</div>
                <div>
                  <div className="text-sm font-extrabold"><span className="mr-1 text-[#0d9488]">{i + 1}.</span>{s.t}</div>
                  <p className="mt-0.5 text-xs leading-relaxed text-slate-500">{s.d}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>
      </main>
    </div>
  );
}

/* ── The staged action panel for one purchase ─────────────────────────────── */

function PurchaseStage(props: {
  d: Detail;
  busy: boolean;
  sym: string;
  onRun: () => void;
  onAccept: () => void;
  onDecline: () => void;
  onKyc: () => void;
  onClear: () => void;
  onPay: () => void;
  kycState: { idType: string; setIdType: (v: string) => void; idLast4: string; setIdLast4: (v: string) => void; idName: string; setIdName: (v: string) => void };
  clearState: { simRemoved: boolean; setSimRemoved: (v: boolean) => void; factoryReset: boolean; setFactoryReset: (v: boolean) => void; fmipVisuallyOff: boolean; setFmipVisuallyOff: (v: boolean) => void };
}) {
  const { d, busy, onRun, onAccept, onDecline, onKyc, onClear, onPay, kycState, clearState } = props;
  const p = d.purchase;
  const btn = "rounded-full px-5 py-2.5 text-sm font-bold disabled:opacity-40";
  const teal = `${btn} bg-[#0d9488] text-white hover:bg-[#0f766e]`;
  const ghost = `${btn} border border-slate-300 bg-white text-slate-600`;
  const box = "mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-[#14b8a6]";

  if (p.status === "intake" || p.status === "checking") {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p className="flex-1 text-sm text-slate-600">
          {p.status === "intake"
            ? "Run the 90-second GradeIQ check on the customer's phone."
            : "Check in progress — the offer appears here the moment it's graded."}
        </p>
        <button onClick={onRun} disabled={busy} className={teal}>📲 {p.status === "intake" ? "Run the check" : "Reopen the check"}</button>
        {p.session_id && (
          <a href={withBase(`/report/${p.session_id}`)} target="_blank" className="text-sm font-semibold text-[#0d9488] hover:underline" rel="noreferrer">Report →</a>
        )}
      </div>
    );
  }

  if (p.status === "offered") {
    return (
      <div>
        <div className="flex items-end justify-between rounded-2xl bg-white p-4">
          <div>
            <div className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Instant offer · grade {p.offer?.grade || "—"}</div>
            <div className="text-3xl font-extrabold tabular-nums text-[#0f766e]">{offerMoney(p.offer)}</div>
            <div className="mt-0.5 text-xs text-slate-400">{p.offer?.note}</div>
          </div>
          {p.session_id && <a href={withBase(`/report/${p.session_id}`)} target="_blank" className="text-sm font-semibold text-[#0d9488] hover:underline" rel="noreferrer">Full report →</a>}
        </div>
        <div className="mt-3 flex gap-2">
          <button onClick={onAccept} disabled={busy} className={teal}>Customer accepts ✓</button>
          <button onClick={onDecline} disabled={busy} className={ghost}>Declined</button>
        </div>
      </div>
    );
  }

  if (p.status === "accepted") {
    const hasKyc = !!p.kyc?.idLast4;
    return (
      <div className="grid gap-4 sm:grid-cols-2">
        {/* KYC — collected only now, after acceptance */}
        <div className={`rounded-2xl bg-white p-4 ${hasKyc ? "opacity-60" : ""}`}>
          <div className="text-sm font-extrabold">1 · Customer ID {hasKyc && "✓"}</div>
          {!hasKyc ? (
            <>
              <label className="mt-2 block text-[11px] font-bold uppercase text-slate-400">ID type</label>
              <select value={kycState.idType} onChange={(e) => kycState.setIdType(e.target.value)} className={box}>
                <option value="aadhaar">Aadhaar</option>
                <option value="pan">PAN</option>
                <option value="dl">Driving licence</option>
                <option value="voter">Voter ID</option>
                <option value="passport">Passport</option>
              </select>
              <label className="mt-2 block text-[11px] font-bold uppercase text-slate-400">Last 4 digits</label>
              <input value={kycState.idLast4} onChange={(e) => kycState.setIdLast4(e.target.value.replace(/\D/g, "").slice(0, 4))} inputMode="numeric" placeholder="1234" className={box} />
              <label className="mt-2 block text-[11px] font-bold uppercase text-slate-400">Name as printed</label>
              <input value={kycState.idName} onChange={(e) => kycState.setIdName(e.target.value)} placeholder="Name on the ID" className={box} />
              <button onClick={onKyc} disabled={busy || kycState.idLast4.length !== 4 || !kycState.idName} className={`${teal} mt-3 w-full`}>Save ID</button>
            </>
          ) : (
            <p className="mt-1 text-sm text-slate-500">{p.kyc.idType?.toUpperCase()} ····{p.kyc.idLast4} · {p.kyc.idName}</p>
          )}
        </div>

        {/* Clearance — auto-gates + physical confirmation */}
        <div className={`rounded-2xl bg-white p-4 ${!hasKyc ? "opacity-50" : ""}`}>
          <div className="text-sm font-extrabold">2 · Clearance</div>
          <div className="mt-2 flex flex-wrap gap-2 text-xs font-bold">
            <span className={`rounded-full px-3 py-1 ${d.auto.fmip === "clear" ? "bg-green-100 text-green-700" : d.auto.fmip === "locked" ? "bg-red-100 text-red-700" : "bg-slate-100 text-slate-500"}`}>
              Find My: {d.auto.fmip}
            </span>
            <span className={`rounded-full px-3 py-1 ${d.auto.blacklist === "clean" ? "bg-green-100 text-green-700" : d.auto.blacklist === "flagged" ? "bg-red-100 text-red-700" : "bg-slate-100 text-slate-500"}`}>
              Blacklist: {d.auto.blacklist}
            </span>
          </div>
          <label className="mt-3 flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={clearState.simRemoved} onChange={(e) => clearState.setSimRemoved(e.target.checked)} disabled={!hasKyc} /> SIM + memory card removed
          </label>
          <label className="mt-1.5 flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={clearState.factoryReset} onChange={(e) => clearState.setFactoryReset(e.target.checked)} disabled={!hasKyc} /> Factory reset done — data cleared
          </label>
          {d.auto.fmip === "unknown" && (
            <label className="mt-1.5 flex items-center gap-2 text-sm text-slate-600">
              <input type="checkbox" checked={clearState.fmipVisuallyOff} onChange={(e) => clearState.setFmipVisuallyOff(e.target.checked)} disabled={!hasKyc} /> Checked on device: Find My / account lock is OFF
            </label>
          )}
          <button onClick={onClear} disabled={busy || !hasKyc} className={`${teal} mt-3 w-full`}>Verify clearance →</button>
        </div>
      </div>
    );
  }

  if (p.status === "cleared" || p.status === "paying") {
    const isInr = (p.offer?.currency ?? "INR") === "INR";
    return (
      <div className="rounded-2xl bg-white p-4">
        <div className="text-sm font-extrabold">Payout</div>
        <p className="mt-1 text-sm text-slate-600">
          Pay <b className="tabular-nums">{offerMoney(p.offer)}</b> for {p.customer?.name}&apos;s phone.
          {!isInr
            ? <> ⚠️ This offer isn&apos;t in ₹ — payouts settle in INR only, so it can&apos;t be paid from the credit line.</>
            : d.razorpay
              ? d.storeVpa
                ? <> Razorpay → store UPI <b>{d.storeVpa}</b>, then your credit reduces.</>
                : <> ⚠️ No store UPI on file — add <code>payout_vpa:{p.client_id}</code> in Settings.</>
              : <> <b>Razorpay mock mode</b> — the payout runs the real lifecycle (queued → UTR on settlement) with MOCK-stamped ids; no real money moves. Add keys in Settings to go live.</>}
        </p>
        <div className="mt-2 text-xs text-slate-400">Credit available: ₹{d.credit.toLocaleString("en-IN")}</div>
        <button
          onClick={onPay}
          disabled={busy || p.status === "paying" || !isInr || (d.razorpay && !d.storeVpa)}
          className={`${btn} mt-3 bg-[#0d9488] text-white hover:bg-[#0f766e]`}
        >
          {p.status === "paying" ? "Paying…" : <>🏦 Pay {offerMoney(p.offer)} &amp; close</>}
        </button>
      </div>
    );
  }

  if (p.status === "paid") {
    const pay = p.payout ?? {};
    const isMock = pay.method === "razorpay-mock";
    const settling = pay.status === "queued";
    return (
      <div className="rounded-2xl bg-white p-4 text-sm">
        <div className="flex items-center gap-2">
          <span className={`font-extrabold ${settling ? "text-amber-600" : "text-green-700"}`}>
            {settling ? "Payout queued…" : "Paid ✓"}
          </span>
          {isMock && <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold uppercase text-amber-700">Razorpay mock</span>}
        </div>
        <div className="mt-2 space-y-0.5 font-mono text-xs text-slate-600">
          <div>amount&nbsp;&nbsp;₹{(pay.amount ?? 0).toLocaleString("en-IN")}</div>
          {pay.payoutId && <div>payout&nbsp;&nbsp;{pay.payoutId}</div>}
          <div>UTR&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;{pay.utr || (settling ? "— settling via UPI…" : "—")}</div>
          {"vpa" in pay && (pay as { vpa?: string }).vpa ? <div>to&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;{(pay as { vpa?: string }).vpa}</div> : null}
        </div>
        {pay.note && <p className="mt-2 text-xs text-slate-400">{pay.note}</p>}
        {p.session_id && (
          <a href={withBase(`/report/${p.session_id}`)} target="_blank" className="mt-2 inline-block font-semibold text-[#0d9488] hover:underline" rel="noreferrer">
            Device certificate →
          </a>
        )}
      </div>
    );
  }

  return <p className="text-sm text-slate-400">This purchase is {p.status}.</p>;
}
