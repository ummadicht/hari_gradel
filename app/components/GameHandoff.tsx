"use client";
import { useEffect, useState } from "react";
import { withBase } from "@/lib/basePath";
import QR from "./QR";

// Inspector-device screen: shows the QR the phone-being-graded scans to run the
// functional game, and polls the session so it advances the moment that phone
// finishes — no manual refresh. (A phone can't photograph itself, so the game
// runs on the device under test while photos/offer stay here.)
export default function GameHandoff({ sessionId }: { sessionId: string }) {
  const [origin, setOrigin] = useState("");
  const [done, setDone] = useState(false);
  const [summary, setSummary] = useState<{ pass: number; fail: number } | null>(
    null
  );

  useEffect(() => setOrigin(window.location.origin), []);
  useEffect(() => {
    let stop = false;
    const poll = async () => {
      try {
        const r = await fetch(withBase(`/api/sessions/${sessionId}`));
        if (!r.ok) return;
        const s = await r.json();
        if (s.functional_grade) {
          const f = s.functional || {};
          setSummary({
            pass: Object.values(f).filter((v: any) => v === "pass").length,
            fail: Object.values(f).filter((v: any) => v === "fail").length,
          });
          setDone(true);
          stop = true;
        }
      } catch {
        /* ignore */
      }
    };
    poll();
    const t = setInterval(() => !stop && poll(), 3000);
    return () => clearInterval(t);
  }, [sessionId]);

  const gameUrl = origin ? `${origin}${withBase(`/s/${sessionId}`)}` : "";

  return (
    <div className="container text-center">
      <div className="py-6">
        <div className="brandmark mx-auto h-14 w-14 text-xl">IQ</div>
        <h1 className="mt-3 text-2xl font-extrabold">Hand the phone its test</h1>
        <p className="text-sm text-[var(--muted)]">
          On the phone you&apos;re grading, scan this QR to run the 90-second
          self-test. Results appear here automatically.
        </p>
      </div>

      {!done ? (
        <div className="card p-6">
          <div className="flex justify-center">
            {gameUrl && <QR text={gameUrl} size={200} />}
          </div>
          <p className="mono mt-3 break-all text-xs text-[var(--brand-2)]">
            {gameUrl}
          </p>
          <div className="mt-4 flex items-center justify-center gap-2 text-sm text-[var(--muted)]">
            <span className="animate-pulse text-[var(--green)]">●</span>
            Waiting for the phone to finish testing…
          </div>
        </div>
      ) : (
        <div className="card p-6">
          <div className="text-5xl">✅</div>
          <h2 className="mt-2 text-xl font-extrabold">Tests complete</h2>
          <p className="text-sm text-[var(--muted)]">
            {summary?.pass} passed · {summary?.fail} failed
          </p>
          <a className="btn mt-4 w-full" href={withBase(`/report/${sessionId}`)}>
            See offer →
          </a>
        </div>
      )}

      <a
        className="mt-3 block text-center text-sm text-[var(--muted)] underline"
        href={withBase(`/report/${sessionId}`)}
      >
        Skip to offer →
      </a>
    </div>
  );
}
