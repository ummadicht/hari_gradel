"use client";
import { withBase } from "@/lib/basePath";

/**
 * The screenshots the seller showed us — *#06# / Settings ▸ About / Battery
 * Health.
 *
 * These frames are the source of the IMEI we trust, the storage we quote and the
 * battery health we price a replacement into. They were read for their text and
 * then discarded, so the report asserted "IMEI 3550…, battery 87%" with nothing
 * to point at and a dispute had no source. The photos of the phone were always
 * kept; there was never a reason these weren't.
 */

type Shot = { url: string; kind?: string };

export default function EvidenceShots({
  shots,
  read,
}: {
  shots: Shot[];
  /** What the OCR actually extracted, so the image and the claim sit together. */
  read?: { imei?: string; model?: string; storage?: string; batteryHealth?: number; serial?: string };
}) {
  if (!shots?.length) return null;

  const facts = [
    read?.imei && { k: "IMEI", v: read.imei },
    read?.model && { k: "Model", v: read.model },
    read?.storage && { k: "Storage", v: read.storage },
    typeof read?.batteryHealth === "number" && { k: "Battery health", v: `${read.batteryHealth}%` },
    read?.serial && { k: "Serial", v: read.serial },
  ].filter(Boolean) as { k: string; v: string }[];

  return (
    <section className="card mt-4 p-5">
      <div className="mb-1 flex items-baseline justify-between">
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
          Device screenshots — the source of these numbers
        </h2>
        <span className="text-[13px] text-[var(--muted)]">{shots.length} captured</span>
      </div>
      <p className="mb-3 text-[12px] text-[var(--muted)]">
        Read straight off the device&apos;s own Settings screens. Nothing here is typed in by hand.
      </p>

      {facts.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2 text-[12px]">
          {facts.map((f) => (
            <span key={f.k} className="rounded-lg border border-[var(--border)] px-2.5 py-1">
              <span className="text-[10px] uppercase tracking-wide text-[var(--muted)]">{f.k}</span>{" "}
              <b className="mono">{f.v}</b>
            </span>
          ))}
        </div>
      )}

      <div className="flex gap-3 overflow-x-auto pb-1">
        {shots.map((sh, i) => (
          <figure key={i} className="shrink-0">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={withBase(sh.url)}
              alt={sh.kind === "battery" ? "Battery health screen" : "Device settings screen"}
              className="h-64 w-auto rounded-xl border border-[var(--border)] bg-black object-contain"
            />
            <figcaption className="mt-1 text-[11px] uppercase tracking-wide text-[var(--muted)]">
              {sh.kind === "battery" ? "battery health" : sh.kind || "settings"}
            </figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}
