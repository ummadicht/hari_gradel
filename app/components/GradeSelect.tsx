"use client";
import { useState } from "react";
import { withBase } from "@/lib/basePath";

const TIERS: { grade: string; desc: string }[] = [
  { grade: "Premium", desc: "Like-new — no visible wear" },
  { grade: "A", desc: "Excellent — very light wear" },
  { grade: "B", desc: "Good — visible wear" },
  { grade: "C", desc: "Fair — heavy wear" },
  { grade: "D", desc: "Damaged / parts" },
];

// Manual cosmetic grade picker — the fallback when the camera/AI isn't used.
export default function GradeSelect({
  sessionId,
  onDone,
}: {
  sessionId: string;
  onDone?: () => void;
}) {
  const [busy, setBusy] = useState("");
  // Why a pick was refused, in the server's words. Once the photos or the store
  // have graded the phone a pick without a staff sign-in is refused (409); a
  // silent reset left the seller tapping a button that did nothing.
  const [err, setErr] = useState("");

  async function pick(grade: string) {
    setBusy(grade);
    setErr("");
    const r = await fetch(withBase(`/api/sessions/${sessionId}/grade-manual`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grade }),
    }).catch(() => null);
    if (r?.ok) {
      if (onDone) onDone();
      else window.location.href = withBase(`/report/${sessionId}`);
    } else {
      const d = r ? await r.json().catch(() => ({})) : {};
      setErr(typeof d?.error === "string" ? d.error : "Couldn't save the grade — try again.");
      setBusy("");
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {err && (
        <p role="alert" className="text-sm" style={{ color: "var(--bad)" }}>
          {err}
        </p>
      )}
      {TIERS.map((t) => (
        <button
          key={t.grade}
          className="card flex items-center gap-3 p-3 text-left"
          onClick={() => pick(t.grade)}
          disabled={!!busy}
        >
          <span
            className="grid h-10 w-10 shrink-0 place-items-center rounded-xl font-black text-white"
            style={{ background: "var(--grad)" }}
          >
            {t.grade === "Premium" ? "P" : t.grade}
          </span>
          <span>
            <span className="block font-bold">
              {t.grade === "Premium" ? "Premium" : `Grade ${t.grade}`}
            </span>
            <span className="text-xs text-[var(--muted)]">{t.desc}</span>
          </span>
          {busy === t.grade && (
            <span className="ml-auto text-sm text-[var(--muted)]">…</span>
          )}
        </button>
      ))}
    </div>
  );
}
