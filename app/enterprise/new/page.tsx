"use client";
import { useState } from "react";
import { withBase } from "@/lib/basePath";
import ImeiScanner from "@/app/components/ImeiScanner";

// Enterprise diagnostic intake: scan (or type) the IMEI FIRST, then create the
// enterprise session and hand off to cosmetic capture. IMEI identifies the model
// so the right lenses/angles/tests are triggered.
export default function EnterpriseNew() {
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
        body: JSON.stringify({ segment: "enterprise", imei: imeiVal }),
      });
      if (!r.ok) throw new Error();
      const s = await r.json();
      window.location.href = withBase(`/staff/${s.id}`);
    } catch {
      setErr("Couldn't start — check your connection and try again.");
      setBusy(false);
    }
  }

  if (scan)
    return (
      <ImeiScanner
        onResult={(v) => {
          setScan(false);
          begin(v);
        }}
        onClose={() => setScan(false)}
      />
    );

  if (busy)
    return (
      <div className="stage items-center justify-center p-6 text-center">
        <div>
          <div className="brandmark mx-auto h-16 w-16 text-2xl">G</div>
          <p className="mt-4 font-semibold">Creating diagnostic session…</p>
        </div>
      </div>
    );

  return (
    <div className="mx-auto w-full max-w-lg px-4">
      <div className="flex items-center justify-between py-4">
        <h1 className="text-xl font-extrabold">
          Grade<span className="grad-text">IQ</span> Enterprise
        </h1>
        <a href={withBase("/enterprise")} className="pill">
          ← Console
        </a>
      </div>

      <div className="card p-5">
        <h2 className="text-lg font-bold">New device diagnostic</h2>
        <p className="mb-3 text-sm text-[var(--muted)]">
          Scan the IMEI first — it identifies the exact model so the right
          lenses, angles and tests are triggered. Dial{" "}
          <span className="mono">*#06#</span> or scan the box barcode.
        </p>
        <button className="btn w-full" onClick={() => setScan(true)}>
          📷 Scan IMEI
        </button>
        <div className="my-3 text-center text-xs text-[var(--muted)]">
          or type it
        </div>
        <div className="flex gap-2">
          <input
            className="input mono"
            placeholder="15-digit IMEI"
            value={imei}
            inputMode="numeric"
            maxLength={15}
            onChange={(e) => setImei(e.target.value.replace(/[^0-9]/g, ""))}
          />
          <button
            className="btn"
            disabled={imei.length !== 15}
            onClick={() => begin(imei)}
          >
            Go →
          </button>
        </div>
        {err && <p className="mt-2 text-sm text-[var(--bad)]">{err}</p>}
        <button
          className="mt-4 block w-full text-center text-sm text-[var(--muted)] underline"
          onClick={() => begin("")}
        >
          No IMEI — start without it
        </button>
      </div>
    </div>
  );
}
