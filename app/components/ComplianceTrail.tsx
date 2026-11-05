import type { ComplianceRow } from "@/lib/compliance"; // type-only: erased at build

/**
 * Per-session compliance trail — the contradictions recorded for THIS device.
 *
 * OPERATOR-ONLY, and the report page gates it. A seller does not need to read
 * "IMEI on screen ≠ IMEI entered" about their own phone in an automated tone;
 * that is a conversation for a human, and showing it unprompted turns a
 * recorded observation into an accusation.
 *
 * Shows nothing at all when nothing disagreed. An empty compliance section on
 * every clean report would train an operator to skip past it, and then miss the
 * one that mattered.
 */

const TONE: Record<string, string> = {
  block: "chip-red",
  flag: "chip-yellow",
  record: "",
};
const SEV: Record<string, string> = {
  block: "Blocks payout",
  flag: "Flagged",
  record: "Recorded",
};
const KIND: Record<string, string> = {
  "identity.imei_mismatch": "IMEI on screen ≠ IMEI entered",
  "identity.model_vs_vision": "Model ≠ what the photos show",
  "identity.model_vs_fingerprint": "Model ≠ the browser's device",
  "identity.colour_mismatch": "Colour mismatch",
  "identity.storage_mismatch": "Storage mismatch",
  "identity.unproven": "Priced without a verified IMEI",
  "evidence.stale_screenshot": "Screenshot taken outside the window",
  "evidence.obstruction": "A case or cover hid the device",
  "evidence.duplicate_image": "Image already seen in another session",
  "evidence.missing_surface": "A required surface was never captured",
  "evidence.suspect_aftermarket": "Suspected non-OEM part",
  "process.prep_not_acked": "Prep steps not acknowledged",
  "process.step_skipped": "A test was skipped",
  "process.grade_overridden": "Grade overridden by hand",
};

export default function ComplianceTrail({ events }: { events: ComplianceRow[] }) {
  if (!events?.length) return null;

  const blocking = events.filter((e) => e.severity === "block").length;

  return (
    <section className="card mt-4 p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-bold">Compliance trail</h2>
        <span className={`pill ${blocking ? "chip-red" : "chip-yellow"}`} style={{ fontSize: 11 }}>
          {events.length} recorded{blocking ? ` · ${blocking} blocking` : ""}
        </span>
      </div>
      <p className="mt-1 text-[13px] text-[var(--muted)]">
        Recorded at the moment each contradiction was observed — before the pipeline
        reconciled it. Both values are kept so a dispute has something to point at.
      </p>

      <div className="mt-4 space-y-2">
        {events.map((e) => (
          <div key={e.id} className="rounded-xl border border-[var(--border)] p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`pill ${TONE[e.severity] ?? ""}`} style={{ fontSize: 10 }}>
                {SEV[e.severity] ?? e.severity}
              </span>
              <span className="text-[13px] font-semibold">{KIND[e.kind] ?? e.kind}</span>
              <span className="ml-auto text-[11px] text-[var(--muted)]">{e.at}</span>
            </div>
            {(e.expected || e.observed) && (
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-[var(--muted)]">Expected</div>
                  <div className="mono text-[12px]">{e.expected || "—"}</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-[var(--muted)]">Observed</div>
                  <div className="mono text-[12px]">{e.observed || "—"}</div>
                </div>
              </div>
            )}
            {e.source && (
              <div className="mt-1.5 text-[11px] text-[var(--muted)]">Read from: {e.source}</div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
