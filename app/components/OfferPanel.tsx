"use client";
import { useEffect, useState } from "react";
import { withBase } from "@/lib/basePath";

const APPLE_FONT =
  'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

// The offer engine now prices in the CLIENT's currency (see lib/priceCatalog).
// Hardcoding "$" here would print a dollar sign on a ₹ figure — the exact bug
// the India rollout hit — so every amount is formatted from offer.currency.
const SYM: Record<string, string> = { USD: "$", INR: "₹", EUR: "€" };

export default function OfferPanel({ sessionId }: { sessionId: string }) {
  const [offer, setOffer] = useState<any>(null);
  const [pc, setPc] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [preparing, setPreparing] = useState(false); // sign-out & wipe step
  const [verification, setVerification] = useState<any>(null);
  const [accepted, setAccepted] = useState(false);

  useEffect(() => {
    fetch(withBase(`/api/sessions/${sessionId}/offer`), { method: "POST" })
      .then((r) => r.json())
      .then((d) => {
        setOffer(d.offer);
        setPc(d.phonecheck);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [sessionId]);

  async function accept() {
    setAccepting(true);
    const r = await fetch(withBase(`/api/sessions/${sessionId}/accept`), {
      method: "POST",
    });
    const d = await r.json();
    setVerification(d.verification);
    setAccepted(d.passed);
    setAccepting(false);
  }

  const Shell = ({ children }: { children: React.ReactNode }) => (
    <section
      className="mt-4 rounded-3xl border border-[var(--border)] bg-[var(--card)] px-6 py-9 sm:px-10"
      style={{ fontFamily: APPLE_FONT }}
    >
      {children}
    </section>
  );

  if (loading)
    return <Shell><p className="text-[15px] text-[var(--muted)]">Preparing your offer…</p></Shell>;
  if (!offer) return null;

  // Can't price an unknown device — don't show a made-up number.
  if (offer.needsModel)
    return (
      <Shell>
        <div className="text-center">
          <h2 className="text-[22px] font-semibold tracking-tight">
            Identify the device first
          </h2>
          <p className="mx-auto mt-2 max-w-md text-[15px] text-[var(--muted)]">
            No make/model yet, so there&apos;s no market price to base an offer
            on. Scan the IMEI (dial <span className="mono">*#06#</span>) to fetch
            the model.
          </p>
          <a
            className="mt-6 inline-flex rounded-full bg-[var(--text)] px-5 py-2.5 text-[15px] font-medium text-[var(--bg)]"
            href={withBase("/")}
          >
            Scan IMEI →
          </a>
        </div>
      </Shell>
    );

  return (
    <Shell>
      {/* Headline offer */}
      <div className="text-center">
        <div className="text-[13px] font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
          {offer.provisional ? "Provisional offer" : "Trade-in offer"}
        </div>
        <div
          className="mt-2 text-[48px] font-semibold leading-none tracking-tight"
          style={{ color: offer.blocked ? "var(--bad)" : "var(--text)" }}
        >
          {offer.blocked ? "On hold" : money(offer.offer, offer.currency)}
        </div>
        {offer.provisional && !offer.blocked && (
          <div className="mt-2 text-[13px] text-[var(--muted)]">
            grade {offer.gradeRange?.best}–{offer.gradeRange?.worst} · floor $
            {offer.floor} · up to ${offer.ceiling} on inspection
          </div>
        )}
      </div>

      {/* Risk-share range bar */}
      {offer.provisional && !offer.blocked && (
        <div className="mt-6">
          <div className="relative h-1.5 rounded-full bg-[var(--bg-soft)]">
            <div
              className="absolute h-1.5 rounded-full"
              style={{
                left: 0,
                right: 0,
                background:
                  "linear-gradient(90deg, var(--bad), var(--gold-2), var(--green))",
                opacity: 0.4,
              }}
            />
            <div
              className="absolute -top-1 h-3.5 w-1.5 rounded bg-[var(--text)]"
              style={{
                left: `${
                  offer.ceiling! > offer.floor!
                    ? ((offer.offer - offer.floor!) /
                        (offer.ceiling! - offer.floor!)) *
                      100
                    : 50
                }%`,
              }}
            />
          </div>
          <div className="mt-1.5 flex justify-between text-[12px] text-[var(--muted)]">
            <span>floor ${offer.floor}</span>
            <span>ceiling ${offer.ceiling}</span>
          </div>
        </div>
      )}

      {/* Fraud / lock flags */}
      {offer.flags?.length > 0 && (
        <div className="mt-6 flex flex-col gap-2">
          {offer.flags.map((f: string, i: number) => (
            <div
              key={i}
              className="rounded-xl px-3 py-2 text-[13px]"
              style={{
                color: "var(--bad)",
                background: "color-mix(in oklch, var(--bad) 10%, transparent)",
              }}
            >
              {f}
            </div>
          ))}
        </div>
      )}

      {/* Breakdown */}
      <div className="mt-7">
        <Row label="Market resale (Grade A)" v={money(offer.marketBase, offer.currency)} />
        <Row label="After cosmetic grade" v={money(offer.gradedValue, offer.currency)} />
        {offer.lines?.map((l: any, i: number) => (
          <Row key={i} label={l.label} v={money(l.amount, offer.currency)} muted />
        ))}
        <Row label="Trade-in offer" v={money(offer.offer, offer.currency)} bold last />
      </div>

      {/* Explanation */}
      <details className="mt-4">
        <summary className="cursor-pointer text-[14px] font-medium text-[var(--text)]">
          Why this offer?
        </summary>
        <ul className="mt-2 flex flex-col gap-1 text-[14px] text-[var(--muted)]">
          {offer.explanation?.map((e: string, i: number) => (
            <li key={i}>• {e}</li>
          ))}
        </ul>
      </details>

      {/* Diagnostics — only when Phonecheck actually answered (no fabricated data) */}
      {pc?.source === "api" ? (
        <div className="mt-5 flex flex-wrap gap-x-5 gap-y-1 text-[13px] text-[var(--muted)]">
          <span>🔋 {pc.batteryHealth > 0 ? `${pc.batteryHealth}%` : "Battery unknown"}</span>
          <span
            style={{
              color:
                pc.fmip === "off"
                  ? "var(--green-ink)"
                  : pc.fmip === "on"
                    ? "var(--bad)"
                    : "var(--muted)",
            }}
          >
            {pc.fmip === "off" ? "FMiP off" : pc.fmip === "on" ? "FMiP on" : "FMiP unknown"}
          </span>
          <span style={{ color: pc.erasedKnown ? (pc.erased ? "var(--green-ink)" : "var(--gold-2)") : "var(--muted)" }}>
            {pc.erasedKnown ? (pc.erased ? "Erased" : "Not erased") : "Erasure unknown"}
          </span>
          <span>Phonecheck</span>
        </div>
      ) : pc?.source === "gsma" ? (
        /* GSMA registry answered but no station ever tested this phone. Say
           exactly which facts that buys and which it does not, rather than
           letting a populated model line imply a full diagnostic. */
        <div className="mt-5 flex flex-wrap gap-x-5 gap-y-1 text-[13px] text-[var(--muted)]">
          <span
            style={{
              color:
                pc.blacklist === "clean"
                  ? "var(--green-ink)"
                  : pc.blacklist === "blacklisted"
                    ? "var(--bad)"
                    : "var(--muted)",
            }}
          >
            {pc.blacklist === "clean"
              ? "Not reported lost or stolen"
              : pc.blacklist === "blacklisted"
                ? "Reported lost or stolen"
                : "Blacklist unknown"}
          </span>
          <span>Battery, Find My and SIM lock not checked</span>
          <span>GSMA registry</span>
        </div>
      ) : (
        <p className="mt-5 text-[13px] text-[var(--muted)]">
          {pc?.source === "not_found"
            ? "Phonecheck has no record for this device — battery health, Find My and blacklist remain unknown."
            : pc?.source === "error"
              ? "Phonecheck lookup failed — no diagnostic status was assumed."
              : pc?.source === "demo"
                ? "Demo diagnostics are active — these values are simulated and cannot authorize payout."
                : "Phonecheck is not configured — battery health, Find My and blacklist remain unknown."}
        </p>
      )}

      {/* Accept → sign out & wipe → verify → payout */}
      {!verification && !preparing ? (
        <button
          className="mt-7 w-full rounded-full bg-[var(--text)] py-3.5 text-[16px] font-medium text-[var(--bg)] disabled:opacity-40"
          onClick={() => setPreparing(true)}
          disabled={offer.blocked}
        >
          {offer.blocked ? "Resolve flags to accept" : `Accept ${money(offer.offer, offer.currency)} →`}
        </button>
      ) : !verification && preparing ? (
        <div className="mt-7 rounded-2xl bg-[var(--bg-soft)] p-5">
          <p className="text-[16px] font-semibold">Before payout — sign out &amp; wipe</p>
          <p className="mt-1 text-[14px] text-[var(--muted)]">
            You accepted <b>${offer.offer}</b>. Prep the device so we can release
            payment:
          </p>
          <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-[14px]">
            <li>
              Turn <b>OFF Find My iPhone</b> / activation lock (Android: remove
              the Google account &amp; screen lock).
            </li>
            <li>Sign out of your <b>iCloud / Google</b> account.</li>
            <li>
              Factory reset —{" "}
              <span className="mono">Settings → General → Reset → Erase All Content</span>.
            </li>
          </ol>
          <button
            className="mt-4 w-full rounded-full bg-[var(--text)] py-3 text-[15px] font-medium text-[var(--bg)] disabled:opacity-40"
            onClick={accept}
            disabled={accepting}
          >
            {accepting ? "Verifying…" : "✓ Signed out & reset — verify"}
          </button>
          <button
            className="mt-2 block w-full text-center text-[13px] text-[var(--muted)] underline"
            onClick={() => setPreparing(false)}
          >
            Back
          </button>
        </div>
      ) : (
        <div className="mt-7">
          <div
            className="rounded-2xl py-3 text-center text-[15px] font-semibold"
            style={{
              color: accepted ? "var(--green-ink)" : "var(--bad)",
              background: accepted
                ? "color-mix(in oklch, var(--green) 14%, transparent)"
                : "color-mix(in oklch, var(--bad) 10%, transparent)",
            }}
          >
            {accepted
              ? "Verified — payout released"
              : "Verification failed — cannot pay out yet"}
          </div>
          <div className="mt-3">
            {verification.checks.map((c: any, i: number) => (
              <div
                key={i}
                className="flex items-center justify-between border-b border-[var(--border)] py-3 text-[15px] last:border-0"
              >
                <span>{c.label}</span>
                <span
                  style={{
                    color: c.ok
                      ? "var(--green-ink)"
                      : c.critical
                        ? "var(--bad)"
                        : "var(--gold-2)",
                  }}
                >
                  {c.ok ? "✓" : c.critical ? "✕" : "!"}
                </span>
              </div>
            ))}
          </div>
          {!accepted && (
            <>
              <p className="mt-3 text-[13px] text-[var(--muted)]">
                Still signed in / not wiped. Turn off Find My &amp; erase the
                device, then re-verify.
              </p>
              <button
                className="mt-3 w-full rounded-full bg-[var(--text)] py-3 text-[15px] font-medium text-[var(--bg)] disabled:opacity-40"
                onClick={accept}
                disabled={accepting}
              >
                {accepting ? "Verifying…" : "Re-verify"}
              </button>
            </>
          )}
        </div>
      )}
    </Shell>
  );
}

function Row({
  label,
  v,
  bold,
  muted,
  last,
}: {
  label: string;
  v: string;
  bold?: boolean;
  muted?: boolean;
  last?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between py-3 text-[15px] ${
        last ? "" : "border-b border-[var(--border)]"
      } ${bold ? "font-semibold" : ""}`}
    >
      <span className={muted ? "text-[var(--muted)]" : ""}>{label}</span>
      <span className={`mono ${muted ? "text-[var(--muted)]" : ""}`}>{v}</span>
    </div>
  );
}

/** Format an amount in whatever currency the offer engine quoted. */
function money(amount: number | undefined, currency?: string): string {
  if (typeof amount !== "number" || !Number.isFinite(amount)) return "—";
  const sym = SYM[currency || "USD"] ?? "";
  const neg = amount < 0;
  const n = Math.abs(Math.round(amount));
  const grouped =
    currency === "INR"
      ? (() => {
          const str = String(n);
          if (str.length <= 3) return str;
          return `${str.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${str.slice(-3)}`;
        })()
      : n.toLocaleString("en-US");
  return `${neg ? "-" : ""}${sym}${grouped}`;
}
