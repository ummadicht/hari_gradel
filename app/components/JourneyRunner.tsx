"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { withBase } from "@/lib/basePath";
import { sessionAlias } from "@/lib/sessionAlias";
import QR from "./QR";
import RegradeBar from "./RegradeBar";
import Modal from "./Modal";
import type { Journey, JourneyStepId, StepStatus } from "@/lib/journeys";

/**
 * The employee-journey runner — the Pandas /j/<journey>/s/<session> station view.
 *
 * A DeNovo associate drives a device through five stations. The runner does NOT
 * re-implement capture or grading: each station hands off to the mobile route
 * that already does that job (a QR the device-under-test scans, the camera page,
 * the report), and the runner polls the session to know when a station is done
 * and auto-advances. That is exactly the Pandas model — a checklist that reflects
 * real state, not a wizard that owns the work.
 */

type Progress = {
  steps: { id: JourneyStepId; label: string; blurb: string; status: StepStatus }[];
  currentId: JourneyStepId;
  session: {
    id: string;
    model: string;
    imei: string;
    clientId: string;
    grades: { cosmetic: string; functional: string; overall: string };
    offer: { offer?: number; currency?: string; blocked?: boolean; flags?: string[]; needsModel?: boolean } | Record<string, never>;
    accepted: boolean;
    photos: number;
    updatedAt: string;
  };
};

const MONEY: Record<string, string> = { USD: "$", INR: "₹", EUR: "€" };
const money = (v?: number, c?: string) =>
  typeof v === "number" ? `${MONEY[c || "USD"] || ""}${Math.round(v).toLocaleString("en-US")}` : "—";

