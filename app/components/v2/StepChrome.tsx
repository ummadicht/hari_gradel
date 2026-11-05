"use client";
import { useId, useState, type ReactNode } from "react";
import { TX } from "@/lib/clientTheme";

// ── v2 step chrome — the ONE skeleton every screen of the guided flow composes.
// Pandas' consumer flow works because every screen is the same shape: eyebrow →
// headline → one plain sentence → illustration → options → a single bottom CTA.
// Centralising that here means a new step is content, not layout, and the whole
// flow re-themes (light swapmore / dark GradeIQ) from the --t-* vars alone.

export type StepCta = {
  label: string;
  /** Instructional copy shown INSTEAD of `label` while disabled ("Select an option to continue"). */
  disabledLabel?: string;
  enabled: boolean;
  onClick: () => void;
  busy?: boolean;
};

export type StepShellProps = {
  eyebrow?: string;
  title: string;
  sub?: string;
  illustration?: ReactNode;
  children?: ReactNode;
  onBack?: () => void;
  help?: { label: string; body: string };
  cta: StepCta;
  progress?: { step: number; total: number };
};

export function StepShell({
  eyebrow,
  title,
  sub,
  illustration,
  children,
  onBack,
  help,
  cta,
  progress,
}: StepShellProps) {
  const [helpOpen, setHelpOpen] = useState(false);
  const helpId = useId();

  const busy = cta.busy === true;
  const ctaDisabled = !cta.enabled || busy;
  // Disabled state must TEACH ("Select an option to continue"), never just grey out.
  const ctaLabel = cta.enabled ? cta.label : cta.disabledLabel ?? cta.label;

  return (
    <div
      className="flex min-h-[100dvh] flex-col"
      style={{ background: "var(--t-bg)", color: "var(--t-text)" }}
    >
      {progress ? (
        <div className="px-5 pt-5">
          <ProgressRail step={progress.step} total={progress.total} />
        </div>
      ) : null}

      {/* Middle scrolls with the page; the dock below is sticky, which behaves far
          better than an inner overflow container on mobile URL-bar resizes. */}
      <div className="flex-1 px-5 pb-8 pt-6">
        {eyebrow ? (
          <p className={TX.eyebrow} style={{ color: "var(--t-accent-ink)" }}>
            {eyebrow}
          </p>
        ) : null}

        <h1 className={`${eyebrow ? "mt-2" : ""} ${TX.h1}`}>{title}</h1>

        {sub ? (
          <p className={TX.sub} style={{ color: "var(--t-muted)" }}>
            {sub}
          </p>
        ) : null}

        {illustration ? (
          <div className="mt-7 flex justify-center">{illustration}</div>
        ) : null}

        {children ? <div className="mt-7">{children}</div> : null}
      </div>

      <div
        className="sticky bottom-0 z-10 px-5 pt-3"
        style={{
          background: "var(--t-bg)",
          borderTop: "1px solid var(--t-border)",
          paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 16px)",
        }}
      >
        {help && helpOpen ? (
          <div
            id={helpId}
            className="mb-3 rounded-2xl border p-4 text-[14px] leading-relaxed"
            style={{
              background: "var(--t-card-alt)",
              borderColor: "var(--t-border)",
              color: "var(--t-muted)",
            }}
          >
            {help.body}
          </div>
        ) : null}

        {onBack || help ? (
          <div className="mb-3 flex items-center gap-3">
            {onBack ? (
              <button
                type="button"
                onClick={onBack}
                aria-label="Go back"
                className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl border transition active:scale-[0.97]"
                style={{
                  background: "var(--t-card)",
                  borderColor: "var(--t-border)",
                  color: "var(--t-text)",
                }}
              >
                <ArrowLeft />
              </button>
            ) : null}

            {help ? (
              <HelpPill
                label={help.label}
                open={helpOpen}
                panelId={helpId}
                onToggle={() => setHelpOpen((v) => !v)}
              />
            ) : null}
          </div>
        ) : null}

        <button
          type="button"
          onClick={cta.onClick}
          disabled={ctaDisabled}
          className={`${TX.cta} min-h-[56px] transition active:scale-[0.99]`}
          style={{
            background: "var(--t-cta-bg)",
            color: "var(--t-cta-text)",
            borderRadius: "var(--t-cta-radius)",
          }}
        >
          {busy ? <Spinner /> : null}
          <span>{ctaLabel}</span>
          {/* The arrow is a promise of forward motion — hide it when we can't move. */}
          {!busy && cta.enabled ? <ArrowRight /> : null}
        </button>
      </div>
    </div>
  );
}

