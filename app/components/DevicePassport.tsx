import { withBase } from "@/lib/basePath";
import Barcode from "./Barcode";
import type { DiagnosticRow, Passport } from "@/lib/passport";

// Apple-listing-style device record: airy, hairline spec rows, a product hero
// with the final grade, refined typography.

const APPLE_FONT =
  'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function gradeColor(g: string): string {
  return (
    {
      Premium: "var(--green)",
      A: "var(--green)",
      B: "var(--gold-2)",
      C: "var(--gold-2)",
      D: "var(--bad)",
    } as Record<string, string>
  )[g] || "var(--muted)";
}

// Highlight colour for a located defect by severity (falls back by defect type).
function severityColor(sev: string, type = ""): string {
  const s = `${sev} ${type}`.toLowerCase();
  if (/major|severe|crack|shatter|dent/.test(s)) return "#ef4444";
  if (/moder|chip|deadpixel/.test(s)) return "#f59e0b";
  return "#38bdf8"; // minor / scuff / scratch / wear
}

function Section({
  title,
  meta,
  children,
  first,
}: {
  title: string;
  meta?: string;
  children: React.ReactNode;
  first?: boolean;
}) {
  return (
    <section
      className={`px-6 py-9 sm:px-10 ${first ? "" : "border-t border-[var(--border)]"}`}
    >
      <div className="mb-5 flex items-baseline justify-between">
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.12em] text-[var(--muted)]">
          {title}
        </h2>
        {meta && (
          <span className="text-[13px] text-[var(--muted)]">{meta}</span>
        )}
      </div>
      {children}
    </section>
  );
}