export default function JourneyRunner({ journey, sessionId }: { journey: Journey; sessionId: string }) {
  const [p, setP] = useState<Progress | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [info, setInfo] = useState(false); // station help overlay (square popup, not a full page)
  const origin = typeof window !== "undefined" ? window.location.origin : "";

  const load = useCallback(async () => {
    const r = await fetch(withBase(`/api/journeys/${journey.id}/s/${sessionId}`));
    if (r.ok) setP(await r.json());
  }, [journey.id, sessionId]);

  useEffect(() => {
    load();
  }, [load]);

  // Poll while a device-facing station is in play, so the rail advances the
  // moment the device finishes its part. Stop once the trade-in is recorded.
  const cur = p?.currentId;
  const done = p?.session.accepted;
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (done) return;
    if (cur === "diagnostics" || cur === "cosmetics") {
      pollRef.current = setInterval(load, 4000);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [cur, done, load]);

  async function complete() {
    setBusy(true);
    setMsg("");
    const r = await fetch(withBase(`/api/sessions/${sessionId}/accept`), { method: "POST" });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (d?.verification?.passed) {
      setMsg("Trade-in recorded ✓");
    } else {
      const failed = d?.verification?.checks?.filter((c: { ok: boolean }) => !c.ok).map((c: { label: string }) => c.label) ?? [];
      setMsg(failed.length ? `Can't accept yet: ${failed.join("; ")}` : "Verification gate not passed.");
    }
    load();
  }

  if (!p) {
    return <div className="grid min-h-[60vh] place-items-center text-sm text-[var(--muted)]">Loading journey…</div>;
  }

  const s = p.session;
  const stepUrl = (path: string) => `${origin}${withBase(path)}`;

  return (
    <div className="mx-auto w-full max-w-4xl px-4 pb-16">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 py-4">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-[0.16em] text-[var(--muted)]">
            {journey.label}
          </div>
          <h1 className="text-xl font-extrabold">
            {s.model || "New device"} <span className="mono text-[13px] text-[var(--muted)]" title={s.id}>#{sessionAlias(s.id)}</span>
          </h1>
        </div>
        <a className="pill" href={withBase(`/report/${s.id}`)} target="_blank" rel="noreferrer">
          Open full report ↗
        </a>
      </div>

      {/* Progress rail */}
      <ol className="mb-6 flex flex-wrap gap-2">
        {p.steps.map((st, i) => (
          <li
            key={st.id}
            className="flex items-center gap-2 rounded-full border px-3 py-1.5 text-[12px] font-semibold"
            style={{
              borderColor: st.status === "current" ? "var(--brand)" : "var(--border)",
              background:
                st.status === "done"
                  ? "color-mix(in oklch, var(--green) 16%, transparent)"
                  : st.status === "current"
                    ? "color-mix(in oklch, var(--brand) 12%, transparent)"
                    : "transparent",
              color: st.status === "todo" ? "var(--muted)" : "var(--text)",
            }}
          >
            <span
              className="grid h-5 w-5 place-items-center rounded-full text-[11px]"
              style={{
                background: st.status === "done" ? "var(--green)" : st.status === "current" ? "var(--brand)" : "var(--border)",
                color: st.status === "todo" ? "var(--muted)" : "#fff",
              }}
            >
              {st.status === "done" ? "✓" : i + 1}
            </span>
            {st.label}
          </li>
        ))}
      </ol>

      {/* Current station */}
      <section className="card p-6">
        {(() => {
          const step = p.steps.find((x) => x.id === p.currentId)!;
          return (
            <>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-bold">{step.label}</h2>
                <button
                  className="grid h-6 w-6 place-items-center rounded-full text-[12px] font-bold text-[var(--muted)]"
                  style={{ background: "color-mix(in oklch, var(--brand) 12%, transparent)" }}
                  onClick={() => setInfo(true)}
                  aria-label="What happens at this station"
                >
                  ?
                </button>
              </div>
              <p className="mt-1 text-[13px] text-[var(--muted)]">{step.blurb}</p>

              {/* IDENTIFY */}
              {p.currentId === "identify" && (
                <div className="mt-4">
                  <p className="text-[13px]">
                    No device identified yet. Scan or enter the IMEI to pull the model, carrier lock,
                    blacklist and battery health.
                  </p>
                  <a className="btn mt-3 inline-block" href={withBase(`/enterprise/new`)}>
                    Scan / enter IMEI →
                  </a>
                </div>
              )}

              {/* DIAGNOSTICS + COSMETICS both run inside the ONE guided assessment —
                  the SAME v2 flow buyback uses, so the journey gets buyback's full
                  coverage automatically (photos + display sweep + Settings OCR +
                  battery + functional). The device (or a second phone) opens it
                  bound to THIS session; the rail advances as each result lands. */}
              {(p.currentId === "diagnostics" || p.currentId === "cosmetics") && (
                <Station
                  qr={stepUrl(`/v2?session=${s.id}&client=${s.clientId}`)}
                  qrCaption="Scan on the device being traded (or a second phone) to run the full guided assessment"
                  primaryHref={withBase(`/v2?session=${s.id}&client=${s.clientId}`)}
                  primaryLabel="Open the guided assessment"
                  note={
                    p.currentId === "cosmetics" && s.photos > 0
                      ? `${s.photos} photos captured — grading in progress. The tests and photos run in one flow.`
                      : "One flow covers photos, screen tests, Settings, battery and the functional checks. The rail ticks each station off as its result comes in."
                  }
                />
              )}

              {/* REVIEW — grade + offer + re-grade */}
              {p.currentId === "review" && (
                <div className="mt-4 flex flex-col gap-4">
                  <div className="grid gap-2 sm:grid-cols-4">
                    <Fact label="Cosmetic" value={s.grades.cosmetic || "—"} />
                    <Fact label="Functional" value={s.grades.functional || "—"} />
                    <Fact label="Overall" value={s.grades.overall || "—"} />
                    <Fact
                      label="Offer"
                      value={
                        (s.offer as { blocked?: boolean }).blocked
                          ? "On hold"
                          : money((s.offer as { offer?: number }).offer, (s.offer as { currency?: string }).currency)
                      }
                    />
                  </div>
                  {!!(s.offer as { flags?: string[] }).flags?.length && (
                    <ul className="text-[12px] text-[var(--muted)]">
                      {(s.offer as { flags?: string[] }).flags!.map((f, i) => (
                        <li key={i}>• {f}</li>
                      ))}
                    </ul>
                  )}
                  <RegradeBar
                    sessionId={s.id}
                    overall={s.grades.overall}
                    lastGraded={s.updatedAt}
                    onDone={() => load()}
                  />
                  <button className="btn" onClick={complete} disabled={busy}>
                    {busy ? "Verifying…" : "Accept & record trade-in →"}
                  </button>
                  {msg && <p className="text-[13px] text-[var(--muted)]">{msg}</p>}
                </div>
              )}

              {/* COMPLETE */}
              {p.currentId === "complete" && (
                <div className="mt-4">
                  <div
                    className="rounded-2xl px-5 py-4 text-[14px] font-semibold"
                    style={{ background: "color-mix(in oklch, var(--green) 14%, transparent)", color: "var(--green)" }}
                  >
                    ✓ Trade-in recorded — {s.model} · {s.grades.overall || "—"} ·{" "}
                    {(s.offer as { blocked?: boolean }).blocked
                      ? "on hold"
                      : money((s.offer as { offer?: number }).offer, (s.offer as { currency?: string }).currency)}
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <a className="btn" href={withBase(`/report/${s.id}`)}>Open report</a>
                    <a className="pill" href={withBase(`/api/report/${s.id}/export?format=superiq`)} target="_blank" rel="noreferrer">
                      Export for SuperIQ
                    </a>
                    <a className="pill" href={withBase(`/j/${journey.id}`)}>Start another device</a>
                  </div>
                </div>
              )}
            </>
          );
        })()}
      </section>

      <p className="mt-4 text-center text-[11px] text-[var(--muted)]">
        {journey.label} · {p.steps.filter((x) => x.status === "done").length}/{p.steps.length} stations complete
      </p>

      {/* Station help — a SQUARE overlay, not a full-screen page: the journey
          stays visible behind it so the operator never loses their place. */}
      <Modal open={info} onClose={() => setInfo(false)} title={p.steps.find((x) => x.id === p.currentId)?.label}>
        <p className="text-[13px] text-[var(--muted)]">{STATION_HELP[p.currentId] ?? p.steps.find((x) => x.id === p.currentId)?.blurb}</p>
      </Modal>
    </div>
  );
}

