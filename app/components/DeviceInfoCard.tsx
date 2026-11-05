// Read-only report section: the facts OCR'd from the device's own Settings as
// the seller scrolled — model, storage, IMEI, battery health/cycles, OS,
// carrier, Find My, and Parts & Service warnings. Only shown when OCR actually
// read something (source "gemini"); never a fabricated placeholder.

type Ocr = {
  source?: string;
  model?: string;
  storage?: string;
  imei?: string;
  serial?: string;
  batteryHealth?: number;
  batteryCycles?: number;
  os?: string;
  carrier?: string;
  findMy?: string;
  warnings?: string[];
};

export default function DeviceInfoCard({ ocr }: { ocr: Ocr }) {
  if (!ocr || ocr.source !== "gemini") return null;

  const rows: { label: string; value: string; mono?: boolean }[] = [];
  if (ocr.model) rows.push({ label: "Model", value: ocr.model });
  if (ocr.storage) rows.push({ label: "Storage", value: ocr.storage });
  if (ocr.imei) rows.push({ label: "IMEI", value: ocr.imei, mono: true });
  if (ocr.serial) rows.push({ label: "Serial", value: ocr.serial, mono: true });
  if (typeof ocr.batteryHealth === "number")
    rows.push({ label: "Battery health", value: `${ocr.batteryHealth}%` });
  if (typeof ocr.batteryCycles === "number")
    rows.push({ label: "Charge cycles", value: String(ocr.batteryCycles) });
  if (ocr.os) rows.push({ label: "OS", value: ocr.os });
  if (ocr.carrier) rows.push({ label: "Carrier", value: ocr.carrier });
  if (ocr.findMy)
    rows.push({ label: "Find My / Lock", value: ocr.findMy === "off" ? "Off" : "On" });

  if (rows.length === 0 && !(ocr.warnings && ocr.warnings.length)) return null;

  return (
    <section className="mt-4 rounded-3xl border border-[var(--border)] bg-[var(--card)] px-6 py-9 sm:px-10">
      <div className="mb-1 flex items-baseline justify-between">
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
          Read from Settings
        </h2>
        <span className="text-[13px] text-[var(--muted)]">Read from the device</span>
      </div>
      <p className="mb-4 text-[13px] text-[var(--muted)]">
        Pulled from the device&apos;s own Settings screens — no screenshots, no typing.
      </p>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {rows.map((r, i) => (
          <div key={i} className="rounded-2xl border border-[var(--border)] bg-[var(--bg-soft)] px-3 py-2.5">
            <div className="text-[11px] uppercase tracking-wide text-[var(--muted)]">{r.label}</div>
            <div className={`mt-0.5 text-[14px] font-semibold ${r.mono ? "mono" : ""}`}>{r.value}</div>
          </div>
        ))}
      </div>

      {ocr.warnings && ocr.warnings.length > 0 && (
        <div
          className="mt-4 rounded-2xl px-4 py-3"
          style={{ background: "color-mix(in oklch, var(--bad) 8%, transparent)" }}
        >
          <div className="text-[13px] font-bold" style={{ color: "var(--bad)" }}>
            Parts &amp; service warnings
          </div>
          <ul className="mt-1 space-y-0.5 text-[13px] text-[var(--muted)]">
            {ocr.warnings.map((w, i) => (
              <li key={i}>• {w}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
