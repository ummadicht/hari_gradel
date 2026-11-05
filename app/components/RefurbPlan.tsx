import type { RefurbPlan as Plan } from "@/lib/suggester";

// The refurb decision view — recommended action + repair ROI + price band.
// Apple-clean: airy, hairline rows, minimal colour.

const APPLE_FONT =
  'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

const ACTION_COLOR: Record<Plan["action"], string> = {
  resell_as_is: "var(--green-ink)",
  repair_then_resell: "var(--gold-2)",
  recycle: "var(--muted)",
  reject: "var(--bad)",
};

export default function RefurbPlan({ plan }: { plan: Plan }) {
  if (!plan.ready) {
    return (
      <section
        className="mt-4 rounded-3xl border border-[var(--border)] bg-[var(--card)] px-6 py-9 sm:px-10"
        style={{ fontFamily: APPLE_FONT }}
      >
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
          Refurb plan
        </h2>
        <p className="mt-3 text-[15px] text-[var(--muted)]">{plan.rationale}</p>
      </section>
    );
  }

  return (
    <section
      className="mt-4 rounded-3xl border border-[var(--border)] bg-[var(--card)] px-6 py-9 sm:px-10"
      style={{ fontFamily: APPLE_FONT }}
    >
      <div className="mb-6 flex items-baseline justify-between">
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
          Refurb plan
        </h2>
        <span
          className="text-[15px] font-semibold"
          style={{ color: ACTION_COLOR[plan.action] }}
        >
          {plan.actionLabel}
        </span>
      </div>

      {/* Price band */}
      <div className="grid grid-cols-3 divide-x divide-[var(--border)] rounded-2xl bg-[var(--bg-soft)] py-5">
        <Cell label="Resell as-is" value={`$${plan.asIs}`} />
        <Cell
          label="After repair"
          value={plan.afterRepair != null ? `$${plan.afterRepair}` : "—"}
        />
        <Cell
          label="Net ROI"
          value={
            plan.netGain != null
              ? `${plan.netGain >= 0 ? "+" : ""}$${plan.netGain}`
              : "—"
          }
          accent={
            plan.netGain != null
              ? plan.netGain > 15
                ? "var(--green-ink)"
                : plan.netGain < 0
                  ? "var(--bad)"
                  : undefined
              : undefined
          }
        />
      </div>

      {/* Repair line items */}
      {plan.repairs.length > 0 && (
        <div className="mt-7">
          <div className="mb-2 text-[13px] font-medium text-[var(--muted)]">
            Repairs to reach {plan.targetGrade}
          </div>
          <div>
            {plan.repairs.map((r, i) => (
              <div
                key={i}
                className="flex items-center justify-between border-b border-[var(--border)] py-3 text-[15px]"
              >
                <span>{r.label}</span>
                <span className="mono text-[var(--muted)]">${r.cost}</span>
              </div>
            ))}
            <div className="flex items-center justify-between py-3 text-[15px] font-semibold">
              <span>Total repair</span>
              <span className="mono">${plan.repairCost}</span>
            </div>
          </div>
        </div>
      )}

      <p className="mt-4 text-[15px] leading-relaxed text-[var(--muted)]">
        {plan.rationale}
      </p>
    </section>
  );
}

function Cell({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <div className="px-3 text-center">
      <div className="text-[12px] uppercase tracking-wider text-[var(--muted)]">
        {label}
      </div>
      <div
        className="mono mt-1 text-[22px] font-semibold"
        style={accent ? { color: accent } : undefined}
      >
        {value}
      </div>
    </div>
  );
}
