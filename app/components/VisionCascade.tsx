"use client";
import { useState } from "react";
import { withBase } from "@/lib/basePath";
import GradeBadge from "./GradeBadge";

// GradeIQ's AI cosmetic inspection — plain-language, in GradeIQ's own clean
// style. The AI checks the photos for a handful of simple things everyone
// understands (scratches, cracks, dents, edge wear), highlights what it finds
// on the photo, and rolls it into one overall grade.

type Finding = {
  type: string;
  label: string;
  severity: "minor" | "moderate" | "severe";
  confidence: number;
  photoIndex: number;
  box?: [number, number, number, number];
};
type Specialist = {
  id: string;
  grade: string;
  confidence: number;
  weight: number;
  findings: Finding[];
};
type Cascade = {
  intake?: { passed: boolean; confidence: number; issues: string[]; missingAngles: string[] };
  specialists?: Specialist[];
  findings?: Finding[];
  score?: number;
  grade: string;
  source?: string;
};

// Plain-language checks — simple words that read the same in any market.
const CHECKS: { key: string; name: string; desc: string; types: string[] }[] = [
  { key: "scratch", name: "Scratches", desc: "Light surface marks & hairlines", types: ["scratch", "wear", "hairline"] },
  { key: "crack", name: "Cracks & chips", desc: "Broken or chipped glass", types: ["crack", "chip"] },
  { key: "dent", name: "Dents & bends", desc: "Knocks to the body or frame", types: ["dent", "deformation", "bend"] },
  { key: "edge", name: "Edges & wear", desc: "Scuffs on the sides & corners", types: ["scuff", "edge", "bezel", "discoloration"] },
];

const SIDE_LABELS = ["Front", "Back", "Left", "Right", "Top", "Bottom", "More"];

// Mark colour by severity — GradeIQ palette (teal / amber / red).
function sevColor(sev: string): string {
  if (sev === "severe") return "var(--bad)";
  if (sev === "moderate") return "var(--gold-2)";
  return "var(--brand)";
}

