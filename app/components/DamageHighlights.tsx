"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { withBase } from "@/lib/basePath";
import { scopeOf, deviceBoxByPhoto } from "@/lib/findingScope";

// "What the AI saw" — the evidence behind the grade. One large frame at a time
// with every LOCATED defect boxed and TAGGED with Gemini's own label ("Glass chip",
// "Hairline · 0.4mm", "Scuff"), plus angle tabs to flip between the captured sides.
// Nothing here is typed by hand: boxes + labels come straight from the vision pass.

type Finding = {
  label: string;
  severity: string;
  photoIndex: number;
  box?: [number, number, number, number];
  type?: string;
};

// Severity → tag colour. Gemini returns exactly minor | moderate | severe.
const SEV: Record<string, { line: string; ink: string }> = {
  severe: { line: "#ef4444", ink: "#ffffff" },
  moderate: { line: "#f59e0b", ink: "#1c1408" },
  minor: { line: "#7dd3fc", ink: "#062330" },
};
const sevOf = (s: string) => SEV[s] ?? SEV.minor;

const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

function validBox(b?: [number, number, number, number]) {
  return (
    !!b &&
    b.every((n) => n >= 0 && n <= 1) &&
    b[2] > b[0] &&
    b[3] > b[1] &&
    b[2] - b[0] <= 0.95 &&
    b[3] - b[1] <= 0.95
  );
}

