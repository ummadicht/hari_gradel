"use client";
import { useState } from "react";
import { withBase } from "@/lib/basePath";

// The front door. Pandas-simple, Apple-clean: one line, one button. Everything
// else (scan → capture → grade → report) unfolds from here, one screen at a time.
export default function Landing() {
  const [starting, setStarting] = useState(false);

  function start() {
    setStarting(true);
    // The seamless linear inspection: scan → verify → link device → capture.
    window.location.href = withBase("/inspect");
  }

  return (
    <div className="flex min-h-[100dvh] flex-col bg-[var(--bg)] text-[var(--text)]">
      <header className="flex items-center justify-between px-6 py-5 sm:px-10">
        <div className="flex items-center gap-2.5">
          <div className="brandmark h-8 w-8 text-[13px]">IQ</div>
          <span className="text-[15px] font-semibold tracking-tight">GradeIQ</span>
        </div>
        <nav className="flex items-center gap-5 text-[14px] text-[var(--muted)]">
          <a href={withBase("/how-it-works")} className="transition-colors hover:text-[var(--text)]">
            How it works
          </a>
          <a href={withBase("/enterprise")} className="transition-colors hover:text-[var(--text)]">
            Console
          </a>
        </nav>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center px-6 text-center">
        <div className="max-w-xl">
          <div className="text-[12px] font-semibold uppercase tracking-[0.18em] text-[var(--muted)]">
            AI device inspection
          </div>
          <h1 className="mt-4 text-[44px] font-semibold leading-[1.05] tracking-[-0.03em] sm:text-[64px]">
            Grade any device.
            <br />
            <span className="grad-text">Instantly.</span>
          </h1>
          <p className="mx-auto mt-5 max-w-md text-[17px] leading-relaxed text-[var(--muted)]">
            AI-powered visual inspection. Scan, grade and report in seconds — no
            app, no kiosk, right in the browser.
          </p>

          <button
            onClick={start}
            disabled={starting}
            className="mt-9 inline-flex items-center gap-2 rounded-full px-8 py-4 text-[17px] font-medium text-white disabled:opacity-50"
            style={{ background: "var(--grad)" }}
          >
            {starting ? "Starting…" : "Start inspection →"}
          </button>

          <div className="mt-14 flex items-center justify-center gap-8 text-[13px] text-[var(--muted)]">
            <Step n="1" label="Scan IMEI" />
            <Dot />
            <Step n="2" label="Capture" />
            <Dot />
            <Step n="3" label="Your offer" />
          </div>
        </div>
      </main>

      <footer className="px-6 py-6 text-center text-[12px] text-[var(--muted)]">
        Browser-native · no install
      </footer>
    </div>
  );
}

function Step({ n, label }: { n: string; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="grid h-6 w-6 place-items-center rounded-full border border-[var(--border)] text-[12px] font-semibold">
        {n}
      </span>
      <span>{label}</span>
    </div>
  );
}
function Dot() {
  return <span className="h-1 w-1 rounded-full bg-[var(--border)]" />;
}
