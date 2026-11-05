import { withBase } from "@/lib/basePath";

// Read-only report section: the AI display validation from the photo-based
// screen test (captured colour patterns + any panel defects found).
type Finding = {
  pattern: string;
  label: string;
  /** Where on that pattern's photo the defect sits — [ymin,xmin,ymax,xmax] 0..1. */
  box?: [number, number, number, number];
  severity?: "minor" | "moderate" | "severe";
};
type Cap = { pattern: string; photo: string };
type Check = {
  verdict: "pass" | "fail" | "unknown";
  note: string;
  source: string;
  findings: Finding[];
  captures: Cap[];
  /** Patterns the sweep set out to verify. */
  requested?: string[];
  /** Requested patterns it could never confirm on screen. */
  missing?: string[];
};

export default function DisplayResult({ check }: { check: Check }) {
  const color =
    check.verdict === "pass"
      ? "var(--green-ink)"
      : check.verdict === "fail"
        ? "var(--bad)"
        : "var(--gold-2)";
  const bg =
    check.verdict === "pass"
      ? "color-mix(in oklch, var(--green) 14%, transparent)"
      : check.verdict === "fail"
        ? "color-mix(in oklch, var(--bad) 12%, transparent)"
        : "color-mix(in oklch, var(--gold) 12%, transparent)";

  return (
    <section className="mt-4 rounded-3xl border border-[var(--border)] bg-[var(--card)] px-6 py-9 sm:px-10">
      <div className="mb-1 flex items-baseline justify-between">
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
          Display — screen test
        </h2>
        <span className="text-[13px] text-[var(--muted)]">
          {check.source === "gemini" ? "Checked" : "not validated"}
        </span>
      </div>

      <span
        className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[13px] font-semibold"
        style={{ color, background: bg }}
      >
        {check.verdict === "pass"
          ? "✓ Display OK"
          : check.verdict === "fail"
            ? "✕ Display defects found"
            : "– Not confirmed — check manually"}
      </span>
      <p className="mt-2 text-[13px] text-[var(--muted)]">{check.note}</p>

      {check.findings?.length > 0 && (
        <ul className="mt-2 space-y-1 text-[13px]">
          {check.findings.map((f, i) => (
            <li key={i} style={{ color: "var(--bad)" }}>
              • {f.label}{" "}
              <span className="text-[var(--muted)]">({f.pattern})</span>
            </li>
          ))}
        </ul>
      )}

      {/* THE SCREEN EVIDENCE. These are the actual test patterns as the camera
          saw them on the device's own display — the white field that shows dead
          pixels and a foldable's crease, the stripes that show driver lines. It
          used to render as 80px thumbnails cropped square with object-cover,
          which threw away the middle of the panel: the exact region the test is
          about. Full frames, uncropped, with the patterns that never verified
          named rather than silently absent. */}
      {(check.captures?.length > 0 || check.missing?.length) && (
        <div className="mt-4">
          <div className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-[var(--muted)]">
            Screen test patterns
            {check.requested?.length
              ? ` · ${check.captures?.length ?? 0} of ${check.requested.length} confirmed`
              : ""}
          </div>
          {check.captures?.length > 0 && (
            <div className="flex gap-3 overflow-x-auto pb-1">
              {check.captures.map((c, i) => {
                /* Point at the defect, don't just name it.
                   A dead pixel or a pressure blob is a DOT — describing it in a
                   bullet list and leaving the reader to hunt for it across six
                   thumbnails is the one job a photo report should do for them.
                   The model already returns a box per finding; this draws it on
                   the pattern the defect shows best on. */
                const marks = (check.findings || []).filter(
                  (f) => f.pattern === c.pattern && Array.isArray(f.box) && f.box.length === 4,
                );
                return (
                <figure key={i} className="shrink-0">
                  <div className="relative inline-block">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={withBase(c.photo)}
                    alt={`${c.pattern} test pattern on the device screen`}
                    className="h-56 w-auto rounded-xl border border-[var(--border)] bg-black object-contain"
                  />
                  {marks.map((f, k) => {
                    const [ymin, xmin, ymax, xmax] = f.box as [number, number, number, number];
                    // Ignore a box that spans essentially the whole frame — a
                    // full-screen tint is real but highlighting everything
                    // highlights nothing, and the bullet above already says it.
                    if (ymax - ymin > 0.9 && xmax - xmin > 0.9) return null;
                    const ring =
                      f.severity === "severe" ? "#dc2626" : f.severity === "moderate" ? "#f59e0b" : "#38bdf8";
                    return (
                      <span
                        key={k}
                        title={f.label}
                        className="pointer-events-none absolute rounded"
                        style={{
                          top: `${ymin * 100}%`,
                          left: `${xmin * 100}%`,
                          height: `${(ymax - ymin) * 100}%`,
                          width: `${(xmax - xmin) * 100}%`,
                          border: `2px solid ${ring}`,
                          boxShadow: `0 0 0 2px rgba(0,0,0,0.35), 0 0 10px ${ring}`,
                        }}
                      />
                    );
                  })}
                  </div>
                  <figcaption className="mt-1 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-[var(--muted)]">
                    <span
                      className="inline-block h-2.5 w-2.5 rounded-sm border border-[var(--border)]"
                      style={{ background: c.pattern === "stripes" ? "#888" : c.pattern }}
                    />
                    {c.pattern}
                    {marks.length > 0 && (
                      <span style={{ color: "var(--bad)", fontWeight: 700 }}>
                        · {marks.length} marked
                      </span>
                    )}
                  </figcaption>
                </figure>
                );
              })}
            </div>
          )}
          {!!check.missing?.length && (
            <p className="mt-2 text-[12px] text-[var(--muted)]">
              Not confirmed on screen: <b>{check.missing.join(", ")}</b> — the camera never saw the
              phone showing {check.missing.length === 1 ? "it" : "them"}, so {check.missing.length === 1 ? "it was" : "they were"}{" "}
              left out rather than captured blind.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