export default function DamageHighlights({
  photos,
  findings,
  labels = [],
  refining = false,
  unfinished = false,
  deviceBoxes = [],
}: {
  photos: string[];
  findings: Finding[];
  labels?: string[];
  /** A Pro pass is still running — marks may still be on their way. */
  refining?: boolean;
  /** SUP-63: the grading died before it located anything. Not a clean result. */
  unfinished?: boolean;
  /** Where the handset sits in each photo, for the on-device check. */
  deviceBoxes?: { photoIndex: number; box: [number, number, number, number] }[];
}) {
  const srcOf = (p: string) => (/^data:/.test(p) ? p : withBase(p));
  const boxed = (findings || []).filter((f) => validBox(f.box));
  /**
   * Findings the grader DESCRIBED but never located.
   *
   * These used to disappear: the panel drew only boxed findings, so a grade of
   * B backed by four unlocated findings rendered as a green "no visible damage"
   * tick. The report contradicted its own grade. They are listed as text now —
   * a mark without coordinates is still evidence.
   */
  const unlocated = (findings || []).filter((f) => !validBox(f.box));
  const deviceFor = deviceBoxByPhoto(deviceBoxes);
  const marksFor = (i: number) => boxed.filter((f) => f.photoIndex === i);
  const total = boxed.length;

  // Open on the first frame that actually has a located defect.
  const firstMarked = photos.findIndex((_, i) => marksFor(i).length > 0);
  const [sel, setSel] = useState(firstMarked >= 0 ? firstMarked : 0);

  // The photo is shown with object-contain, so a portrait shot is letter-boxed
  // inside a wider frame. Measure the ACTUAL rendered image rectangle (offset +
  // size within the frame) so the located-defect boxes land on the real pixels
  // instead of floating in the empty bars. Recomputed on load, tab-change and
  // resize.
  const frameRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [rect, setRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const measure = useCallback(() => {
    const frame = frameRef.current;
    const img = imgRef.current;
    if (!frame || !img || !img.naturalWidth || !img.naturalHeight) return;
    const fw = frame.clientWidth;
    const fh = frame.clientHeight;
    const ar = img.naturalWidth / img.naturalHeight;
    let w = fw;
    let h = fw / ar;
    if (h > fh) {
      h = fh;
      w = fh * ar;
    }
    setRect({ left: (fw - w) / 2, top: (fh - h) / 2, width: w, height: h });
  }, []);

  const cur = Math.min(sel, photos.length - 1);
  useEffect(() => {
    measure();
    // A ResizeObserver on the frame recomputes the rect whenever the frame gains
    // or changes size — crucially when the image finishes loading and expands the
    // frame from zero, which a one-shot onLoad/measure can miss if it fires early.
    const frame = frameRef.current;
    let ro: ResizeObserver | undefined;
    if (frame && typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => measure());
      ro.observe(frame);
    }
    window.addEventListener("resize", measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [measure, cur]);

  if (!photos.length) return null;
  const marks = marksFor(cur);
  const labelOf = (i: number) => labels[i] || `Angle ${i + 1}`;

  return (
    <section className="mt-4 rounded-3xl border border-[var(--border)] bg-[var(--card)] px-6 py-9 sm:px-10">
      <div className="mb-1 flex items-baseline justify-between">
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
          Damage highlights
        </h2>
        <span className="text-[13px] text-[var(--muted)]">
          {total > 0
            ? `${total} mark${total > 1 ? "s" : ""} located`
            : `${photos.length} photo${photos.length > 1 ? "s" : ""} captured`}
        </span>
      </div>
      <p className="mb-4 text-[13px] text-[var(--muted)]">
        The exact photos we assessed, with every mark we found boxed and labelled. Nothing is
        entered by hand.
      </p>

      {/* THREE DIFFERENT SITUATIONS, three different answers.
          One green tick used to cover all of them, so a device graded B whose
          marks had not arrived yet — or had arrived without coordinates — was
          reported as undamaged. A clean tick has to be earned. */}
      {total === 0 && refining && !unfinished && (
        <div className="mb-4 flex items-center gap-3 rounded-2xl bg-[var(--bg-soft)] px-4 py-3 text-[14px]">
          <span
            className="inline-block h-3 w-3 shrink-0 animate-pulse rounded-full"
            style={{ background: "var(--brand)" }}
          />
          <span className="text-[var(--muted)]">
            Still locating marks — the full inspection is running. They appear here
            automatically.
          </span>
        </div>
      )}
      {total === 0 && unfinished && (
        <div className="mb-4 flex items-center gap-3 rounded-2xl bg-[var(--bg-soft)] px-4 py-3 text-[14px]">
          <span style={{ color: "var(--gold-2)" }}>!</span>
          <span className="text-[var(--muted)]">
            Grading did not finish, so no marks were located on these photos yet. They will be
            checked again.
          </span>
        </div>
      )}
      {total === 0 && !refining && !unfinished && unlocated.length > 0 && (
        <div className="mb-4 rounded-2xl bg-[var(--bg-soft)] px-4 py-3 text-[14px]">
          <div className="flex items-center gap-3">
            <span style={{ color: "var(--gold-2)" }}>!</span>
            <span className="text-[var(--muted)]">
              {unlocated.length} finding{unlocated.length > 1 ? "s were" : " was"} recorded without a
              position, so {unlocated.length > 1 ? "they cannot" : "it cannot"} be boxed on a photo.
            </span>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5 pl-7">
            {unlocated.map((f, i) => (
              <span
                key={i}
                className="rounded-full px-2.5 py-1 text-[11.5px]"
                style={{ background: "var(--card-2)", color: "var(--text)" }}
              >
                {f.label || f.type || "finding"}
              </span>
            ))}
          </div>
        </div>
      )}
      {total === 0 && !refining && !unfinished && unlocated.length === 0 && (
        <div className="mb-4 flex items-center gap-3 rounded-2xl bg-[var(--bg-soft)] px-4 py-3 text-[14px]">
          <span style={{ color: "var(--green-ink)" }}>✓</span>
          <span className="text-[var(--muted)]">
            No visible damage located on the captured photos.
          </span>
        </div>
      )}

      {/* Located marks, but some described ones could not be placed. Say so —
          the count above would otherwise under-report the findings. */}
      {total > 0 && unlocated.length > 0 && (
        <p className="mb-3 text-[12.5px]" style={{ color: "var(--gold-2)" }}>
          + {unlocated.length} more finding{unlocated.length > 1 ? "s" : ""} recorded without a
          position: {unlocated.map((f) => f.label || f.type).filter(Boolean).join(", ")}
        </p>
      )}

      {/* Featured frame — object-contain, with each located-defect box placed on
          the MEASURED image rectangle (see `rect`) so it sits on the real photo,
          not in the empty bars object-contain leaves beside a portrait shot. */}
      <div
        ref={frameRef}
        className="relative overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-soft)]"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={imgRef}
          src={srcOf(photos[cur])}
          alt={labelOf(cur)}
          onLoad={measure}
          className="mx-auto block max-h-[520px] w-full object-contain"
        />
        {rect &&
          marks.map((f, k) => {
            const c = sevOf(f.severity);
            const [ymin, xmin, ymax, xmax] = f.box!;
            const nearTop = ymin < 0.08; // flip the tag below the box when it'd clip off-frame
            /* IS THIS MARK EVEN ON THE PHONE?
             *
             * On a side capture the handset can be under a third of the frame,
             * and hands, table and floor are all edge-rich enough to be read as
             * damage. A box on tile grout is drawn exactly as confidently as one
             * on a bent rail. Where the grader reported the handset's outline we
             * can now say which is which — and it is a LABEL, not a filter: the
             * outline is approximate, so a flagged mark is still shown and still
             * judged by a person, never silently deleted. */
            const scope = scopeOf(f.box, deviceFor.get(cur));
            const off = scope === "off-device";
            return (
              <div
                key={k}
                className="pointer-events-none absolute"
                style={{
                  top: rect.top + ymin * rect.height,
                  left: rect.left + xmin * rect.width,
                  height: (ymax - ymin) * rect.height,
                  width: (xmax - xmin) * rect.width,
                  // A mark that missed the handset is drawn dashed and grey, so
                  // it reads as questionable at a glance rather than as a
                  // confirmed defect in the severity colour.
                  border: off ? `2px dashed #9ca3af` : `2px solid ${c.line}`,
                  borderRadius: 6,
                  boxShadow: off ? "none" : `0 0 0 3px ${c.line}33, 0 0 18px ${c.line}66`,
                }}
              >
                <span
                  className="absolute whitespace-nowrap rounded-md px-2 py-[3px] text-[11px] font-bold"
                  style={{
                    background: off ? "#9ca3af" : c.line,
                    color: off ? "#111827" : c.ink,
                    fontFamily: MONO,
                    left: -2,
                    ...(nearTop ? { bottom: -24 } : { top: -24 }),
                    boxShadow: off ? "none" : `0 2px 10px ${c.line}55`,
                  }}
                >
                  {f.label}
                  {off ? " · not on the phone?" : ""}
                </span>
              </div>
            );
          })}
        <span className="absolute right-3 top-3 rounded-full bg-black/55 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-white">
          {labelOf(cur)}
        </span>
      </div>

      {/* Angle tabs — flip between every captured side */}
      {photos.length > 1 && (
        <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-6">
          {photos.map((p, i) => {
            const n = marksFor(i).length;
            const active = i === cur;
            return (
              <button
                key={i}
                onClick={() => setSel(i)}
                className="group relative overflow-hidden rounded-xl border p-1 text-left transition"
                style={{
                  borderColor: active ? "var(--brand)" : "var(--border)",
                  background: active ? "color-mix(in oklch, var(--brand) 10%, transparent)" : "transparent",
                }}
                aria-label={`Show ${labelOf(i)}`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={srcOf(p)} alt="" className="block h-14 w-full rounded-lg object-cover" />
                <div className="mt-1 flex items-center justify-between px-0.5 pb-0.5">
                  <span className="truncate text-[11px] font-semibold text-[var(--muted)]">
                    {labelOf(i)}
                  </span>
                  {n > 0 && (
                    <span
                      className="ml-1 shrink-0 rounded-full px-1.5 text-[10px] font-bold"
                      style={{ background: "var(--bad)", color: "#fff" }}
                    >
                      {n}
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
