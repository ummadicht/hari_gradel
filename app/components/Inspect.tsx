"use client";
import { useEffect, useRef, useState } from "react";
import { withBase } from "@/lib/basePath";
import ImeiScanner from "./ImeiScanner";
import QR from "./QR";

// The collector's seamless journey — one screen at a time, Pandas-style:
// scan IMEI → verify model → is the device on? → show QR (device joins the same
// session) → hand off to the guided capture. One linked session throughout.
type Step = "scan" | "verify" | "connect";

export default function Inspect() {
  const [step, setStep] = useState<Step>("scan");
  const [sessionId, setSessionId] = useState("");
  const [imei, setImei] = useState("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [origin, setOrigin] = useState("");
  const [connected, setConnected] = useState(false);
  useEffect(() => setOrigin(window.location.origin), []);

  async function onImei(v: string) {
    setBusy(true);
    try {
      const r = await fetch(withBase("/api/sessions"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ segment: "enterprise", imei: v }),
      });
      const s = await r.json();
      setSessionId(s.id);
      setImei(s.imei || v);
      setModel(s.model || "");
      setStep("verify");
    } catch {
      /* stay on scan */
    } finally {
      setBusy(false);
    }
  }

  // Poll for the device joining once we show the QR.
  useEffect(() => {
    if (step !== "connect" || !sessionId) return;
    const t = setInterval(async () => {
      try {
        const d = await (
          await fetch(withBase(`/api/sessions/${sessionId}/screen`))
        ).json();
        if (d.connectedAt) {
          setConnected(true);
          clearInterval(t);
          setTimeout(toCapture, 700);
        }
      } catch {
        /* ignore */
      }
    }, 1500);
    return () => clearInterval(t);
  }, [step, sessionId]);

  function toCapture() {
    window.location.href = withBase(`/staff/${sessionId}`);
  }

  // ── SCAN ──
  if (step === "scan") {
    return (
      <ImeiScanner onResult={onImei} onClose={() => history.back()} />
    );
  }

  const deviceUrl = origin ? `${origin}${withBase(`/screen/${sessionId}`)}` : "";

  return (
    <div className="mx-auto flex min-h-[100dvh] w-full max-w-md flex-col px-6 py-8">
      {/* progress */}
      <div className="mb-8 flex items-center gap-1.5">
        {["scan", "verify", "connect"].map((s, i) => (
          <div
            key={s}
            className="h-1 flex-1 rounded-full"
            style={{
              background:
                ["scan", "verify", "connect"].indexOf(step) >= i
                  ? "var(--brand)"
                  : "var(--border)",
            }}
          />
        ))}
      </div>

      {/* VERIFY MODEL */}
      {step === "verify" && (
        <div className="flex flex-1 flex-col">
          <div className="text-[12px] font-semibold uppercase tracking-[0.16em] text-[var(--muted)]">
            Device identified
          </div>
          <h1 className="mt-3 text-[30px] font-semibold tracking-tight">
            {model || "Unknown model"}
          </h1>
          <div className="mono mt-1 text-[13px] text-[var(--muted)]">
            IMEI {imei || "—"}
          </div>
          {!model && (
            <p className="mt-3 text-[14px] text-[var(--muted)]">
              We couldn&apos;t resolve the model from the IMEI. You can still
              continue — we'll identify it from the photos.
            </p>
          )}
          <div className="mt-auto">
            <button
              className="w-full rounded-full py-4 text-[17px] font-medium text-white"
              style={{ background: "var(--grad)" }}
              onClick={() => setStep("connect")}
            >
              Looks right — continue →
            </button>
            <button
              className="mt-2 block w-full py-2 text-center text-[14px] text-[var(--muted)] underline"
              onClick={() => setStep("scan")}
            >
              Re-scan
            </button>
          </div>
        </div>
      )}

      {/* SHOW QR / CONNECT */}
      {step === "connect" && (
        <div className="flex flex-1 flex-col text-center">
          <div className="text-[12px] font-semibold uppercase tracking-[0.16em] text-[var(--muted)]">
            Link the device
          </div>
          <h1 className="mt-3 text-[24px] font-semibold tracking-tight">
            Scan with the device
          </h1>
          <p className="mx-auto mt-2 max-w-xs text-[15px] text-[var(--muted)]">
            Open the camera on the device being inspected and scan this — it
            joins the same session and runs the screen test automatically.
          </p>
          <div className="mx-auto mt-7 rounded-3xl border border-[var(--border)] bg-[var(--card)] p-5">
            {deviceUrl && <QR text={deviceUrl} size={200} />}
          </div>
          <div
            className="mx-auto mt-5 inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[14px] font-medium"
            style={{
              color: connected ? "var(--green-ink)" : "var(--muted)",
              background: connected
                ? "color-mix(in oklch, var(--green) 14%, transparent)"
                : "var(--bg-soft)",
            }}
          >
            <span
              className={`h-2 w-2 rounded-full ${connected ? "" : "animate-pulse"}`}
              style={{ background: connected ? "var(--green-ink)" : "var(--muted)" }}
            />
            {connected ? "Connected — continuing…" : "Waiting for device to connect…"}
          </div>
          <button
            className="mt-auto block w-full py-3 text-center text-[14px] text-[var(--muted)] underline"
            onClick={toCapture}
          >
            Skip — continue without screen test
          </button>
        </div>
      )}
    </div>
  );
}