// Plain-language "what happens here / why" for each station — shown in the
// square help overlay, kept out of the always-on UI so the station itself stays
// uncluttered.
const STATION_HELP: Record<string, string> = {
  identify:
    "We read the IMEI to pull the exact model, carrier lock, blacklist status and (where available) battery health. Everything downstream — the right camera angles, the price — depends on knowing what the device actually is.",
  diagnostics:
    "The device runs a set of on-screen checks (touch, cameras, audio, sensors) that only real hardware can pass. These run inside the same guided assessment as the photos, so you scan once.",
  cosmetics:
    "The guided assessment photographs every side, sweeps the screen for dead pixels, films Settings for the IMEI/battery, and grades the condition per component. Take the case off first so nothing is hidden.",
  review:
    "Confirm the grade and the price. If a result looks wrong you can re-grade here — it re-runs the photos and refreshes the price. The offer stays on hold until the device passes the pre-payout checks.",
  complete:
    "Recording runs the pre-payout gate (activation lock off, erased, not blacklisted). Once it passes, the trade-in is booked and you can hand the device back.",
};

function Station({
  qr,
  qrCaption,
  primaryHref,
  primaryLabel,
  note,
}: {
  qr: string;
  qrCaption: string;
  primaryHref: string;
  primaryLabel: string;
  note: string;
}) {
  return (
    <div className="mt-4 flex flex-col items-center gap-3 sm:flex-row sm:items-start">
      <div className="text-center">
        <div className="inline-block rounded-2xl border border-[var(--border)] bg-white p-3">
          <QR text={qr} size={148} />
        </div>
        <p className="mt-2 max-w-[180px] text-[12px] text-[var(--muted)]">{qrCaption}</p>
      </div>
      <div className="flex-1">
        <a className="btn inline-block" href={primaryHref} target="_blank" rel="noreferrer">
          {primaryLabel} ↗
        </a>
        <p className="mt-2 text-[12px] text-[var(--muted)]">{note}</p>
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-[var(--border)] px-3 py-2">
      <div className="text-[10px] font-bold uppercase tracking-wide text-[var(--muted)]">{label}</div>
      <div className="mt-0.5 text-[15px] font-bold">{value}</div>
    </div>
  );
}