function SpecRow({
  k,
  v,
  mono,
  accent,
  last,
}: {
  k: string;
  v: React.ReactNode;
  mono?: boolean;
  accent?: string;
  last?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between gap-4 py-3.5 ${
        last ? "" : "border-b border-[var(--border)]"
      }`}
    >
      <span className="text-[15px] text-[var(--muted)]">{k}</span>
      <span
        className={`text-[15px] font-medium ${mono ? "mono" : ""}`}
        style={accent ? { color: accent } : undefined}
      >
        {v}
      </span>
    </div>
  );
}

const TONE: Record<string, string> = {
  good: "var(--green-ink)",
  warn: "var(--gold-2)",
  bad: "var(--bad)",
};

/** A diagnostics line: the value and its source, or why there is none. */
function DiagRow({ r, last }: { r: DiagnosticRow; last?: boolean }) {
  // "tested" (the station's own test time), "looked up" (when GradeIQ fetched
  // it) or "checked" (when the registry was asked) — never one for another.
  const provenance = [r.source, r.checkedAt ? `${r.timeLabel ?? "checked"} ${r.checkedAt}` : ""].filter(Boolean).join(" · ");
  return (
    <div
      className={`flex items-start justify-between gap-4 py-3.5 ${
        last ? "" : "border-b border-[var(--border)]"
      }`}
    >
      <span className="text-[15px] text-[var(--muted)]">{r.label}</span>
      <span className="min-w-0 text-right">
        {r.value != null ? (
          <span
            className="block text-[15px] font-medium"
            style={r.tone ? { color: TONE[r.tone] } : undefined}
          >
            {r.href ? (
              <a href={r.href} target="_blank" rel="noopener noreferrer" className="underline">
                {r.value}
              </a>
            ) : (
              r.value
            )}
          </span>
        ) : (
          <span className="block text-[14px] text-[var(--muted)]">{r.note}</span>
        )}
        {r.value != null && r.note && (
          <span className="mt-0.5 block text-[12px] leading-snug text-[var(--muted)]">{r.note}</span>
        )}
        {provenance && (
          <span className="mt-0.5 block text-[12px] leading-snug text-[var(--muted)]">{provenance}</span>
        )}
      </span>
    </div>
  );
}

export default function DevicePassport({ p }: { p: Passport }) {
  const idOf = (label: string) =>
    p.identification.find((f) => f.label === label)?.value || "—";
  const model = idOf("Model");
  const make = idOf("Make");
  const storage = idOf("Storage");
  const colour = idOf("Colour");
  const subtitle = [storage, colour].filter((x) => x && x !== "—").join(" · ");
  const g = p.finalGrade === "—" ? "" : p.finalGrade.split("·")[0].trim();

  return (
    <section
      className="overflow-hidden rounded-3xl border border-[var(--border)] bg-[var(--card)]"
      style={{ fontFamily: APPLE_FONT }}
    >
      {/* Hero */}
      <div className="px-6 pt-12 pb-10 text-center sm:px-10">
        {/* Anti-fraud: the tested/photographed device doesn't match the IMEI */}
        {p.identity.verdict === "mismatch" && (
          <div
            className="mx-auto mb-6 max-w-md rounded-2xl px-5 py-4 text-left"
            style={{ background: "color-mix(in oklch, var(--bad) 12%, transparent)", border: "1px solid color-mix(in oklch, var(--bad) 40%, transparent)" }}
          >
            <div className="text-[14px] font-bold" style={{ color: "var(--bad)" }}>
              ⛔ Device does not match the IMEI
            </div>
            <p className="mt-1 text-[13px] text-[var(--text)]">
              Verify you are testing and photographing the exact phone whose IMEI
              was scanned — do not accept this device until it&apos;s resolved.
            </p>
            <ul className="mt-1.5 space-y-0.5 text-[13px] text-[var(--muted)]">
              {p.identity.flags.map((f, i) => (
                <li key={i}>• {f}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Case / cover / protector detected — hides the real condition */}
        {p.obstruction?.present && (
          <div
            className="mx-auto mb-6 max-w-md rounded-2xl px-5 py-4 text-left"
            style={{ background: "color-mix(in oklch, var(--gold) 12%, transparent)", border: "1px solid color-mix(in oklch, var(--gold) 40%, transparent)" }}
          >
            <div className="text-[14px] font-bold" style={{ color: "var(--gold-2)" }}>
              ⚠ {cap(p.obstruction.type)} detected — remove it
            </div>
            <p className="mt-1 text-[13px] text-[var(--text)]">
              {p.obstruction.note ||
                `A ${p.obstruction.type} hides the phone's real surface and can conceal cracks or scratches.`}{" "}
              Take the {p.obstruction.type} off and retake the photos for a true
              grade.
            </p>
          </div>
        )}

        <span
          className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-medium ${
            p.verified
              ? "text-[var(--green-ink)]"
              : "text-[var(--muted)]"
          }`}
          style={{
            background: p.verified ? "color-mix(in oklch, var(--green) 16%, transparent)" : "var(--bg-soft)",
          }}
        >
          {p.verified ? "✓ Verified" : "● Pending verification"}
        </span>
        {p.identity.verdict === "match" && (
          <span
            className="ml-2 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-medium text-[var(--green-ink)]"
            style={{ background: "color-mix(in oklch, var(--green) 16%, transparent)" }}
          >
            ✓ IMEI matches device
          </span>
        )}

        <h1 className="mt-5 text-[34px] font-semibold leading-tight tracking-tight sm:text-[40px]">
          {model !== "—" ? model : make !== "—" ? make : "Unknown device"}
        </h1>
        {subtitle && (
          <p className="mt-1 text-[17px] text-[var(--muted)]">{subtitle}</p>
        )}

        {/* Grade hero */}
        <div className="mt-9 flex flex-col items-center">
          <div
            className="grid h-24 w-24 place-items-center rounded-full text-4xl font-bold text-white"
            style={{
              background: g ? gradeColor(g) : "var(--card-2)",
              opacity: g && !p.reliable ? 0.45 : 1,
            }}
          >
            {g || "—"}
          </div>
          <div className="mt-4 text-[15px] text-[var(--muted)]">
            {g && !p.reliable ? (
              <span className="font-medium" style={{ color: "var(--gold-2)" }}>
                Provisional{p.score != null ? ` · ${p.score}/100` : ""}
              </span>
            ) : p.score != null ? (
              <span className="font-medium text-[var(--text)]">
                {p.score}
                <span className="text-[var(--muted)]">/100</span>
              </span>
            ) : (
              "Not yet graded"
            )}
          </div>
          <p className="mx-auto mt-2 max-w-md text-[15px] leading-relaxed text-[var(--muted)]">
            {p.narrative}
          </p>
        </div>

        {/* Reliability guard — the grade can't be trusted until photos are good */}
        {g && !p.reliable && (
          <div
            className="mx-auto mt-6 max-w-md rounded-2xl px-5 py-4 text-left"
            style={{ background: "color-mix(in oklch, var(--gold) 10%, transparent)" }}
          >
            <div className="text-[14px] font-semibold" style={{ color: "var(--gold-2)" }}>
              ⚠ Grade not reliable — retake needed
            </div>
            <p className="mt-1 text-[13px] text-[var(--muted)]">
              Some areas couldn&apos;t be checked clearly from these photos, so the grade
              above is provisional:
            </p>
            <ul className="mt-1.5 space-y-0.5 text-[13px] text-[var(--muted)]">
              {p.retakeReasons.map((r, i) => (
                <li key={i}>• {r}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Model details — the captured identity & spec, promoted to the top as
          the primary focus of the record (make, model, size, colour, OS,
          carrier, IMEI, serial, battery). Only rows we actually captured show. */}
      <Section title="Model details">
        {(() => {
          const rows = p.identification.filter((f) => f.value && f.value !== "—");
          const bh = p.diagnostics.batteryHealth;
          return (
            <div>
              {rows.map((f, i) => (
                <SpecRow
                  key={f.label}
                  k={f.label}
                  v={f.value}
                  mono={f.mono}
                  last={bh == null && i === rows.length - 1}
                />
              ))}
              {bh != null && (
                <SpecRow
                  k="Battery health"
                  v={`${bh}%`}
                  accent={
                    bh >= 90 ? "var(--green-ink)" : bh >= 80 ? "var(--gold-2)" : "var(--bad)"
                  }
                  last
                />
              )}
            </div>
          );
        })()}
      </Section>

      {/* Cosmetic condition */}
      {p.cosmetic.angles.length > 0 && (
        <Section
          title="Cosmetic condition"
          meta={`${p.cosmetic.angles.length} angles · ${p.cosmetic.findings} findings`}
        >
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {p.cosmetic.angles.map((a, i) => (
              <figure key={i} className="overflow-hidden">
                <div className="relative overflow-hidden rounded-2xl bg-[var(--bg-soft)]">
                  {a.photo && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={withBase(a.photo)}
                      alt={a.label}
                      className="block aspect-[3/4] w-full object-cover"
                    />
                  )}
                  {a.grade && (
                    <span
                      className="absolute right-2 top-2 rounded-full px-2 py-0.5 text-[12px] font-semibold text-white"
                      style={{ background: gradeColor(a.grade) }}
                    >
                      {a.grade}
                    </span>
                  )}
                  {/* highlight each located defect on the photo */}
                  {a.findings.map((f, k) =>
                    f.box ? (
                      <div
                        key={k}
                        className="absolute rounded-[3px]"
                        style={{
                          top: `${f.box[0] * 100}%`,
                          left: `${f.box[1] * 100}%`,
                          height: `${Math.max(0, f.box[2] - f.box[0]) * 100}%`,
                          width: `${Math.max(0, f.box[3] - f.box[1]) * 100}%`,
                          border: `2px solid ${severityColor(f.severity, f.type)}`,
                          boxShadow: "0 0 0 1px rgba(0,0,0,0.35)",
                        }}
                        title={f.label}
                      />
                    ) : null,
                  )}
                  {a.findings.length > 0 && (
                    <span className="absolute bottom-2 left-2 rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-semibold text-white">
                      🔍 {a.findings.length} {a.findings.length === 1 ? "mark" : "marks"}
                    </span>
                  )}
                </div>
                <figcaption className="mt-2 flex items-center justify-between px-0.5">
                  <span className="text-[13px] font-medium tracking-wide">
                    {a.label}
                  </span>
                  {a.confidence > 0 && (
                    <span className="text-[12px] text-[var(--muted)]">
                      {Math.round(a.confidence * 100)}%
                    </span>
                  )}
                </figcaption>
                {a.findings.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1 px-0.5">
                    {a.findings.slice(0, 4).map((f, k) => (
                      <span
                        key={k}
                        className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold capitalize"
                        style={{
                          color: severityColor(f.severity, f.type),
                          background: `${severityColor(f.severity, f.type)}1f`,
                        }}
                      >
                        {f.type}
                      </span>
                    ))}
                  </div>
                )}
              </figure>
            ))}
          </div>
        </Section>
      )}

      {/* Functional — pass/fail results, right after the condition evidence so
          the record reads Model → Damage → Functional before the deeper
          per-part / diagnostics assessment. */}
      <Section
        title="Functional"
        meta={`${p.functional.verdict} · ${p.functional.passed}/${p.functional.total}`}
      >
        <div className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-3">
          {p.functional.items.map((it) => (
            <div key={it.name} className="flex items-center gap-2.5 text-[15px]">
              <span
                className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] text-white"
                style={{
                  background:
                    it.state === "pass"
                      ? "var(--green)"
                      : it.state === "fail"
                        ? "var(--bad)"
                        : "var(--card-2)",
                  color: it.state === "untested" || it.state === "skip" ? "var(--muted)" : "#fff",
                }}
              >
                {it.state === "pass"
                  ? "✓"
                  : it.state === "fail"
                    ? "✕"
                    : it.state === "skip"
                      ? "–"
                      : "·"}
              </span>
              <span className={it.state === "untested" ? "text-[var(--muted)]" : ""}>
                {it.name}
                {/* What is actually behind the tick or cross. A single "Cameras"
                    row cannot carry four lenses, and without this the record
                    says less than the data it was built from. */}
                {it.detail && (
                  <span className="block text-[11.5px] leading-tight text-[var(--muted)]">
                    {it.detail}
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>
      </Section>

      {/* Component grading — per component */}
      {p.cosmetic.components.length > 0 && (
        <Section
          title="Condition by part"
          meta={`${p.cosmetic.components.length} components`}
        >
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {p.cosmetic.components.map((c) => (
              <div
                key={c.name}
                className="rounded-2xl border border-[var(--border)] p-4"
              >
                <div className="flex items-center justify-between">
                  <span className="text-[15px] font-semibold">{c.name}</span>
                  <span
                    className="text-[15px] font-bold"
                    style={{ color: gradeColor(c.grade) }}
                  >
                    {c.grade}
                  </span>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--bg-soft)]">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${c.score}%`, background: gradeColor(c.grade) }}
                  />
                </div>
                <div className="mt-1 flex items-center justify-between">
                  <span className="mono text-[11px] text-[var(--muted)]">
                    {c.score}/100
                  </span>
                </div>
                <p className="mt-2 text-[13px] leading-relaxed text-[var(--muted)]">
                  {c.note}
                </p>
                {c.defects.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {c.defects.map((f, k) => (
                      <span
                        key={k}
                        className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold"
                        style={{
                          color: severityColor(f.severity, f.type),
                          background: `${severityColor(f.severity, f.type)}1f`,
                        }}
                        title={f.severity ? `${f.severity} · ${f.label}` : f.label}
                      >
                        <span
                          className="h-1.5 w-1.5 rounded-full"
                          style={{ background: severityColor(f.severity, f.type) }}
                        />
                        {f.label}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Diagnostics — each line says who answered it (a Phonecheck station,
          the GSMA registry via Phonecheck, the Settings screenshot, the phone's
          browser) and when; a line nobody answered says why, for that line
          alone. Built in lib/passport.ts buildDiagnostics. */}
      <Section title="Diagnostics" meta={p.diagnostics.source}>
        <div>
          {p.diagnostics.rows.map((r, i) => (
            <DiagRow key={r.key} r={r} last={i === p.diagnostics.rows.length - 1} />
          ))}
        </div>
      </Section>

      {/* Parts integrity (OEM / non-OEM) */}
      {p.parts.checked && (
        <Section
          title="Parts integrity"
          meta={p.parts.anyNonGenuine ? "Non-OEM detected" : "Genuine"}
        >
          <div
            className="mb-3 rounded-xl px-4 py-3 text-[14px] font-medium"
            style={{
              color: p.parts.anyNonGenuine ? "var(--bad)" : "var(--green-ink)",
              background: p.parts.anyNonGenuine
                ? "color-mix(in oklch, var(--bad) 9%, transparent)"
                : "color-mix(in oklch, var(--green) 13%, transparent)",
            }}
          >
            {p.parts.anyNonGenuine
              ? "⚠ One or more non-genuine parts detected"
              : "✓ All read parts pass the device parts-authentication check"}
          </div>
          <div>
            {p.parts.items.map((pt, i) => (
              <SpecRow
                key={i}
                k={pt.name}
                v={
                  pt.status === "genuine"
                    ? "Genuine"
                    : pt.status === "non_genuine"
                      ? "Non-OEM"
                      : "Unknown"
                }
                accent={
                  pt.status === "genuine"
                    ? "var(--green-ink)"
                    : pt.status === "non_genuine"
                      ? "var(--bad)"
                      : "var(--muted)"
                }
                last={i === p.parts.items.length - 1}
              />
            ))}
          </div>
        </Section>
      )}

      {/* Provenance — who graded it, when, and the tamper-evident signature.
          Device specs live in "Model details" up top. */}
      <Section title="Provenance">
        <div>
          <SpecRow
            k="Graded by"
            v={p.cosmetic.source === "gemini" ? "GradeIQ" : p.issuer}
          />
          <SpecRow k="Issued" v={p.issuedAt} mono last />
        </div>

        {p.imei && (
          <div className="mt-7 flex flex-col items-center">
            <Barcode value={p.imei} height={46} />
          </div>
        )}

        <p className="mt-6 text-center text-[11px] leading-relaxed text-[var(--muted)]">
          <span className="uppercase tracking-wider">Signature · SHA-256</span>
          <br />
          <span className="mono break-all">{p.signature}</span>
        </p>
      </Section>
    </section>
  );
}
