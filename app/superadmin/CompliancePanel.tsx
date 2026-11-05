"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { withBase } from "@/lib/basePath";
import { sessionAlias } from "@/lib/sessionAlias";
// Pure vocabulary only — importing from lib/compliance would pull node:fs in.
import { COMPLIANCE_KINDS, type ComplianceKind, type ComplianceSeverity } from "@/lib/complianceKinds";

/**
 * The fraud & mismatch register.
 *
 * Everything the pipeline noticed and wrote down, with BOTH sides of each
 * contradiction. This is the surface that makes `compliance_events` worth
 * having: the table has been recording since it shipped, and until now nothing
 * could read it.
 *
 * Why both values are shown rather than a verdict: a register that says
 * "identity mismatch" and nothing else is unarguable in the wrong direction —
 * months later, in a dispute, you cannot show WHAT disagreed. Expected and
 * observed are printed verbatim, side by side.
 */

type Row = {
  id: number;
  session_id: string;
  client_id: string;
  kind: ComplianceKind;
  severity: ComplianceSeverity;
  expected: string;
  observed: string;
  source: string;
  detail: Record<string, unknown>;
  actor: string;
  at: string;
};

const SEV_TONE: Record<ComplianceSeverity, string> = {
  block: "chip-red",
  flag: "chip-yellow",
  record: "",
};
const SEV_LABEL: Record<ComplianceSeverity, string> = {
  block: "Blocks payout",
  flag: "Flagged",
  record: "Recorded",
};

/** Plain English. The stored kind is a stable key; this is what a human reads. */
const KIND_LABEL: Partial<Record<ComplianceKind, string>> = {
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

const FAMILY = (k: string) => k.split(".")[0];

export default function CompliancePanel({
  clientId,
  onOpenSession,
}: {
  clientId: string;
  onOpenSession: (id: string) => void;
}) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [err, setErr] = useState("");
  const [sev, setSev] = useState<ComplianceSeverity | "">("");
  const [family, setFamily] = useState("");

  const load = useCallback(async () => {
    setErr("");
    try {
      const r = await fetch(
        withBase(`/api/portal/compliance?client=${encodeURIComponent(clientId)}&limit=300`)
      );
      if (!r.ok) throw new Error("Could not load the register.");
      const d = await r.json();
      setRows(d.events ?? []);
      setCounts(d.counts ?? {});
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not load compliance events.");
    }
  }, [clientId]);

  useEffect(() => {
    setRows(null);
    void load();
    const t = window.setInterval(() => void load(), 30000);
    return () => window.clearInterval(t);
  }, [load]);

  const families = useMemo(
    () => Array.from(new Set(COMPLIANCE_KINDS.map(FAMILY))),
    []
  );
  const shown = (rows ?? []).filter(
    (r) => (!sev || r.severity === sev) && (!family || FAMILY(r.kind) === family)
  );

  if (!rows) return <div className="card p-6 text-sm text-[var(--muted)]">{err || "Loading register…"}</div>;

  return (
    <div className="space-y-4">
      {err && <div className="card chip-red p-3 text-sm font-semibold">{err}</div>}

      <div className="flex flex-wrap items-center gap-2">
        {(["block", "flag", "record"] as ComplianceSeverity[]).map((s) => (
          <button
            key={s}
            className={`pill ${counts[s] ? SEV_TONE[s] : ""}`}
            style={{ fontWeight: 600, border: sev === s ? "2px solid var(--brand)" : "1px solid var(--border)" }}
            onClick={() => setSev(sev === s ? "" : s)}
          >
            {SEV_LABEL[s]} {counts[s] ?? 0}
          </button>
        ))}
        <select
          className="input"
          style={{ maxWidth: 170 }}
          value={family}
          onChange={(e) => setFamily(e.target.value)}
        >
          <option value="">All families</option>
          {families.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
        <span className="ml-auto text-[12px] text-[var(--muted)]">
          {shown.length} of {rows.length}
        </span>
      </div>

      {shown.length === 0 ? (
        <div className="card p-8 text-center">
          <div className="text-2xl">✓</div>
          <div className="mt-2 text-sm font-bold">No contradictions recorded</div>
          <p className="mt-1 text-[12px] text-[var(--muted)]">
            Nothing has disagreed on the sessions in view. Events appear here the moment
            they are observed — before the pipeline reconciles them away.
          </p>
        </div>
      ) : (
        <div className="card overflow-hidden" style={{ overflowX: "auto" }}>
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left">
                <th className="px-4">When</th>
                <th className="px-4">Session</th>
                <th className="px-4">What disagreed</th>
                {/* Both sides, verbatim — the whole point of the register. */}
                <th className="px-4">Expected</th>
                <th className="px-4">Observed</th>
                <th className="px-4">Source</th>
                <th className="px-4">Severity</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr
                  key={r.id}
                  className="cursor-pointer"
                  onClick={() => onOpenSession(r.session_id)}
                >
                  <td className="whitespace-nowrap px-4 text-[var(--muted)]">{r.at?.slice(5, 16)}</td>
                  <td className="px-4">
                    <span className="mono font-semibold text-[var(--brand)]">
                      #{sessionAlias(r.session_id)}
                    </span>
                  </td>
                  <td className="px-4 font-medium">{KIND_LABEL[r.kind] ?? r.kind}</td>
                  <td className="mono px-4 text-[12px]">{r.expected || "—"}</td>
                  <td className="mono px-4 text-[12px]">{r.observed || "—"}</td>
                  <td className="px-4 text-[12px] text-[var(--muted)]">{r.source || "—"}</td>
                  <td className="px-4">
                    <span className={`pill ${SEV_TONE[r.severity]}`} style={{ fontSize: 10 }}>
                      {SEV_LABEL[r.severity]}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-[11px] text-[var(--muted)]">
        Append-only. A resolution is a new entry referencing the old one — nothing here is
        ever edited, because the value of the record is that it cannot be changed after
        the fact.
      </p>
    </div>
  );
}
