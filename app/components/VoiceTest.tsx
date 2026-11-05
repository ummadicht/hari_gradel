"use client";
import { useEffect, useRef, useState } from "react";

// Natural voice/microphone test: the user says a short phrase out loud and a
// live waveform reacts. If the mic captures clear speech energy → pass. This is
// the "record your voice" check (complements the automatic tone-loopback that
// also proves the speaker). No new permission prompt — the mic was unlocked
// during the one-tap start. Reports a single result when done.

type Res = "pass" | "fail" | "skip";
const PHRASES = ["Hey — my phone works great", "Testing one two three", "GradeIQ, check my microphone"];
const RECORD_MS = 4500;
const SPEECH_RMS = 7; // peak RMS above ambient that indicates real speech

export default function VoiceTest({ onDone }: { onDone: (voice: Res) => void }) {
  const [bars, setBars] = useState<number[]>(Array(28).fill(3));
  const [heard, setHeard] = useState(false);
  const [phrase] = useState(() => PHRASES[Math.floor((Date.now() / 1000) % PHRASES.length)] || PHRASES[0]);
  const acRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number>(0);
  const peakRef = useRef(0);
  const doneRef = useRef(false);

  useEffect(() => {
    let analyser: AnalyserNode | null = null;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamRef.current = stream;
        const ac = new (window.AudioContext || (window as any).webkitAudioContext)();
        acRef.current = ac;
        await ac.resume();
        analyser = ac.createAnalyser();
        analyser.fftSize = 1024;
        ac.createMediaStreamSource(stream).connect(analyser);
      } catch {
        finish("skip"); // no mic access
        return;
      }
      const buf = new Uint8Array(analyser!.fftSize);
      const t0 = performance.now();
      const tick = () => {
        if (!analyser || doneRef.current) return;
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += (v - 128) * (v - 128);
        const rms = Math.sqrt(sum / buf.length);
        peakRef.current = Math.max(peakRef.current, rms);
        if (rms > SPEECH_RMS) setHeard(true);
        setBars((prev) => [...prev.slice(1), Math.min(40, Math.max(3, rms * 1.8))]);
        if (performance.now() - t0 > RECORD_MS) finish(peakRef.current > SPEECH_RMS ? "pass" : "skip");
        else rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    })();
    return () => {
      cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      acRef.current?.close().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function finish(res: Res) {
    if (doneRef.current) return;
    doneRef.current = true;
    cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    acRef.current?.close().catch(() => {});
    onDone(res);
  }

  return (
    <div className="stage items-center justify-center bg-[var(--bg)] p-8 text-center">
      <div className="w-full max-w-sm">
        <div className="text-[13px] font-semibold uppercase tracking-[0.14em] text-[var(--muted)]">Microphone · voice</div>
        <h1 className="mt-2 text-xl font-extrabold">Say this out loud</h1>
        <p className="mt-2 rounded-2xl bg-[var(--card)] px-4 py-3 text-[17px] font-semibold">“{phrase}”</p>

        <div className="mt-6 flex h-24 items-center justify-center gap-1">
          {bars.map((b, i) => (
            <div key={i} className="w-1.5 rounded-full" style={{ height: `${b * 2}px`, background: heard ? "var(--green)" : "var(--brand)", opacity: 0.55 + (b / 40) * 0.45, transition: "height 60ms" }} />
          ))}
        </div>

        <div className="mt-3 text-[14px] font-medium" style={{ color: heard ? "var(--green-ink)" : "var(--muted)" }}>
          {heard ? "✓ Hearing you — mic works" : "Listening… speak now"}
        </div>

        <button onClick={() => finish(peakRef.current > SPEECH_RMS ? "pass" : "skip")} className="mt-5 text-[13px] text-[var(--muted)] underline">
          Skip
        </button>
      </div>
    </div>
  );
}
