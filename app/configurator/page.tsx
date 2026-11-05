"use client";
import { useEffect, useRef, useState } from "react";
import { withBase } from "@/lib/basePath";

type Msg = { role: "you" | "iq"; text: string };

const SUGGESTIONS = [
  "Set iPhone 14 price to 520",
  "Add a $25 trade-in bonus",
  "Set margin to 12%",
  "Wholesale 3 photos",
  "Skip mic test for wholesale",
];

export default function Configurator() {
  const [msgs, setMsgs] = useState<Msg[]>([
    {
      role: "iq",
      text: "I'm your program configurator. Tell me what to change — pricing, promos, margins, per-channel tests & photos. Try a suggestion below.",
    },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [config, setConfig] = useState<any>(null);
  const endRef = useRef<HTMLDivElement>(null);

  async function loadConfig() {
    const r = await fetch(withBase("/api/configurator"));
    if (r.ok) setConfig(await r.json());
    // Super admin only (SUP-88): say so instead of showing an empty summary.
    else if (r.status === 401 || r.status === 403) {
      const d = await r.json().catch(() => ({}));
      setMsgs((m) => [...m, { role: "iq", text: d.error || "Only a super admin can change the program config." }]);
    }
  }
  useEffect(() => {
    loadConfig();
  }, []);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs]);

  async function send(text: string) {
    if (!text.trim() || busy) return;
    setMsgs((m) => [...m, { role: "you", text }]);
    setInput("");
    setBusy(true);
    try {
      const r = await fetch(withBase("/api/configurator"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      const d = await r.json();
      setMsgs((m) => [...m, { role: "iq", text: r.ok ? d.reply : d.error || "That change was not saved." }]);
      if (d.config) setConfig(d.config);
    } catch {
      setMsgs((m) => [...m, { role: "iq", text: "Something went wrong — try again." }]);
    } finally {
      setBusy(false);
    }
  }

  const p = config?.pricing;
  const segs = config?.segments ?? {};

  return (
    <div className="container">
      <div className="flex items-center justify-between py-3">
        <a href={withBase("/")} className="pill">
          ← GradeIQ
        </a>
        <span className="pill">⚙︎ Configurator</span>
      </div>
      <h1 className="text-2xl font-extrabold">
        Program <span className="grad-text">Configurator</span>
      </h1>
      <p className="mb-3 text-sm text-[var(--muted)]">
        Change your trade-in program by chatting — no code, live instantly.
      </p>

      {/* live config summary */}
      {config && (
        <div className="card mb-3 p-3 text-sm">
          <div className="mb-1 text-xs font-bold uppercase tracking-wide text-[var(--muted)]">
            Current overrides
          </div>
          <div className="flex flex-wrap gap-1.5">
            <span className="pill" style={{ fontSize: 11 }}>
              margin {Math.round((p?.marginRate ?? 0.15) * 100)}%
            </span>
            <span
              className={`pill ${p?.promoBonus ? "chip-green" : ""}`}
              style={{ fontSize: 11 }}
            >
              promo +${p?.promoBonus ?? 0}
            </span>
            {Object.entries(p?.marketBase ?? {}).map(([k, v]) => (
              <span key={k} className="pill" style={{ fontSize: 11 }}>
                {k} ${v as number}
              </span>
            ))}
            {Object.entries(segs).map(([k, v]: any) => (
              <span key={k} className="pill" style={{ fontSize: 11 }}>
                {k}: {v.photoTarget ? `${v.photoTarget}📷 ` : ""}
                {v.mode ?? ""}
                {v.disabledTests?.length ? ` −${v.disabledTests.join(",")}` : ""}
              </span>
            ))}
            {!p?.promoBonus &&
              !Object.keys(p?.marketBase ?? {}).length &&
              !Object.keys(segs).length && (
                <span className="text-[var(--muted)]">using defaults</span>
              )}
          </div>
        </div>
      )}

      {/* chat */}
      <div className="flex flex-col gap-2">
        {msgs.map((m, i) => (
          <div
            key={i}
            className={`max-w-[85%] rounded-2xl px-4 py-2 text-sm ${
              m.role === "you" ? "self-end text-white" : "self-start card"
            }`}
            style={m.role === "you" ? { background: "var(--grad)" } : undefined}
          >
            {m.text}
          </div>
        ))}
        {busy && (
          <div className="card self-start rounded-2xl px-4 py-2 text-sm text-[var(--muted)]">
            …
          </div>
        )}
        <div ref={endRef} />
      </div>

      {/* suggestions */}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            className="pill"
            style={{ fontSize: 11 }}
            onClick={() => send(s)}
            disabled={busy}
          >
            {s}
          </button>
        ))}
      </div>

      {/* input */}
      <div className="sticky bottom-2 mt-3 flex gap-2 bg-[var(--bg)] py-2">
        <input
          className="input"
          placeholder="e.g. set iPhone 15 Pro to 780"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send(input)}
        />
        <button className="btn" onClick={() => send(input)} disabled={busy}>
          Send
        </button>
      </div>
    </div>
  );
}
