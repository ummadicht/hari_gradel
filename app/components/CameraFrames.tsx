import { withBase } from "@/lib/basePath";
import type { CameraAssessment, LensFinding } from "@/lib/cameraAssess";

/**
 * The stills each lens actually produced, plus what the optical assessment made
 * of them.
 *
 * OPERATOR-ONLY. The report page gates this on `experience === "operator"`.
 * Rear frames show the counter; the FRONT frame shows whoever was holding the
 * phone — in a retail trade-in, the customer. Those images are evidence for the
 * person buying the device, not something to render back at the person selling
 * it, and the seller-facing report has no business displaying a photograph of
 * their own face taken during a hardware test.
 */

const IMPACT_COPY: Record<LensFinding["impact"], { label: string; chip: string }> = {
  // The distinction the whole feature turns on: only "fault" costs money.
  cleanable: { label: "Wipe the lens", chip: "chip-yellow" },
  retake: { label: "Retake — not a fault", chip: "chip-yellow" },
  fault: { label: "Camera fault", chip: "chip-red" },
};

const VERDICT_COPY: Record<string, { label: string; chip: string }> = {
  clear: { label: "Clear", chip: "chip-green" },
  degraded: { label: "Degraded", chip: "chip-yellow" },
  faulty: { label: "Faulty", chip: "chip-red" },
  not_assessed: { label: "Not assessed", chip: "" },
};

export default function CameraFrames({
  frames,
  assessment,
}: {
  frames?: { lensId: string; name: string; facing: string; url: string }[];
  assessment?: CameraAssessment | null;
}) {
  if (!frames?.length) return null;

  const byLens = new Map((assessment?.lenses ?? []).map((l) => [l.lensId, l]));

  return (
    <section className="card mt-4 p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-lg font-bold">Camera test shots</h2>
        <span className="text-[11px] text-[var(--muted)]">
          {assessment
            ? `Assessed ${assessment.lenses.length} lens${assessment.lenses.length > 1 ? "es" : ""}`
            : "Not assessed yet"}
        </span>
      </div>
      <p className="mt-1 text-[13px] text-[var(--muted)]">
        One frame taken by each working lens. The functional test only proves a
        sensor responds — these show whether it still takes an acceptable
        picture.
      </p>

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        {frames.map((f) => {
          const a = byLens.get(f.lensId);
          const v = VERDICT_COPY[a?.verdict ?? "not_assessed"];
          return (
            <figure key={f.lensId + f.url} className="min-w-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={withBase(f.url)}
                alt={`${f.name} test shot`}
                className="aspect-[4/3] w-full rounded-xl object-cover"
                style={{ background: "var(--bg)" }}
              />
              <figcaption className="mt-1.5">
                <div className="truncate text-[12px] font-semibold">{f.name}</div>
                <div className="mt-0.5 flex flex-wrap items-center gap-1">
                  <span className={`pill ${v.chip}`} style={{ fontSize: 10 }}>
                    {v.label}
                  </span>
                  {a?.findings.map((fd, i) => (
                    <span
                      key={i}
                      className={`pill ${IMPACT_COPY[fd.impact].chip}`}
                      style={{ fontSize: 10 }}
                      title={fd.note}
                    >
                      {fd.type} · {IMPACT_COPY[fd.impact].label}
                    </span>
                  ))}
                </div>
              </figcaption>
            </figure>
          );
        })}
      </div>

      {assessment && (
        <p className="mt-3 text-[11px] text-[var(--muted)]">
          Smudges and blur are not camera faults — they mean wipe the lens or
          retake the shot. Only findings marked{" "}
          <span className="pill chip-red" style={{ fontSize: 10 }}>
            Camera fault
          </span>{" "}
          indicate damaged hardware.
        </p>
      )}
    </section>
  );
}
