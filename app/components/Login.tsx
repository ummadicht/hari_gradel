"use client";
import { useState } from "react";
import { ACCOUNTS, saveAccount } from "@/lib/accounts";
import { SEGMENT_LIST } from "@/lib/profiles";

export default function Login({ onLogin }: { onLogin: () => void }) {
  const [busy, setBusy] = useState("");
  function signIn(id: string) {
    setBusy(id);
    saveAccount(id);
    onLogin();
  }
  const segMeta = Object.fromEntries(SEGMENT_LIST.map((s) => [s.segment, s]));

  return (
    <div className="container">
      <div className="flex flex-col items-center py-8 text-center">
        <div className="brandmark h-16 w-16 text-2xl">IQ</div>
        <h1 className="mt-4 text-2xl font-extrabold">
          Grade<span className="grad-text">IQ</span>
        </h1>
        <p className="text-[var(--muted)]">Sign in to your channel</p>
        <span className="pill mt-2">a SwapMore company</span>
      </div>

      <div className="flex flex-col gap-2">
        {ACCOUNTS.map((a) => {
          const meta = segMeta[a.segment];
          return (
            <button
              key={a.id}
              className="card flex items-center justify-between p-4 text-left"
              onClick={() => signIn(a.id)}
              disabled={!!busy}
            >
              <div>
                <div className="font-semibold">
                  {a.emoji} {a.name}
                </div>
                <div className="text-xs text-[var(--muted)]">
                  {meta?.label} · {meta?.mode === "blitz" ? "⚡ Blitz" : "🎮 Gauntlet"}
                </div>
              </div>
              <span className="btn" style={{ padding: "8px 14px" }}>
                {busy === a.id ? "…" : "Sign in"}
              </span>
            </button>
          );
        })}
      </div>

      <div className="card mt-5 p-4 text-center text-sm text-[var(--muted)]">
        <b className="text-[var(--text)]">🙋 A consumer?</b> Trade-ins start in
        the <b>SwapMore</b> app — it opens a QR straight into GradeIQ. No login
        here.
      </div>
    </div>
  );
}
