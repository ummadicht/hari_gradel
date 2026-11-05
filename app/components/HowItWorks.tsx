"use client";
import { useEffect, useRef, useState } from "react";
import { withBase } from "@/lib/basePath";

/**
 * GradeIQ — "How it works" help page.
 *
 * A guided, auto-playing walkthrough of the five inspection stages
 * (Identify → Diagnostics → Photos & grade → Review & offer → Complete), an
 * "under the hood" tech explainer, and a Help / FAQ. Animation is state-driven
 * + CSS keyframes only (the app has no framer-motion), and respects
 * prefers-reduced-motion. Design language matches the app: teal brand accent,
 * gold highlight, green/gold/red grade scale, soft cards, tight headings.
 */

type Accent = "teal" | "green" | "gold";
const STEPS: {
  id: string;
  kicker: string;
  title: string;
  blurb: string;
  tech: string;
  accent: Accent;
  Icon: (p: { className?: string }) => React.ReactElement;
}[] = [
  {
    id: "identify",
    kicker: "Step 1 — Identify",
    title: "Scan the IMEI",
    blurb:
      "Dial *#06# or scan the barcode. GradeIQ confirms the exact make, model and storage, and checks it against the device in hand.",
    tech: "IMEI verification",
    accent: "teal",
    Icon: IconScan,
  },
  {
    id: "diagnostics",
    kicker: "Step 2 — Diagnostics",
    title: "Run on-device tests",
    blurb:
      "Touch, display, speakers, mic, cameras, sensors and buttons — checked live in the browser through quick guided tests. A second phone can scan a QR to help test the first.",
    tech: "Browser-native",
    accent: "green",
    Icon: IconPulse,
  },
  {
    id: "cosmetics",
    kicker: "Step 3 — Photos & grade",
    title: "Capture every side — AI grades it",
    blurb:
      "Six guided angles. A vision-AI cascade inspects each surface, boxes every mark it finds, and settles on one cosmetic grade.",
    tech: "Vision AI",
    accent: "teal",
    Icon: IconCamera,
  },
  {
    id: "review",
    kicker: "Step 4 — Review & offer",
    title: "DeviceFax + instant price",
    blurb:
      "One verified record — identity, battery, condition and function, signed — alongside a transparent trade-in offer you can explain line by line.",
    tech: "DeviceFax passport",
    accent: "gold",
    Icon: IconDoc,
  },
  {
    id: "complete",
    kicker: "Step 5 — Complete",
    title: "Record & pay out",
    blurb:
      "Accept the offer, run the clearance checks, and pay out — every step written to an auditable ledger.",
    tech: "Ledger + UPI",
    accent: "green",
    Icon: IconCheck,
  },
];

const ACCENT_VAR: Record<Accent, string> = {
  teal: "var(--brand)",
  green: "var(--green-ink)",
  gold: "var(--gold-2)",
};

