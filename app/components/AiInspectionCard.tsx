"use client";
import { useCallback, useEffect, useState } from "react";
import { withBase } from "@/lib/basePath";
import { tx, type ExperienceId } from "@/lib/experience";

// Surfaces the AI inspection evidence on the report so a grade visibly reads as
// "inspected by AI" rather than an opaque letter: which model tier graded, the
// model-identity match, the OEM/aftermarket verdict, and whether a human should
// review. Also offers a one-click reprocess through the current pipeline.

type Device = { make?: string; model?: string; match?: string; reason?: string };
type Oem = { verdict?: string; confidence?: number; evidence?: string[] };

type Run = {
  id: number;
  grade: string;
  tier: string;
  escalated: boolean;
  score: number | null;
  findings: number;
  review: boolean;
  trigger: string;
  actor: string;
  at: string;
};

type ReprocessResult = {
  before: { grade?: string; tierUsed?: string; score?: number; findings?: number };
  after: { grade?: string; tierUsed?: string; score?: number; findings?: number; needsHumanReview?: boolean };
  diff: {
    changed: boolean;
    from: string;
    to: string;
    direction: "better" | "worse" | "same" | "unknown";
    findingsFrom: number;
    findingsTo: number;
    components: { id: string; from: string; to: string }[];
  };
  offer?: { value?: number; currency?: string; blocked?: boolean };
  overall?: string;
};

const MONEY: Record<string, string> = { USD: "$", INR: "₹", EUR: "€" };

export default function AiInspectionCard({
  experience = "consumer",
  sessionId,
  grade,
  tierUsed,
  escalated,
  refining,
  unfinished,
  needsHumanReview,
  device,
  oem,
  findingsCount,
  notes,
}: {
  experience?: ExperienceId;
  sessionId: string;
  grade?: string;
  tierUsed?: "stub" | "flash" | "pro";
  escalated?: boolean;
  refining?: boolean;
  /** SUP-63: the background grade died; shown instead of "confirming…". */
  unfinished?: boolean;
  needsHumanReview?: boolean;
  device?: Device;
  oem?: Oem;
  findingsCount: number;
  notes?: string;
}) {
  const T = tx(experience);
  const isOp = experience === "operator";

  // NO re-grade control here. It lives in RegradeBar at the top of the report,
  // because a re-grade changes the identity, diagnostics, overall grade and
  // price too — offering it inside this one card framed it as "re-run the
  // vision bit" and put it below half the things it silently moved.

  /* NO VENDOR NAME ON THE REPORT.
   *
   * This printed the exact model — "Gemini 3.1 Pro" — on every operator report.
   * It tells the reader nothing they can act on, dates the document the moment
   * the model is re-pointed, and puts a supplier's brand on a record that is
   * meant to carry GradeIQ's own. Which tier ran is still worth showing,
   * because the two tiers genuinely differ in confidence and a re-grade is the
   * action it prompts — so the TIER stays and the vendor goes.
   *
   * The precise model string is still recorded per run in `visionModel` for
   * audit; it just is not the report's headline. */
  const tierLabel = isOp
    ? tierUsed === "pro"
      ? `Full inspection${escalated ? " (escalated)" : ""}`
      : tierUsed === "flash"
        ? "Quick inspection"
        : "Not AI-graded (stub)"
    : tierUsed === "pro" || tierUsed === "flash"
      ? "Inspected"
      : "Not inspected yet";
  const tierChip = tierUsed === "pro" ? "chip-green" : tierUsed === "flash" ? "chip-blue" : "chip-yellow";

  const matchChip =
    device?.match === "match" ? "chip-green" : device?.match === "mismatch" ? "chip-red" : "chip-yellow";
  const oemChip =
    oem?.verdict === "likely_oem" ? "chip-green" : oem?.verdict === "suspect_aftermarket" ? "chip-red" : "chip-yellow";

  return (
    <section className="card mt-4 p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-lg font-bold">{isOp ? "AI inspection" : "Condition report"}</h2>
        <div className="flex items-center gap-2">
          <span className={`pill ${tierChip}`} style={{ fontSize: 11 }}>
            {tierLabel}
          </span>
          {refining && !unfinished && (
            <span className="pill chip-blue" style={{ fontSize: 11 }}>
              {isOp ? "confirming on Pro…" : "confirming…"}
            </span>
          )}
          {unfinished && (
            <span className="pill chip-red" style={{ fontSize: 11 }}>
              {isOp ? "did not finish" : "not finished"}
            </span>
          )}
        </div>
      </div>

      {needsHumanReview && (
        <div className="mb-3 rounded-2xl px-4 py-3 text-[13px]" style={{ background: "rgba(251,191,36,0.12)" }}>
          <b>⚑ {T.needsReview}</b> — {T.needsReviewBody}
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {/* Model identity + match */}
        <div className="rounded-2xl border border-[var(--border)] p-4">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[12px] font-bold uppercase tracking-wide text-[var(--muted)]">Model identity</span>
            {device?.match && (
              <span className={`pill ${matchChip}`} style={{ fontSize: 11 }}>
                {device.match}
              </span>
            )}
          </div>
          <div className="text-[15px] font-semibold">
            {[device?.make, device?.model].filter(Boolean).join(" ") || "Not identified"}
          </div>
          {device?.reason && <p className="mt-1 text-[12px] text-[var(--muted)]">{device.reason}</p>}
        </div>

        {/* OEM / aftermarket */}
        <div className="rounded-2xl border border-[var(--border)] p-4">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[12px] font-bold uppercase tracking-wide text-[var(--muted)]">Parts authenticity</span>
            {oem?.verdict && (
              <span className={`pill ${oemChip}`} style={{ fontSize: 11 }}>
                {oem.verdict.replace(/_/g, " ")}
              </span>
            )}
          </div>
          {oem?.evidence?.length ? (
            <ul className="mt-1 space-y-1 text-[12px] text-[var(--muted)]">
              {oem.evidence.slice(0, 3).map((e, i) => (
                <li key={i}>• {e}</li>
              ))}
            </ul>
          ) : (
            <div className="text-[13px] text-[var(--muted)]">No aftermarket tells assessed.</div>
          )}
        </div>
      </div>

      <div className="mt-3 text-[12px] text-[var(--muted)]">
        {isOp
          ? notes || `${findingsCount} located finding${findingsCount === 1 ? "" : "s"}`
          : `${findingsCount} mark${findingsCount === 1 ? "" : "s"} found`}
      </div>
    </section>
  );
}
