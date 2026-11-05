"use client";
import { useEffect, useRef, useState } from "react";
import { withBase } from "@/lib/basePath";

// Point the inspector camera at the phone's parts-authentication screen
// (iPhone: Settings → General → About / Parts & Service History) and let Gemini
// read the genuine-part verdict. Reliable because the OS did the check.

type Part = { name: string; status: "genuine" | "non_genuine" | "unknown"; note?: string };
type Result = { found: boolean; parts: Part[]; anyNonGenuine: boolean; source: string };

export default function PartsCheck({ sessionId }: { sessionId: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState("");
  const [reading, setReading] = useState(false);
  const [msg, setMsg] = useState("");
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | null = null;
    (async () => {
      try {
        let s: MediaStream;
        try {
          s = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: "environment" } },
          });
        } catch {
          s = await navigator.mediaDevices.getUserMedia({ video: true });
        }
        if (cancelled) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        if (videoRef.current) {
          videoRef.current.srcObject = s;
          videoRef.current.setAttribute("playsinline", "true");
          await videoRef.current.play().catch(() => {});
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : "camera blocked");
      }
    })();
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  async function read() {
    const v = videoRef.current;
    if (!v) return;
    setReading(true);
    setMsg("");
    const canvas = document.createElement("canvas");
    canvas.width = v.videoWidth || 1080;
    canvas.height = v.videoHeight || 1440;
    canvas.getContext("2d")?.drawImage(v, 0, 0, canvas.width, canvas.height);
    const photo = canvas.toDataURL("image/jpeg", 0.85);
    try {
      const r = await fetch(withBase(`/api/sessions/${sessionId}/parts`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ photo }),
      });
      const d = await r.json();
      if (d.parts?.found) setResult(d.parts);
      else setMsg("Couldn't read a parts screen — open Settings → General → About and fill the frame.");
    } catch {
      setMsg("Read failed. Try again.");
    } finally {
      setReading(false);
    }
  }

  if (result) {
    return (
      <div className="mx-auto w-full max-w-lg px-4 py-6">
        <div
          className="rounded-2xl p-4 text-center text-[15px] font-semibold"
          style={{
            color: result.anyNonGenuine ? "var(--bad)" : "var(--green-ink)",
            background: result.anyNonGenuine
              ? "color-mix(in oklch, var(--bad) 10%, transparent)"
              : "color-mix(in oklch, var(--green) 14%, transparent)",
          }}
        >
          {result.anyNonGenuine
            ? "⚠ Non-genuine part detected"
            : "✓ All read parts are genuine"}
        </div>
        <div className="mt-4 divide-y divide-[var(--border)]">
          {result.parts.map((p, i) => (
            <div key={i} className="flex items-center justify-between py-3">
              <div>
                <div className="text-[15px] font-medium">{p.name}</div>
                {p.note && <div className="text-[12px] text-[var(--muted)]">{p.note}</div>}
              </div>
              <span
                className="text-[13px] font-semibold"
                style={{
                  color:
                    p.status === "genuine"
                      ? "var(--green-ink)"
                      : p.status === "non_genuine"
                        ? "var(--bad)"
                        : "var(--muted)",
                }}
              >
                {p.status === "genuine" ? "Genuine" : p.status === "non_genuine" ? "Non-OEM" : "Unknown"}
              </span>
            </div>
          ))}
        </div>
        <a className="btn mt-6 w-full" href={withBase(`/report/${sessionId}`)}>
          Done → report
        </a>
      </div>
    );
  }

  return (
    <div className="stage items-center justify-center p-4 text-center">
      <div className="w-full max-w-sm">
        <div
          className="relative w-full overflow-hidden rounded-2xl border border-[var(--border)] bg-black"
          style={{ aspectRatio: "3/4" }}
        >
          <video ref={videoRef} playsInline muted className="h-full w-full object-cover" />
        </div>
        <p className="mt-3 text-sm text-[var(--muted)]">
          On the phone, open <b>Settings → General → About</b> (scroll to Parts &amp;
          Service History) and point the camera at it.
        </p>
        {err && (
          <p className="mt-2 text-sm text-[var(--bad)]">
            Camera off — allow access (HTTPS/localhost).
          </p>
        )}
        {msg && <p className="mt-2 text-sm text-[var(--warn)]">{msg}</p>}
        <div className="mt-4 flex gap-2">
          <button className="btn flex-1" onClick={read} disabled={reading}>
            {reading ? "Reading…" : "🔎 Read parts"}
          </button>
          <a className="btn btn-ghost" href={withBase(`/report/${sessionId}`)}>
            Skip
          </a>
        </div>
      </div>
    </div>
  );
}
