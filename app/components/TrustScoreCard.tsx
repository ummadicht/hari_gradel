import type { Trust } from "@/lib/trust";

// v2 addition on top of the RETAINED DeviceFax passport: one fused Trust Score
// plus a confidence breakdown. Same visual language as the rest of the report —
// it augments the passport, it doesn't replace it.
export default function TrustScoreCard({ trust }: { trust: Trust }) {
  const color =
    trust.score >= 85 ? "var(--green-ink)" : trust.score >= 60 ? "var(--gold-2)" : "var(--bad)";
  const ring =
    trust.score >= 85 ? "var(--green)" : trust.score >= 60 ? "var(--gold)" : "var(--bad)";

  return (
    <section className="mt-4 overflow-hidden rounded-3xl border border-[var(--border)] bg-[var(--card)] px-6 py-7 sm:px-10">
      <div className="flex items-center gap-6">
        {/* score dial */}
        <div className="relative grid h-28 w-28 shrink-0 place-items-center">
          <svg width={112} height={112} viewBox="0 0 112 112" className="absolute inset-0">
            <circle cx={56} cy={56} r={48} fill="none" stroke="var(--bg-soft)" strokeWidth={9} />
            <circle
              cx={56}
              cy={56}
              r={48}
              fill="none"
              stroke={ring}
              strokeWidth={9}
              strokeLinecap="round"
              strokeDasharray={2 * Math.PI * 48}
              strokeDashoffset={2 * Math.PI * 48 * (1 - trust.score / 100)}
              transform="rotate(-90 56 56)"
            />
          </svg>
          <div className="text-center">
            <div className="text-[30px] font-black leading-none" style={{ color }}>
              {trust.score}
            </div>
            <div className="text-[10px] uppercase tracking-wide text-[var(--muted)]">/ 100</div>
          </div>
        </div>

        <div className="min-w-0">
          <div className="text-[12px] font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">
            GradeIQ Trust Score
          </div>
          <div className="mt-1 text-[17px] font-bold">
            {trust.score >= 85
              ? "High confidence"
              : trust.score >= 60
                ? "Moderate confidence"
                : "Low confidence"}
            {!trust.reliable && (
              <span className="ml-2 align-middle text-[12px] font-semibold" style={{ color: "var(--gold-2)" }}>
                · provisional
              </span>
            )}
          </div>
          <p className="mt-1 text-[13px] text-[var(--muted)]">
            Fused from cosmetic, functional, fraud/identity &amp; OEM-parts evidence — one number, no wall of pass/fail.
          </p>
        </div>
      </div>

      {/* confidence breakdown */}
      <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {trust.bands.map((b, i) => (
          <div key={i} className="rounded-2xl border border-[var(--border)] bg-[var(--bg-soft)] px-3 py-2.5">
            <div className="text-[11px] uppercase tracking-wide text-[var(--muted)]">{b.label}</div>
            <div
              className="mt-0.5 flex items-center gap-1.5 text-[14px] font-semibold"
              style={{
                color:
                  b.state === "ok"
                    ? "var(--green-ink)"
                    : b.state === "bad"
                      ? "var(--bad)"
                      : b.state === "warn"
                        ? "var(--gold-2)"
                        : "var(--muted)",
              }}
            >
              <span>{b.value}</span>
              <span aria-hidden>
                {b.state === "ok" ? "✓" : b.state === "bad" ? "✕" : b.state === "warn" ? "!" : "–"}
              </span>
            </div>
          </div>
        ))}
      </div>

      {trust.nudges.length > 0 && (
        <div
          className="mt-4 rounded-2xl px-4 py-3"
          style={{ background: "color-mix(in oklch, var(--gold) 10%, transparent)" }}
        >
          <div className="text-[13px] font-bold" style={{ color: "var(--gold-2)" }}>
            To raise the score
          </div>
          <ul className="mt-1 space-y-0.5 text-[13px] text-[var(--muted)]">
            {trust.nudges.map((n, i) => (
              <li key={i}>• {n}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
