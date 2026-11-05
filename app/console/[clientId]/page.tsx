import { notFound, redirect } from "next/navigation";
import { portalUser } from "@/lib/portalAuth";
import { effectiveAuthMode } from "@/lib/auth-mode";
import { sessionAlias } from "@/lib/sessionAlias";
import { resolveClient, isClientId } from "@/lib/clients";
import { loadPricebook, swapmoreOffer } from "@/lib/clientPricing";
import { recentSessions } from "@/lib/db";

export const dynamic = "force-dynamic";

// Per-CLIENT console (behind the GradeIQ admin gate). Scoped to ONE client — for
// "swapmore" it shows the pricebook fed from SwapMore + every swapmore trade-in
// session and its computed offer. Source of truth for prices stays SwapMore's Back
// Office; this is the client's window into what GradeIQ is applying.
export default async function ClientConsole({ params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  if (!isClientId(clientId)) notFound();
  // Signed out (a stale cookie got past the middleware): send to the sign-in
  // that is live. This used to render the enterprise password form, whose
  // cookie nothing reads any more — a sign-in that could never sign anyone in.
  // redirect() applies the basePath itself.
  const user = await portalUser();
  if (!user) {
    const back = encodeURIComponent(`/console/${clientId}`);
    redirect(effectiveAuthMode() === "oidc" ? `/auth/login?returnTo=${back}` : `/login?returnTo=${back}`);
  }
  // A client admin sees their own tenant's console only.
  if (user.role !== "super" && user.clientId !== clientId) notFound();

  const client = resolveClient(clientId);
  const { book, source } = loadPricebook(clientId);
  const sym = client.currency === "USD" ? "$" : "€";
  const sessions = recentSessions(200).filter((s) => s.client_id === clientId);

  const byBrand = new Map<string, typeof book.models>();
  for (const m of book.models) {
    if (!byBrand.has(m.brand)) byBrand.set(m.brand, []);
    byBrand.get(m.brand)!.push(m);
  }

  const card = "rounded-2xl border border-black/10 bg-white p-5 shadow-sm";
  const chip = (ok: boolean, t: string) => (
    <span
      className="rounded-full px-2.5 py-1 text-xs font-bold"
      style={ok ? { color: "#0b7d78", background: "rgba(18,176,160,0.12)" } : { color: "#a16207", background: "rgba(251,191,36,0.15)" }}
    >
      {t}
    </span>
  );

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 text-[#141018]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.2em] text-black/40">Client console</div>
          <h1 className="text-2xl font-black">{client.name}</h1>
        </div>
        <div className="flex items-center gap-2">
          {chip(true, `Currency ${client.currency}`)}
          {source === "synced"
            ? chip(true, "Synced from SwapMore")
            : chip(false, "Seed snapshot — awaiting first sync")}
          {chip(true, `${book.models.length} models`)}
        </div>
      </div>

      <p className="mt-3 text-sm text-black/60">
        Prices are edited in <b>SwapMore&apos;s Back Office</b> (<code>/admin-catalog</code>) and pushed here
        automatically on every save. GradeIQ applies the exact same buyback math, so the offer inside{" "}
        <code>swapmore.com/buyback</code> matches SwapMore&apos;s own price.
      </p>

      {/* rule constants */}
      <div className={`${card} mt-6`}>
        <div className="text-sm font-bold">Pricing rules</div>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ["Margin", `${Math.round(book.constants.marginRate * 100)}%`],
            ["Processing", `${sym}${book.constants.processingCost}`],
            ["Scrap floor", `${Math.round(book.constants.scrapFloorRate * 100)}%`],
            ["Carrier-lock", `−${Math.round(book.constants.carrierLockPenalty * 100)}%`],
          ].map(([k, v]) => (
            <div key={k} className="rounded-xl bg-black/[0.03] p-3">
              <div className="text-[11px] uppercase tracking-wide text-black/40">{k}</div>
              <div className="text-lg font-black">{v}</div>
            </div>
          ))}
        </div>
      </div>

      {/* recent sessions + their offers */}
      <div className={`${card} mt-4`}>
        <div className="text-sm font-bold">Recent {client.name} trade-ins ({sessions.length})</div>
        {sessions.length === 0 ? (
          <p className="mt-2 text-sm text-black/50">No sessions yet for this client.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-[11px] uppercase tracking-wide text-black/40">
                <tr>
                  <th className="py-1.5">Session</th>
                  <th>Device</th>
                  <th>Grade</th>
                  <th>Offer</th>
                  <th>Status</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {sessions.slice(0, 50).map((s) => {
                  const o = swapmoreOffer(s);
                  return (
                    <tr key={s.id} className="border-t border-black/5">
                      <td className="py-2 font-mono text-xs" title={s.id}>{sessionAlias(s.id)}</td>
                      <td>{s.model || "—"}</td>
                      <td>{s.overall_grade || s.cosmetic_grade || "—"}</td>
                      <td className="font-bold">{o.value != null ? `${sym}${o.value}` : "—"}</td>
                      <td className="text-xs text-black/50">{s.status}</td>
                      <td className="text-xs text-black/40">{s.updated_at?.slice(0, 16).replace("T", " ")}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* pricebook */}
      <div className={`${card} mt-4`}>
        <div className="text-sm font-bold">Pricebook — base buyback value per model</div>
        <p className="mt-1 text-xs text-black/45">
          The flawless base; the final offer = this minus tier-scaled repairs, reconditioning, processing &amp;
          margin (and −{Math.round(book.constants.carrierLockPenalty * 100)}% if carrier-locked).
        </p>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          {[...byBrand.entries()].map(([brand, models]) => (
            <div key={brand}>
              <div className="text-xs font-bold uppercase tracking-wide text-black/40">{brand}</div>
              <table className="mt-1 w-full text-sm">
                <tbody>
                  {models.map((m) => (
                    <tr key={m.id} className="border-t border-black/5">
                      <td className="py-1.5">{m.name}</td>
                      <td className="py-1.5 text-right font-bold">
                        {sym}
                        {m.basePrice}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