/** Slim segment rail. Done AND active segments read as accent; the rest are hairlines. */
function ProgressRail({ step, total }: { step: number; total: number }) {
  // Guard bad input — a 0/negative total would render an empty (or crashing) rail.
  const count = Math.max(1, Math.floor(total));
  const filled = Math.min(count, Math.max(0, Math.floor(step)));
  return (
    <>
      <div className="flex items-center gap-1.5" aria-hidden="true">
        {Array.from({ length: count }, (_, i) => (
          <span
            key={i}
            className="h-1.5 flex-1 rounded-full transition-colors"
            style={{ background: i < filled ? "var(--t-accent)" : "var(--t-border)" }}
          />
        ))}
      </div>
      <span className="sr-only">{`Step ${filled} of ${count}`}</span>
    </>
  );
}

/** Internal by design — help always belongs to a StepShell, never floats alone. */
function HelpPill({
  label,
  open,
  panelId,
  onToggle,
}: {
  label: string;
  open: boolean;
  panelId: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={panelId}
      className="flex h-14 flex-1 items-center justify-between gap-2 rounded-2xl border px-4 text-[15px] font-semibold transition active:scale-[0.99]"
      style={{
        background: open ? "var(--t-accent-soft)" : "var(--t-card)",
        borderColor: open ? "var(--t-accent)" : "var(--t-border)",
        color: "var(--t-text)",
      }}
    >
      <span className="truncate">{label}</span>
      <span
        className="grid h-6 w-6 shrink-0 place-items-center rounded-full border text-[12px] font-bold"
        style={{ borderColor: "var(--t-accent)", color: "var(--t-accent-ink)" }}
        aria-hidden="true"
      >
        i
      </span>
    </button>
  );
}

export type OptionCardProps = {
  title: string;
  body?: string;
  selected: boolean;
  onSelect: () => void;
  disabled?: boolean;
};

/** The big tappable radio card — the primary way a user answers a step. */
export function OptionCard({ title, body, selected, onSelect, disabled = false }: OptionCardProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      // aria-pressed (not role=radio) so the card stays valid without a radiogroup wrapper.
      aria-pressed={selected}
      className={`${TX.card} flex min-h-[72px] w-full items-center gap-3 active:scale-[0.99] disabled:pointer-events-none disabled:opacity-45`}
      style={{
        background: selected ? "var(--t-accent-soft)" : "var(--t-card)",
        borderColor: selected ? "var(--t-accent)" : "var(--t-border)",
        // Both shadows are theme-derived: a literal black would read as a heavy
        // smudge under every card on the LIGHT swapmore theme.
        boxShadow: selected ? "0 8px 22px -14px var(--t-accent)" : "0 6px 18px -14px var(--t-border)",
      }}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[16px] font-bold leading-snug" style={{ color: "var(--t-text)" }}>
          {title}
        </span>
        {body ? (
          <span className="mt-1 block text-[13px] leading-snug" style={{ color: "var(--t-muted)" }}>
            {body}
          </span>
        ) : null}
      </span>
      <RadioDot selected={selected} />
    </button>
  );
}

function RadioDot({ selected }: { selected: boolean }) {
  return (
    <span
      className="grid h-6 w-6 shrink-0 place-items-center rounded-full border-2 transition"
      style={{
        borderColor: selected ? "var(--t-accent)" : "var(--t-border)",
        background: selected ? "var(--t-accent)" : "transparent",
      }}
      aria-hidden="true"
    >
      {selected ? (
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" aria-hidden="true">
          <path
            d="M5 12.5 10 17.5 19 7"
            stroke="var(--t-cta-text)"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : null}
    </span>
  );
}

function Spinner() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5 animate-spin" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

function ArrowRight() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" aria-hidden="true">
      <path
        d="M5 12h13M12 5l7 7-7 7"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ArrowLeft() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" aria-hidden="true">
      <path
        d="M19 12H6M13 5l-7 7 7 7"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export default StepShell;
