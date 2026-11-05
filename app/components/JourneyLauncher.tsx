"use client";
import { useState } from "react";
import { withBase } from "@/lib/basePath";
import ImeiScanner from "./ImeiScanner";

/**
 * Employee-journey launcher.
 *
 * The associate scans (or types) the IMEI, which starts a session booked against
 * the journey's client and drops them into the runner. Staff-gated at the API —
 * if they aren't signed in, they're pointed at the console login rather than
 * failing silently.
 */
export default function JourneyLauncher({
  journeyId,
  label,
  steps,
}: {
  journeyId: string;
  label: string;
  steps: string[];
}) {
  const [scan, setScan] = useState(false);
  const [imei, setImei] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function start(imeiVal: string) {
    setBusy(true);
    setErr("");
    try {
      const r = await fetch(withBase(`/api/journeys/${journeyId}/start`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imei: imeiVal }),
      });
      if (r.status === 401) {
        setErr("Sign in to the console first, then start a journey.");
        setBusy(false);
        return;
      }
      if (!r.ok) throw new Error();
      const d = await r.json();
      window.location.href = d.url.startsWith("http") ? d.url : `${window.location.origin}${d.url}`;
    } catch {
      setErr("Couldn't start — check your connection and try again.");
      setBusy(false);
    }
  }

  if (scan) {
    return (
      <ImeiScanner
        onResult={(v) => {
          setScan(false);
          start(v);
        }}
        onClose={() => setScan(false)}
      />
    );
  }

  return (
    <div className="mx-auto flex min-h-[100dvh] w-full max-w-md flex-col justify-center px-5">
      <div className="text-[11px] font-bold uppercase tracking-[0.16em] text-[var(--muted)]">{label}</div>
      <h1 className="mt-1 text-2xl font-extrabold">Start a device</h1>
      <p className="mt-1 text-[13px] text-[var(--muted)]">
        Scan the device&apos;s IMEI (dial <span className="mono">*#06#</span>) or enter it to begin. You&apos;ll walk it through:
      </p>

      <ol className="mt-4 space-y-1.5">
        {steps.map((s, i) => (
          <li key={s} className="flex items-center gap-2 text-[14px]">
            <span className="grid h-5 w-5 place-items-center rounded-full text-[11px] font-bold" style={{ background: "var(--border)" }}>
              {i + 1}
            </span>
            {s}
          </li>
        ))}
      </ol>

      <div className="mt-6 flex flex-col gap-2">
        <button className="btn" onClick={() => setScan(true)} disabled={busy}>
          📷 Scan IMEI
        </button>
        <div className="flex gap-2">
          <input
            className="input flex-1"
            placeholder="…or type the 15-digit IMEI"
            inputMode="numeric"
            value={imei}
            onChange={(e) => setImei(e.target.value.replace(/[^0-9]/g, "").slice(0, 15))}
          />
          <button className="btn" onClick={() => start(imei)} disabled={busy || imei.length !== 15}>
            {busy ? "…" : "Start"}
          </button>
        </div>
        <button className="pill mt-1 self-start" onClick={() => start("")} disabled={busy}>
          Start without an IMEI (identify later) →
        </button>
      </div>

      {err && <p className="mt-4 text-[13px] text-[var(--bad)]">{err}</p>}
    </div>
  );
}
