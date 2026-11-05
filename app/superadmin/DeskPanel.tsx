"use client";
import { useState } from "react";
import { withBase } from "@/lib/basePath";
import ImeiScanner from "@/app/components/ImeiScanner";

// Desk tester, INSIDE the console — starts a diagnostic session for the selected
// client without bouncing to /enterprise and signing in again. The session is
// stamped with the client currently selected in the portal, so an operator
// working two tenants can't accidentally file a device under the wrong one
// (the standalone /enterprise flow always created "default" sessions).

export default function DeskPanel({ clientId }: { clientId: string }) {
  const [scan, setScan] = useState(false);
  const [imei, setImei] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function begin(imeiVal: string) {
    setBusy(true);
    setErr("");
    try {
      const r = await fetch(withBase("/api/sessions"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ segment: "enterprise", imei: imeiVal, client: clientId }),
      });
      if (!r.ok) throw new Error();
      const s = await r.json();
      window.location.href = withBase(`/staff/${s.id}`);
    } catch {
      setErr("Couldn't start — check your connection and try again.");
      setBusy(false);
    }
  }

  // The employee TRADE-IN journey (identify → diagnostics → photos → offer →
  // record) is a DeNovo flow; the diagnostic desk below is the lighter
  // grade-only path. Only offer the journey where a journey exists for the
  // selected client.
  const journeyId = clientId === "denovo" ? "denovo-tradein-employee" : null;

  return (
    <div className="flex flex-col gap-4">
      {journeyId && (
        <section className="card p-5" style={{ borderColor: "var(--brand)" }}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold">Employee trade-in journey</h2>
              <p className="mt-1 text-[12px] text-[var(--muted)]">
                The full station-by-station flow: identify → diagnostics → photos &amp; grade →
                review &amp; offer → record. Booked against <b>{clientId}</b> pricing.
              </p>
            </div>
            <a className="btn" href={withBase(`/j/${journeyId}`)}>Start journey →</a>
          </div>
        </section>
      )}

      <section className="card p-5">
        <h2 className="text-lg font-bold">Start a diagnostic</h2>
        <p className="mb-4 text-[12px] text-[var(--muted)]">
          Scan or type the IMEI — it identifies the model, which selects the right
          lenses, angles and tests. Filed under <b>{clientId}</b>.
        </p>

        {scan ? (
          <div className="max-w-md">
            <ImeiScanner
              onResult={(v: string) => {
                setScan(false);
                setImei(v);
                begin(v);
              }}
              onClose={() => setScan(false)}
            />
          </div>
        ) : (
          <div className="flex max-w-md flex-col gap-2">
            <button className="btn" onClick={() => setScan(true)} disabled={busy}>
              📷 Scan IMEI barcode
            </button>
            <div className="text-center text-[12px] text-[var(--muted)]">or</div>
            <input
              className="input"
              inputMode="numeric"
              placeholder="Type the 15-digit IMEI"
              value={imei}
              onChange={(e) => setImei(e.target.value.replace(/[^0-9]/g, "").slice(0, 15))}
              onKeyDown={(e) => e.key === "Enter" && imei.length === 15 && begin(imei)}
            />
            <button className="btn" disabled={imei.length !== 15 || busy} onClick={() => begin(imei)}>
              {busy ? "Starting…" : "Start diagnostic →"}
            </button>
            {err && <p className="text-[13px] text-[var(--bad)]">{err}</p>}
          </div>
        )}
      </section>

      <section className="card p-5">
        <h3 className="mb-2 text-[14px] font-bold">Two-device flow</h3>
        <p className="text-[12px] text-[var(--muted)]">
          After the IMEI, the desk shows a QR for the camera phone. Grades, capture
          rejections and review flags all land back in <b>Session monitor</b> — no
          separate console to check.
        </p>
      </section>
    </div>
  );
}
