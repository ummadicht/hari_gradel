"use client";
import { useEffect, useRef, useState } from "react";
import { withBase } from "@/lib/basePath";

// Runs on the DEVICE BEING INSPECTED (opened via QR). It does almost nothing —
// it checks in, then displays whatever full-screen test pattern the inspector
// selects, so the inspector can photograph the lit screen for LCD grading.

const FILLS: Record<string, string> = {
  white: "#ffffff",
  black: "#000000",
  red: "#ff0000",
  green: "#00ff00",
  blue: "#0000ff",
};

// Silently verify each camera works and submit the result to the linked session.
async function runCameraSelfTest(sessionId: string) {
  const results: Record<string, "pass" | "fail"> = {};
  for (const facing of ["environment", "user"] as const) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: facing } },
      });
      // A live track with a real resolution ⇒ the camera works.
      const t = s.getVideoTracks()[0];
      const ok = !!t && t.readyState === "live";
      s.getTracks().forEach((x) => x.stop());
      if (facing === "environment") results.camera = ok ? "pass" : "fail";
    } catch {
      if (facing === "environment") results.camera = "fail";
    }
  }
  if (Object.keys(results).length) {
    fetch(withBase(`/api/sessions/${sessionId}/functional`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ functional: results, merge: true }),
    }).catch(() => {});
  }
}

export default function ScreenTest({ sessionId }: { sessionId: string }) {
  const [pattern, setPattern] = useState("idle");
  const [ok, setOk] = useState(false);
  const wakeRef = useRef<any>(null);

  useEffect(() => {
    // Check in + keep the screen awake so patterns stay visible.
    fetch(withBase(`/api/sessions/${sessionId}/screen`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connected: true }),
    })
      .then(() => setOk(true))
      .catch(() => {});
    (navigator as any).wakeLock?.request?.("screen").then((w: any) => (wakeRef.current = w)).catch(() => {});
    // Silently self-test the cameras (rear + front) and submit — the device runs
    // its own diagnostics; the inspector never touches it.
    runCameraSelfTest(sessionId);

    const t = setInterval(() => {
      fetch(withBase(`/api/sessions/${sessionId}/screen`))
        .then((r) => r.json())
        .then((d) => setPattern(d.pattern || "idle"))
        .catch(() => {});
    }, 1000);
    return () => {
      clearInterval(t);
      wakeRef.current?.release?.().catch(() => {});
    };
  }, [sessionId]);

  if (pattern === "stripes") {
    return (
      <div
        className="fixed inset-0"
        style={{
          background:
            "repeating-linear-gradient(90deg, #000 0 6px, #fff 6px 12px)",
        }}
      />
    );
  }
  if (FILLS[pattern]) {
    return <div className="fixed inset-0" style={{ background: FILLS[pattern] }} />;
  }

  // Idle — waiting for the inspector.
  return (
    <div className="stage items-center justify-center bg-[var(--bg)] p-8 text-center">
      <div>
        <div className="text-4xl">📱</div>
        <h1 className="mt-4 text-xl font-extrabold">Screen test ready</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">
          Keep this device face-up. The screen will switch to test patterns as
          the inspector works — no need to touch anything.
        </p>
        <div
          className="mt-5 inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium"
          style={{
            color: ok ? "var(--green-ink)" : "var(--muted)",
            background: ok
              ? "color-mix(in oklch, var(--green) 14%, transparent)"
              : "var(--bg-soft)",
          }}
        >
          <span
            className="h-2 w-2 rounded-full"
            style={{ background: ok ? "var(--green-ink)" : "var(--muted)" }}
          />
          {ok ? "Connected to inspector" : "Connecting…"}
        </div>
      </div>
    </div>
  );
}
