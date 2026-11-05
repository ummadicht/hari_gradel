"use client";
import { useEffect, useState } from "react";

// Auto-playing, bold "how it works" animation shown before the consumer starts.
// Crossfades through the 4 steps (inline transitions — no global keyframes).
const STEPS = [
  { emoji: "📷", t: "Scan your IMEI", d: "We identify your exact phone" },
  {
    emoji: "🎮",
    t: "Play quick tests",
    d: "90-second mini-games check touch, screen, mic & cameras",
  },
  { emoji: "📸", t: "Snap a few photos", d: "We check the glass & housing" },
  { emoji: "💸", t: "Get your offer", d: "Instant, transparent price" },
];

export default function Explainer() {
  const [active, setActive] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setActive((a) => (a + 1) % STEPS.length), 2200);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="card overflow-hidden p-4">
      <div className="text-center text-[10px] font-bold uppercase tracking-widest text-[var(--muted)]">
        How it works
      </div>
      <div className="relative mt-1 h-40">
        {STEPS.map((s, i) => (
          <div
            key={i}
            className="absolute inset-0 flex flex-col items-center justify-center px-4 text-center transition-all duration-500"
            style={{
              opacity: i === active ? 1 : 0,
              transform: i === active ? "scale(1)" : "scale(0.88)",
            }}
          >
            <div className="floaty text-6xl">{s.emoji}</div>
            <div className="mt-2 text-lg font-extrabold">{s.t}</div>
            <div className="text-sm text-[var(--muted)]">{s.d}</div>
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-center gap-1.5">
        {STEPS.map((_, i) => (
          <button
            key={i}
            onClick={() => setActive(i)}
            aria-label={`step ${i + 1}`}
            className="h-1.5 rounded-full transition-all"
            style={{
              width: i === active ? 20 : 6,
              background: i === active ? "var(--brand)" : "var(--border)",
            }}
          />
        ))}
      </div>
    </div>
  );
}