export default function HowItWorks() {
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);

  // Auto-advance through the stages; pause on hover/focus so a reader can dwell.
  useEffect(() => {
    if (paused) return;
    const t = setInterval(() => setActive((a) => (a + 1) % STEPS.length), 3600);
    return () => clearInterval(t);
  }, [paused, active]);

  const step = STEPS[active];

  return (
    <div className="min-h-[100dvh] bg-[var(--bg)] text-[var(--text)]">
      <StyleBlock />

      {/* Header */}
      <header className="sticky top-0 z-20 border-b border-[var(--border)] bg-[color-mix(in_oklch,var(--bg)_86%,transparent)] backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-3.5 sm:px-8">
          <a href={withBase("/")} className="flex items-center gap-2.5">
            <div className="brandmark h-8 w-8 text-[12px]">IQ</div>
            <span className="text-[15px] font-semibold tracking-tight">GradeIQ</span>
          </a>
          <a
            href={withBase("/inspect")}
            className="rounded-full px-4 py-2 text-[13px] font-semibold text-white"
            style={{ background: "var(--grad)", boxShadow: "0 2px 8px oklch(0.2 0.02 90 / 0.18)" }}
          >
            Start inspection →
          </a>
        </div>
      </header>

      {/* Hero */}
      <section className="mx-auto max-w-6xl px-5 pt-16 pb-10 text-center sm:px-8 sm:pt-24">
        <div className="text-[12px] font-semibold uppercase tracking-[0.2em] text-[var(--brand)]">
          How it works
        </div>
        <h1 className="mx-auto mt-4 max-w-3xl text-[38px] font-semibold leading-[1.04] tracking-[-0.03em] sm:text-[60px]">
          From phone to price in about{" "}
          <span style={{ color: "var(--brand)" }}>90 seconds</span>.
        </h1>
        <p className="mx-auto mt-5 max-w-xl text-[16px] leading-relaxed text-[var(--muted)] sm:text-[18px]">
          No app, no kiosk. GradeIQ scans, tests, inspects and prices any device
          through five guided steps — all in the browser, with AI you can audit.
        </p>
        <div className="mt-7 flex flex-wrap items-center justify-center gap-2.5">
          {["Browser-native", "AI-graded", "Tamper-evident report"].map((t) => (
            <span
              key={t}
              className="rounded-full border border-[var(--border)] bg-[var(--card)] px-3.5 py-1.5 text-[13px] font-medium text-[var(--muted)]"
            >
              {t}
            </span>
          ))}
        </div>
      </section>

      {/* The animated flow */}
      <section className="mx-auto max-w-6xl px-5 pb-6 sm:px-8">
        {/* Stepper rail */}
        <div className="mx-auto mb-6 flex max-w-3xl items-center">
          {STEPS.map((s, i) => (
            <div key={s.id} className="flex flex-1 items-center last:flex-none">
              <button
                onClick={() => setActive(i)}
                aria-label={s.title}
                className="group flex flex-col items-center gap-2"
                style={{ width: 44 }}
              >
                <span
                  className="grid h-9 w-9 place-items-center rounded-full text-[13px] font-bold transition-all duration-300"
                  style={
                    i <= active
                      ? { background: "var(--gold-hex)", color: "var(--ink)", boxShadow: "0 2px 8px oklch(0.58 0.13 74 / 0.32)" }
                      : { background: "var(--card)", color: "var(--muted)", border: "1px solid var(--border)" }
                  }
                >
                  {i < active ? "✓" : i + 1}
                </span>
              </button>
              {i < STEPS.length - 1 && (
                <div className="relative mx-1 h-[3px] flex-1 overflow-hidden rounded-full bg-[var(--border)]">
                  <div
                    className="absolute inset-y-0 left-0 rounded-full transition-all duration-500"
                    style={{ width: i < active ? "100%" : "0%", background: "var(--gold-hex)" }}
                  />
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Stage: device animation + live caption */}
        <div
          className="grid items-center gap-8 rounded-[28px] border border-[var(--border)] p-6 sm:grid-cols-[minmax(0,300px)_1fr] sm:p-10"
          style={{
            background:
              "radial-gradient(120% 120% at 20% 0%, color-mix(in oklch, var(--brand) 9%, var(--card)) 0%, var(--card) 55%)",
            boxShadow: "0 24px 60px -30px oklch(0.4 0.05 240 / 0.35)",
          }}
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
        >
          {/* Device */}
          <div className="flex justify-center">
            <div className="hiw-phone floaty" aria-hidden>
              <div className="hiw-notch" />
              <div className="hiw-screen">
                {/* key forces the scene animations to replay on step change */}
                <div key={active} className="hiw-scene">
                  <Scene index={active} />
                </div>
              </div>
            </div>
          </div>

          {/* Caption */}
          <div>
            <div
              className="text-[12px] font-semibold uppercase tracking-[0.16em]"
              style={{ color: ACCENT_VAR[step.accent] }}
            >
              {step.kicker}
            </div>
            <h2 className="mt-2 text-[26px] font-semibold leading-tight tracking-[-0.02em] sm:text-[32px]">
              {step.title}
            </h2>
            <p className="mt-3 max-w-md text-[16px] leading-relaxed text-[var(--muted)]">
              {step.blurb}
            </p>
            <span
              className="mt-5 inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[13px] font-semibold"
              style={{
                color: ACCENT_VAR[step.accent],
                background: `color-mix(in oklch, ${ACCENT_VAR[step.accent]} 12%, transparent)`,
              }}
            >
              <step.Icon className="h-4 w-4" />
              {step.tech}
            </span>
          </div>
        </div>
      </section>

      {/* Step reference grid */}
      <section className="mx-auto max-w-6xl px-5 py-14 sm:px-8">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {STEPS.map((s, i) => (
            <button
              key={s.id}
              onClick={() => {
                setActive(i);
                window.scrollTo({ top: 0, behavior: "smooth" });
              }}
              className="group flex flex-col items-start rounded-3xl border border-[var(--border)] bg-[var(--card)] p-6 text-left transition-all hover:-translate-y-0.5"
              style={{ boxShadow: "0 1px 2px oklch(0.4 0.05 240 / 0.04)" }}
            >
              <div className="flex w-full items-center justify-between">
                <span
                  className="grid h-11 w-11 place-items-center rounded-2xl"
                  style={{
                    color: ACCENT_VAR[s.accent],
                    background: `color-mix(in oklch, ${ACCENT_VAR[s.accent]} 12%, transparent)`,
                  }}
                >
                  <s.Icon className="h-5 w-5" />
                </span>
                <span className="text-[13px] font-semibold text-[var(--muted)]">
                  {String(i + 1).padStart(2, "0")}
                </span>
              </div>
              <h3 className="mt-4 text-[17px] font-semibold tracking-[-0.01em]">{s.title}</h3>
              <p className="mt-1.5 text-[14px] leading-relaxed text-[var(--muted)]">{s.blurb}</p>
            </button>
          ))}
        </div>
      </section>

      {/* Under the hood */}
      <section className="border-y border-[var(--border)] bg-[var(--bg-soft)]">
        <div className="mx-auto max-w-6xl px-5 py-16 sm:px-8">
          <div className="max-w-2xl">
            <div className="text-[12px] font-semibold uppercase tracking-[0.2em] text-[var(--brand)]">
              Under the hood
            </div>
            <h2 className="mt-3 text-[28px] font-semibold leading-tight tracking-[-0.02em] sm:text-[38px]">
              Fast because it&apos;s honest.
            </h2>
            <p className="mt-3 text-[16px] leading-relaxed text-[var(--muted)]">
              GradeIQ never fakes a number. Every grade is inspected, every mark
              is located, and the record is signed.
            </p>
          </div>
          <div className="mt-9 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { Icon: IconBrowser, t: "Runs in the browser", d: "Camera and sensors, right on the device — no app to install, no kiosk to buy." },
              { Icon: IconSpark, t: "AI you can audit", d: "A vision-AI cascade boxes and labels every mark it finds. Nothing is typed by hand." },
              { Icon: IconShield, t: "One signed record", d: "A DeviceFax passport with a SHA-256 signature, checked against the scanned IMEI." },
              { Icon: IconLock, t: "Private & keyless", d: "Runs on your own data; third-party services stay gated behind your own keys." },
            ].map((c) => (
              <div key={c.t} className="rounded-3xl border border-[var(--border)] bg-[var(--card)] p-6">
                <span className="grid h-11 w-11 place-items-center rounded-2xl text-[var(--brand)]" style={{ background: "color-mix(in oklch, var(--brand) 12%, transparent)" }}>
                  <c.Icon className="h-5 w-5" />
                </span>
                <h3 className="mt-4 text-[16px] font-semibold tracking-[-0.01em]">{c.t}</h3>
                <p className="mt-1.5 text-[14px] leading-relaxed text-[var(--muted)]">{c.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Help / FAQ */}
      <section className="mx-auto max-w-3xl px-5 py-16 sm:px-8">
        <div className="text-center">
          <div className="text-[12px] font-semibold uppercase tracking-[0.2em] text-[var(--brand)]">
            Help
          </div>
          <h2 className="mt-3 text-[28px] font-semibold tracking-[-0.02em] sm:text-[38px]">
            Questions, answered
          </h2>
        </div>
        <div className="mt-9 space-y-3">
          {FAQ.map((f, i) => (
            <Faq key={i} q={f.q} a={f.a} />
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="mx-auto max-w-6xl px-5 pb-20 sm:px-8">
        <div
          className="relative overflow-hidden rounded-[28px] px-8 py-14 text-center sm:py-16"
          style={{ background: "var(--grad)" }}
        >
          <h2 className="relative text-[28px] font-semibold leading-tight tracking-[-0.02em] text-white sm:text-[40px]">
            Grade your first device now.
          </h2>
          <p className="relative mx-auto mt-3 max-w-md text-[16px] leading-relaxed text-white/85">
            It takes about 90 seconds and runs entirely in this browser.
          </p>
          <div className="relative mt-8 flex flex-wrap items-center justify-center gap-3">
            <a
              href={withBase("/inspect")}
              className="rounded-full px-7 py-3.5 text-[16px] font-semibold text-[var(--ink)] transition-transform hover:scale-[1.02]"
              style={{ background: "var(--gold-hex)" }}
            >
              Start inspection →
            </a>
            <a
              href={withBase("/enterprise")}
              className="rounded-full border border-white/40 px-7 py-3.5 text-[16px] font-semibold text-white transition-colors hover:bg-white/10"
            >
              Open the console
            </a>
          </div>
        </div>
      </section>

      <footer className="border-t border-[var(--border)] py-8 text-center text-[13px] text-[var(--muted)]">
        GradeIQ · Browser-native device inspection · no install
      </footer>
    </div>
  );
}

/* ─────────────────────────  Scenes (per-step device art)  ───────────────────────── */

function Scene({ index }: { index: number }) {
  if (index === 0) return <SceneIdentify />;
  if (index === 1) return <SceneDiagnostics />;
  if (index === 2) return <SceneGrade />;
  if (index === 3) return <SceneOffer />;
  return <SceneComplete />;
}

function SceneIdentify() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-4">
      <div className="hiw-fade text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">
        Identify
      </div>
      <div className="relative w-full">
        {/* barcode */}
        <div className="flex h-16 items-end justify-center gap-[3px] rounded-xl bg-[var(--bg-soft)] px-3 py-2">
          {[3, 6, 2, 8, 4, 2, 7, 3, 5, 2, 8, 3, 4, 6, 2].map((h, i) => (
            <span key={i} className="w-[3px] rounded-sm bg-[var(--text)]" style={{ height: `${h * 5}px`, opacity: 0.85 }} />
          ))}
        </div>
        {/* scan line */}
        <div className="hiw-scanline" />
      </div>
      <div className="hiw-fade hiw-d2 mono rounded-lg bg-[var(--card)] px-3 py-1.5 text-[12px] font-semibold tracking-wide shadow-sm">
        *#06# → IMEI
      </div>
      <div className="hiw-fade hiw-d3 flex items-center gap-1.5 text-[12px] font-semibold" style={{ color: "var(--green-ink)" }}>
        <Dot c="var(--green)" /> Device confirmed
      </div>
    </div>
  );
}

function SceneDiagnostics() {
  const tiles = ["Touch", "Display", "Speaker", "Mic", "Camera", "Sensors"];
  return (
    <div className="flex h-full flex-col justify-center gap-3 px-4">
      <div className="hiw-fade text-center text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">
        Live checks
      </div>
      <div className="grid grid-cols-2 gap-2">
        {tiles.map((t, i) => (
          <div
            key={t}
            className="hiw-tile flex items-center justify-between rounded-xl border border-[var(--border)] bg-[var(--card)] px-3 py-2.5"
            style={{ animationDelay: `${0.15 + i * 0.28}s` }}
          >
            <span className="text-[12px] font-medium">{t}</span>
            <span
              className="hiw-tick grid h-5 w-5 place-items-center rounded-full text-[11px] text-white"
              style={{ background: "var(--green)", animationDelay: `${0.35 + i * 0.28}s` }}
            >
              ✓
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SceneGrade() {
  return (
    <div className="relative flex h-full items-center justify-center">
      {/* photo backdrop */}
      <div className="absolute inset-4 rounded-2xl" style={{ background: "linear-gradient(160deg, oklch(0.72 0.03 240), oklch(0.5 0.03 240))" }} />
      {/* device silhouette */}
      <div className="absolute inset-x-12 inset-y-8 rounded-2xl border-2 border-white/25" />
      {/* AI boxes */}
      <div className="hiw-box absolute left-8 top-16 h-12 w-14 rounded-md" style={{ border: "2px solid var(--brand)", boxShadow: "0 0 0 3px color-mix(in oklch, var(--brand) 25%, transparent)", animationDelay: "0.25s" }}>
        <span className="mono absolute -top-5 left-0 rounded bg-[var(--brand)] px-1.5 py-0.5 text-[9px] font-bold text-white">Scuff</span>
      </div>
      <div className="hiw-box absolute bottom-16 right-9 h-10 w-12 rounded-md" style={{ border: "2px solid var(--bad)", boxShadow: "0 0 0 3px color-mix(in oklch, var(--bad) 22%, transparent)", animationDelay: "0.6s" }}>
        <span className="mono absolute -top-5 left-0 rounded bg-[var(--bad)] px-1.5 py-0.5 text-[9px] font-bold text-white">Crack</span>
      </div>
      {/* grade badge */}
      <div className="hiw-pop absolute grid h-16 w-16 place-items-center rounded-full text-[30px] font-bold text-white" style={{ background: "var(--grad-green)", boxShadow: "0 10px 24px oklch(0.75 0.2 155 / 0.4)", animationDelay: "1s" }}>
        A
      </div>
    </div>
  );
}

function SceneOffer() {
  const [price, setPrice] = useState(0);
  const target = 41200;
  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const dur = 1100;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      setPrice(Math.round(target * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div className="flex h-full flex-col justify-center gap-2.5 px-4">
      <div className="hiw-fade text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--muted)]">
        DeviceFax
      </div>
      {[
        ["Model", "iPhone 15 Pro"],
        ["Battery", "91%"],
        ["Condition", "A · Excellent"],
        ["Function", "Working"],
      ].map(([k, v], i) => (
        <div key={k} className="hiw-row flex items-center justify-between border-b border-[var(--border)] pb-1.5 text-[12px]" style={{ animationDelay: `${i * 0.12}s` }}>
          <span className="text-[var(--muted)]">{k}</span>
          <span className="font-semibold">{v}</span>
        </div>
      ))}
      <div className="hiw-row mt-1 flex items-center justify-between rounded-xl px-3 py-2.5" style={{ background: "color-mix(in oklch, var(--gold) 16%, transparent)", animationDelay: "0.55s" }}>
        <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--gold-2)" }}>
          Offer
        </span>
        <span className="mono text-[18px] font-bold" style={{ color: "var(--text)" }}>
          ₹{price.toLocaleString("en-IN")}
        </span>
      </div>
    </div>
  );
}

function SceneComplete() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-4">
      <svg viewBox="0 0 64 64" className="h-20 w-20">
        <circle cx="32" cy="32" r="28" fill="none" stroke="var(--green)" strokeWidth="4" className="hiw-ring" />
        <path d="M20 33 l8 8 l16 -18" fill="none" stroke="var(--green-ink)" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" className="hiw-check" />
      </svg>
      <div className="hiw-fade hiw-d2 text-[14px] font-semibold">Trade-in recorded</div>
      <div className="hiw-fade hiw-d3 flex items-center gap-2 rounded-full bg-[var(--card)] px-3.5 py-1.5 text-[12px] font-semibold shadow-sm" style={{ color: "var(--green-ink)" }}>
        <Dot c="var(--green)" /> Paid out · UPI
      </div>
    </div>
  );
}

function Dot({ c }: { c: string }) {
  return <span className="h-1.5 w-1.5 rounded-full" style={{ background: c }} />;
}

/* ─────────────────────────────────  FAQ  ───────────────────────────────────── */

const FAQ = [
  { q: "Do I need to install an app?", a: "No. GradeIQ is browser-native — the camera, sensors and functional tests all run on the web page. Open the link and start; nothing to download and no kiosk hardware." },
  { q: "What's an IMEI and how do I find it?", a: "The IMEI is your phone's unique serial. Dial *#06# on the device to display it, or scan the barcode on the box or under Settings → About. GradeIQ uses it to confirm the exact model and to check the phone in hand matches." },
  { q: "How is the cosmetic grade decided?", a: "A vision-AI cascade inspects each captured side, boxes and labels every mark it finds, and maps them to a rubric that produces one grade (Premium / A / B / C / D). Every mark is shown on the photo — nothing is entered by hand." },
  { q: "What if the AI can't grade a photo?", a: "It says so. If glare, blur or a missing angle means a surface can't be assessed, GradeIQ flags a retake or lets you pick the condition manually — it never guesses a grade off a photo it couldn't actually see." },
  { q: "Does it work on both iPhone and Android?", a: "Yes. The test set is platform-aware — e.g. Face ID only appears on iOS devices — so the checklist always matches the phone being inspected." },
  { q: "What is the DeviceFax report?", a: "It's the single verified record for a device: identity, battery, cosmetic condition, functional results and a trade-in price, sealed with a SHA-256 signature and checked against the scanned IMEI." },
  { q: "Is the device data private?", a: "It runs on your own instance and stores to your own database. Third-party services (AI grading, payouts) are only called when you add your own keys — otherwise it runs in a self-contained mode." },
];

function Faq({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  return (
    <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--card)]">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left"
      >
        <span className="text-[15px] font-semibold tracking-[-0.01em]">{q}</span>
        <span
          className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-[var(--border)] text-[var(--muted)] transition-transform duration-300"
          style={{ transform: open ? "rotate(45deg)" : "none" }}
        >
          +
        </span>
      </button>
      <div
        ref={bodyRef}
        className="grid transition-all duration-300 ease-out"
        style={{ gridTemplateRows: open ? "1fr" : "0fr" }}
      >
        <div className="overflow-hidden">
          <p className="px-5 pb-4 text-[14px] leading-relaxed text-[var(--muted)]">{a}</p>
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────────────  Icons  ─────────────────────────────────── */

function svg(children: React.ReactNode, className?: string) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className={className}>
      {children}
    </svg>
  );
}
function IconScan({ className }: { className?: string }) {
  return svg(<>{[<path key="a" d="M4 8V6a2 2 0 0 1 2-2h2" />, <path key="b" d="M20 8V6a2 2 0 0 0-2-2h-2" />, <path key="c" d="M4 16v2a2 2 0 0 0 2 2h2" />, <path key="d" d="M20 16v2a2 2 0 0 1-2 2h-2" />, <path key="e" d="M4 12h16" />]}</>, className);
}
function IconPulse({ className }: { className?: string }) {
  return svg(<path d="M3 12h4l2 6 4-14 2 8h6" />, className);
}
function IconCamera({ className }: { className?: string }) {
  return svg(<>{[<path key="a" d="M3 8a2 2 0 0 1 2-2h2l1.5-2h7L19 6h0a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />, <circle key="b" cx="12" cy="13" r="3.5" />]}</>, className);
}
function IconDoc({ className }: { className?: string }) {
  return svg(<>{[<path key="a" d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />, <path key="b" d="M14 3v4h4" />, <path key="c" d="M8 12h8M8 16h5" />]}</>, className);
}
function IconCheck({ className }: { className?: string }) {
  return svg(<>{[<circle key="a" cx="12" cy="12" r="9" />, <path key="b" d="M8 12.5l2.5 2.5L16 9.5" />]}</>, className);
}
function IconBrowser({ className }: { className?: string }) {
  return svg(<>{[<rect key="a" x="3" y="4" width="18" height="16" rx="2" />, <path key="b" d="M3 8h18" />, <circle key="c" cx="6" cy="6" r="0.5" />]}</>, className);
}
function IconSpark({ className }: { className?: string }) {
  return svg(<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />, className);
}
function IconShield({ className }: { className?: string }) {
  return svg(<>{[<path key="a" d="M12 3l7 3v5c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6z" />, <path key="b" d="M9 12l2 2 4-4" />]}</>, className);
}
function IconLock({ className }: { className?: string }) {
  return svg(<>{[<rect key="a" x="5" y="11" width="14" height="9" rx="2" />, <path key="b" d="M8 11V8a4 4 0 0 1 8 0v3" />]}</>, className);
}

/* ─────────────────────────────  scoped styles  ───────────────────────────── */

function StyleBlock() {
  return (
    <style>{`
      .hiw-phone{position:relative;width:236px;height:472px;border-radius:38px;
        background:linear-gradient(160deg,#1c2530,#0d1218);padding:11px;
        box-shadow:0 40px 80px -30px oklch(0.3 0.05 240 / .55), inset 0 0 0 2px rgba(255,255,255,.06);}
      .hiw-notch{position:absolute;top:20px;left:50%;transform:translateX(-50%);width:96px;height:24px;
        border-radius:999px;background:#05080c;z-index:2;}
      .hiw-screen{position:relative;height:100%;width:100%;border-radius:28px;overflow:hidden;
        background:var(--bg);}
      .hiw-scene{position:absolute;inset:0;}

      .hiw-fade{opacity:0;animation:hiwUp .5s ease-out forwards;}
      .hiw-d2{animation-delay:.5s;}
      .hiw-d3{animation-delay:.9s;}
      .hiw-row{opacity:0;animation:hiwUp .45s ease-out forwards;}
      .hiw-tile{opacity:0;animation:hiwPop .4s cubic-bezier(.2,.9,.3,1.3) forwards;}
      .hiw-tick{transform:scale(0);animation:hiwPop .35s cubic-bezier(.2,.9,.3,1.4) forwards;}
      .hiw-box{opacity:0;animation:hiwBox .45s ease-out forwards;}
      .hiw-pop{opacity:0;transform:scale(.4);animation:hiwPop .5s cubic-bezier(.2,.9,.3,1.4) forwards;}

      .hiw-scanline{position:absolute;left:6%;right:6%;top:0;height:2px;border-radius:2px;
        background:linear-gradient(90deg,transparent,var(--brand),transparent);
        box-shadow:0 0 12px 2px color-mix(in oklch, var(--brand) 60%, transparent);
        animation:hiwScan 1.8s ease-in-out infinite;}

      .hiw-ring{stroke-dasharray:176;stroke-dashoffset:176;animation:hiwDash .7s ease-out forwards;}
      .hiw-check{stroke-dasharray:44;stroke-dashoffset:44;animation:hiwDash .5s .55s ease-out forwards;}

      .hiw-cta-glow{position:absolute;inset:-40% -10% auto;height:80%;
        background:radial-gradient(50% 60% at 50% 0%, rgba(255,255,255,.35), transparent 70%);}

      @keyframes hiwUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
      @keyframes hiwPop{0%{opacity:0;transform:scale(.5)}60%{transform:scale(1.08)}100%{opacity:1;transform:scale(1)}}
      @keyframes hiwBox{from{opacity:0;transform:scale(1.15)}to{opacity:1;transform:scale(1)}}
      @keyframes hiwScan{0%{top:2px}50%{top:88%}100%{top:2px}}
      @keyframes hiwDash{to{stroke-dashoffset:0}}

      @media (prefers-reduced-motion: reduce){
        .hiw-phone.floaty,.hiw-fade,.hiw-row,.hiw-tile,.hiw-tick,.hiw-box,.hiw-pop,
        .hiw-scanline,.hiw-ring,.hiw-check{animation:none !important;opacity:1 !important;transform:none !important;stroke-dashoffset:0 !important;}
      }
    `}</style>
  );
}
