"use client";
import { useState } from "react";
import { withBase } from "@/lib/basePath";
import GradeBadge from "./GradeBadge";

type Row = {
  id: string;
  model: string;
  imei: string;
  overall_grade: string;
  status: string;
  updated_at: string;
};

export default function DeskTester({ recent }: { recent: Row[] }) {
  const [starting, setStarting] = useState(false);
  const [pushMsg, setPushMsg] = useState<Record<string, string>>({});

  async function pushToSuperIQ(id: string) {
    setPushMsg((m) => ({ ...m, [id]: "…" }));
    try {
      const r = await fetch(withBase(`/api/report/${id}/push-superiq`), {
        method: "POST",
      });
      const d = await r.json();
      setPushMsg((m) => ({
        ...m,
        [id]: r.ok ? "✓ sent" : d.error || "failed",
      }));
    } catch {
      setPushMsg((m) => ({ ...m, [id]: "network error" }));
    }
  }

  function startTest() {
    // Scan the IMEI first (identifies the model → right lenses/angles/tests),
    // then the enterprise session is created and photos begin.
    setStarting(true);
    window.location.href = withBase("/enterprise/new");
  }

  async function logout() {
    await fetch(withBase("/api/enterprise/logout"), { method: "POST" });
    window.location.href = withBase("/enterprise");
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-4 pb-10">
      <div className="flex items-center justify-between py-4">
        <div>
          <h1 className="text-xl font-extrabold">
            Grade<span className="grad-text">IQ</span> Enterprise
          </h1>
          <p className="text-xs text-[var(--muted)]">
            Diagnostics console · functional + cosmetic grading, not trade-in
          </p>
        </div>
        <button onClick={logout} className="pill">
          Sign out
        </button>
      </div>

      <button
        className="btn w-full text-lg"
        onClick={startTest}
        disabled={starting}
      >
        {starting ? "Starting…" : "＋ New device diagnostic"}
      </button>
      <p className="mt-2 text-center text-xs text-[var(--muted)]">
        Scan IMEI &amp; photograph on this tester → hand the phone its
        diagnostics via QR → full functional + cosmetic report, battery health &amp;
        solution plan sync back here.
      </p>

      <h2 className="mt-8 mb-2 text-sm font-semibold uppercase tracking-wider text-[var(--muted)]">
        Recent devices
      </h2>
      <div className="card overflow-hidden p-0">
        {recent.length === 0 ? (
          <p className="p-5 text-sm text-[var(--muted)]">No devices yet.</p>
        ) : (
          <div className="divide-y divide-[var(--border)]">
            {recent.map((r) => (
              <div key={r.id} className="flex items-center gap-3 p-3">
                <GradeBadge grade={r.overall_grade || ""} small />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">
                    {r.model || "Unknown model"}
                  </div>
                  <div className="mono truncate text-[11px] text-[var(--muted)]">
                    #{r.id} · {r.imei || "no IMEI"} · {r.status}
                  </div>
                </div>
                <a
                  href={withBase(`/report/${r.id}`)}
                  className="pill"
                  style={{ fontSize: 11 }}
                >
                  Report
                </a>
                <a
                  href={withBase(`/api/report/${r.id}/export`)}
                  className="pill"
                  style={{ fontSize: 11 }}
                  target="_blank"
                  rel="noreferrer"
                >
                  Export
                </a>
                <button
                  onClick={() => pushToSuperIQ(r.id)}
                  className="pill"
                  style={{ fontSize: 11 }}
                  title="Push diagnostics to SuperIQ"
                >
                  {pushMsg[r.id] || "→ SuperIQ"}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