export default function VisionCascade({
  photos,
  cascade,
}: {
  photos: string[];
  cascade: Cascade;
  model?: string;
}) {
  const [sel, setSel] = useState(0);
  const allFindings = cascade.findings ?? [];
  const specialists = (cascade.specialists ?? []).filter((s) => s.weight > 0);
  const srcOf = (p: string) => (/^data:/.test(p) ? p : withBase(p));

  const validBox = (b?: [number, number, number, number]) =>
    !!b &&
    b.every((n) => n >= 0 && n <= 1) &&
    b[2] > b[0] &&
    b[3] > b[1] &&
    b[2] - b[0] <= 0.95 &&
    b[3] - b[1] <= 0.95;

  const sideFindings = allFindings.filter((f) => f.photoIndex === sel);
  const shown = sideFindings.filter((f) => validBox(f.box));
  // Which components does the SELECTED photo actually show? Without this, a
  // side whose component was never assessed still rendered every check as
  // "Clean" — a phone inside a case read as four green ticks.
  const SIDE_COMPONENTS: string[][] = [
    ["front", "display"], // Front
    ["back", "cameras"], // Back
    ["frame"], ["frame"], ["frame"], ["frame"], // Left / Right / Top / Bottom
  ];
  const allSpecs = cascade.specialists ?? [];
  const sideSpecs = allSpecs.filter((sp) =>
    (SIDE_COMPONENTS[sel] ?? ["frame"]).includes(sp.id)
  );
  const assessedSpecs = sideSpecs.filter(
    (sp) => sp.weight > 0 && sp.confidence > 0 && sp.grade !== ""
  );
  // A side counts as inspected only if a component covering it was graded.
  const sideAssessed = assessedSpecs.length > 0;
  const sideRealConf = assessedSpecs.length
    ? assessedSpecs.reduce((a, sp) => a + sp.confidence, 0) / assessedSpecs.length
    : 0;

  function checkState(types: string[]) {
    const hits = sideFindings.filter((f) =>
      types.some((t) => f.type.toLowerCase().includes(t))
    );
    // Confidence is the model's ACTUAL confidence for this side. It used to be
    // synthesised as `0.9 + (1 - sideConf) * 0.06` whenever nothing was found —
    // an invented ≥90% that was identical across all four rows and, worse, rose
    // as the real confidence fell.
    const conf = hits.length
      ? Math.max(...hits.map((h) => h.confidence))
      : sideRealConf;
    return { hits, conf: Math.round(conf * 100), assessed: sideAssessed };
  }

  const score = typeof cascade.score === "number" ? cascade.score : null;
  const live = cascade.source === "gemini";
  const intakeOk = cascade.intake?.passed !== false;

  return (
    <section className="mt-4 overflow-hidden rounded-3xl border border-[var(--border)] bg-[var(--card)]">
      <div className="flex items-center justify-between px-6 py-5 sm:px-9">
        <div>
          <h2 className="text-[13px] font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
            Condition report
          </h2>
          <p className="mt-0.5 text-[13px] text-[var(--muted)]">
            What the camera looked for, side by side.
          </p>
        </div>
        <span
          className="rounded-full px-3 py-1 text-[12px] font-medium"
          style={{
            color: live ? "var(--green-ink)" : "var(--muted)",
            background: live
              ? "color-mix(in oklch, var(--green) 14%, transparent)"
              : "var(--bg-soft)",
          }}
        >
          {live ? "Checked" : "Preview"}
        </span>
      </div>

      <div className="grid gap-6 px-6 pb-6 sm:px-9 md:grid-cols-2">
        {/* Photo + highlighted marks */}
        <div>
          <div className="relative overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-soft)]">
            {photos[sel] ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={srcOf(photos[sel])} alt="" className="block h-auto w-full" />
            ) : (
              <div className="grid aspect-[3/4] place-items-center text-sm text-[var(--muted)]">
                no photo
              </div>
            )}
            {shown.map((f, i) => {
              const col = sevColor(f.severity);
              const [ymin, xmin, ymax, xmax] = f.box!;
              return (
                <div
                  key={i}
                  className="pointer-events-none absolute rounded-md"
                  style={{
                    top: `${ymin * 100}%`,
                    left: `${xmin * 100}%`,
                    height: `${(ymax - ymin) * 100}%`,
                    width: `${(xmax - xmin) * 100}%`,
                    border: `2px solid ${col}`,
                    boxShadow: `0 0 0 3px color-mix(in oklch, ${col} 25%, transparent)`,
                  }}
                >
                  <span
                    className="absolute -top-5 left-0 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-semibold text-white"
                    style={{ background: col }}
                  >
                    {f.label}
                  </span>
                </div>
              );
            })}
          </div>

          {/* Side picker */}
          {photos.length > 1 && (
            <div className="mt-3 grid grid-cols-4 gap-2">
              {photos.slice(0, 8).map((p, i) => {
                const active = i === sel;
                return (
                  <button
                    key={i}
                    onClick={() => setSel(i)}
                    className="flex flex-col items-center gap-1.5 rounded-xl py-2 transition-colors"
                    style={{
                      background: active ? "color-mix(in oklch, var(--brand) 10%, transparent)" : "transparent",
                      border: `1px solid ${active ? "var(--brand)" : "var(--border)"}`,
                    }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={srcOf(p)}
                      alt=""
                      className="h-8 w-8 rounded object-cover"
                      style={{ opacity: active ? 1 : 0.55 }}
                    />
                    <span
                      className="text-[10px] font-medium"
                      style={{ color: active ? "var(--text)" : "var(--muted)" }}
                    >
                      {SIDE_LABELS[i] ?? `#${i + 1}`}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Checks */}
        <div>
          {/* Photo quality */}
          <div className="mb-2 flex items-center justify-between rounded-xl bg-[var(--bg-soft)] px-4 py-3">
            <div>
              <div className="text-[14px] font-medium">Photo quality</div>
              <div className="text-[12px] text-[var(--muted)]">
                {intakeOk
                  ? "Clear enough to grade this side."
                  : cascade.intake?.issues?.[0] || "Not clear enough to grade — retake this side."}
              </div>
            </div>
            <span
              className="text-[13px] font-semibold"
              style={{ color: intakeOk ? "var(--green-ink)" : "var(--bad)" }}
            >
              {intakeOk ? "Good" : "Retake"}
            </span>
          </div>

          {/* The four plain checks */}
          <div className="divide-y divide-[var(--border)]">
            {CHECKS.map((c) => {
              const st = checkState(c.types);
              const found = st.hits.length > 0;
              return (
                <div key={c.key} className="flex items-start justify-between gap-3 py-3.5">
                  <div className="min-w-0">
                    <div className="text-[15px] font-medium">{c.name}</div>
                    <div className="text-[12px] text-[var(--muted)]">{c.desc}</div>
                    {found && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {st.hits.map((h, i) => (
                          <span
                            key={i}
                            className="rounded px-1.5 py-0.5 text-[11px] font-medium text-white"
                            style={{ background: sevColor(h.severity) }}
                          >
                            {h.label}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="shrink-0 text-right">
                    <div
                      className="text-[14px] font-semibold"
                      style={{
                        color: !st.assessed
                          ? "var(--muted)"
                          : found
                            ? "var(--gold-2)"
                            : "var(--green-ink)",
                      }}
                    >
                      {!st.assessed ? "Not assessed" : found ? `${st.hits.length} found` : "Clean"}
                    </div>
                    <div className="text-[11px] text-[var(--muted)]">
                      {st.assessed ? `${st.conf}% sure` : "surface not visible"}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Overall */}
      <div className="flex items-center justify-between gap-4 border-t border-[var(--border)] bg-[var(--bg-soft)] px-6 py-5 sm:px-9">
        <div>
          <div className="text-[13px] font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
            Overall grade
          </div>
          <div className="mt-0.5 text-[13px] text-[var(--muted)]">
            Every side combined, weighted by what matters.
          </div>
        </div>
        <div className="flex items-center gap-3">
          {score != null && (
            <span className="mono text-[13px] text-[var(--muted)]">{score}/100</span>
          )}
          <GradeBadge grade={cascade.grade} />
        </div>
      </div>
    </section>
  );
}
