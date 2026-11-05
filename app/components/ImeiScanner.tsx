"use client";
import { useEffect, useRef, useState } from "react";
import { withBase } from "@/lib/basePath";
import { BrowserMultiFormatReader, IScannerControls } from "@zxing/browser";
import { DecodeHintType, BarcodeFormat } from "@zxing/library";
import { luhnValid } from "@/lib/luhn";

// Pull a trustworthy IMEI out of a decoded barcode payload. Screen barcodes
// flicker (moiré/refresh), so a garbled partial decode can still yield 15 loose
// digits — accepting those means shipping a WRONG IMEI. So we prefer a
// Luhn-valid 15-digit window; only if the payload is a single clean 15-digit
// run (ZXing's own Code128/EAN checksum already passed) do we trust it as-is.
function extractImei(text: string): string | null {
  const digits = text.replace(/\D/g, "");
  for (let i = 0; i + 15 <= digits.length; i++) {
    const w = digits.slice(i, i + 15);
    if (luhnValid(w)) return w;
  }
  return digits.length === 15 ? digits : null;
}

// IMEI capture with a refurbIQ-style scanner: ZXing continuous decode (works on
// iOS Safari too, unlike BarcodeDetector), an aim reticle + red laser marker,
// torch, and beep/vibrate feedback. Plus an AI OCR button for the *#06# screen.
export default function ImeiScanner({
  onResult,
  onClose,
}: {
  onResult: (imei: string) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const readerRef = useRef<BrowserMultiFormatReader | null>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const audioRef = useRef<AudioContext | null>(null);
  const doneRef = useRef(false);

  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [hit, setHit] = useState(false);
  const [code, setCode] = useState("");
  const [torchOn, setTorchOn] = useState(false);
  const [torchOk, setTorchOk] = useState(false);
  const [reading, setReading] = useState(false);

  useEffect(() => {
    const hints = new Map();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [
      BarcodeFormat.CODE_128,
      BarcodeFormat.QR_CODE,
      BarcodeFormat.CODE_39,
      BarcodeFormat.EAN_13,
      BarcodeFormat.ITF,
      BarcodeFormat.DATA_MATRIX,
    ]);
    // TRY_HARDER: spend more effort per frame — the single biggest win for
    // low-contrast / flickering on-screen barcodes (vs crisp printed labels).
    hints.set(DecodeHintType.TRY_HARDER, true);
    // Tight cadence = scanner-gun feel.
    readerRef.current = new BrowserMultiFormatReader(hints, {
      delayBetweenScanAttempts: 70,
      delayBetweenScanSuccess: 350,
    });
    start();
    return () => stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function beep(ok: boolean) {
    try {
      const ctx = (audioRef.current =
        audioRef.current ??
        new (window.AudioContext || (window as any).webkitAudioContext)());
      ctx.resume?.();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = ok ? 1040 : 320;
      o.connect(g);
      g.connect(ctx.destination);
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.12);
      o.start();
      o.stop(ctx.currentTime + 0.12);
    } catch {
      /* audio blocked */
    }
  }

  function accept(imei: string) {
    if (doneRef.current) return;
    doneRef.current = true;
    setCode(imei); // show it instantly
    setHit(true);
    beep(true);
    navigator.vibrate?.(45);
    setTimeout(() => onResult(imei), 500);
  }

  async function start() {
    if (!readerRef.current || !videoRef.current) return;
    setError("");
    try {
      // Robust, widely-supported constraints only — an unsupported `advanced`
      // focusMode makes some phones reject getUserMedia entirely (→ no scan).
      controlsRef.current = await readerRef.current.decodeFromConstraints(
        {
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        },
        videoRef.current,
        (res) => {
          if (!res) return;
          const imei = extractImei(res.getText());
          if (imei) accept(imei);
        }
      );
      setScanning(true);
      const track = (videoRef.current.srcObject as MediaStream | null)?.getVideoTracks?.()[0];
      const caps: any = track?.getCapabilities?.();
      setTorchOk(!!caps && "torch" in caps);
    } catch {
      // Fallback: plain video (some phones reject facingMode/resolution hints).
      try {
        controlsRef.current = await readerRef.current.decodeFromConstraints(
          { video: true },
          videoRef.current,
          (res) => {
            if (!res) return;
            const imei = extractImei(res.getText());
            if (imei) accept(imei);
          }
        );
        setScanning(true);
      } catch {
        setError(
          "Couldn't start the camera. Allow camera access — it only runs on HTTPS or localhost. You can still tap Read to OCR the *#06# screen."
        );
      }
    }
  }

  function stop() {
    try {
      controlsRef.current?.stop();
    } catch {
      /* noop */
    }
    controlsRef.current = null;
  }

  async function toggleTorch() {
    const track = (videoRef.current?.srcObject as MediaStream | null)?.getVideoTracks?.()[0];
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: !torchOn } as any] });
      setTorchOn((t) => !t);
    } catch {
      /* torch unsupported */
    }
  }

  // Capture the current frame and OCR the IMEI text (Gemini) — for *#06# screens
  // that show only text, no barcode.
  async function readScreen() {
    const v = videoRef.current;
    if (!v) return;
    setReading(true);
    setMsg("");
    beep(true); // also unlocks audio on iOS (user gesture)
    const canvas = document.createElement("canvas");
    canvas.width = v.videoWidth || 1080;
    canvas.height = v.videoHeight || 1440;
    canvas.getContext("2d")?.drawImage(v, 0, 0, canvas.width, canvas.height);
    const photo = canvas.toDataURL("image/jpeg", 0.85);
    try {
      const r = await fetch(withBase("/api/imei/ocr"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ photo }),
      });
      const { imei } = await r.json();
      const clean = imei ? extractImei(String(imei)) : null;
      if (clean) accept(clean);
      else setMsg("Couldn't read an IMEI — fill the frame with the *#06# screen.");
    } catch {
      setMsg("Read failed. Try again.");
    } finally {
      setReading(false);
    }
  }

  return (
    <div className="stage items-center justify-center p-4 text-center">
      <div
        className="relative w-full max-w-sm overflow-hidden rounded-2xl border border-[var(--border)] bg-black"
        style={{ aspectRatio: "3/4" }}
      >
        <video
          ref={videoRef}
          playsInline
          muted
          className="h-full w-full object-cover"
        />

        {/* aim reticle + laser marker */}
        {scanning && (
          <>
            <div
              className="pointer-events-none absolute left-1/2 top-1/2 h-[34%] w-[78%] -translate-x-1/2 -translate-y-1/2 rounded-xl border-2 transition-colors"
              style={{ borderColor: hit ? "var(--green)" : "rgba(255,255,255,0.75)" }}
            >
              <div
                className="absolute inset-x-0 top-1/2 h-0.5"
                style={{ background: "rgba(239,68,68,0.85)", boxShadow: "0 0 10px rgba(239,68,68,0.9)" }}
              />
            </div>
            {torchOk && (
              <button
                onClick={toggleTorch}
                className="absolute right-3 top-3 grid h-10 w-10 place-items-center rounded-full text-lg"
                style={{ background: torchOn ? "var(--gold)" : "rgba(0,0,0,0.5)", color: torchOn ? "#000" : "#fff" }}
              >
                🔦
              </button>
            )}
          </>
        )}

        {hit && (
          <>
            {/* full green flash for instant feedback */}
            <div className="pointer-events-none absolute inset-0 animate-pulse" style={{ background: "color-mix(in oklch, var(--green) 30%, transparent)" }} />
            <div className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full px-4 py-2 text-center text-white" style={{ background: "var(--green)" }}>
              <div className="text-sm font-bold">✓ IMEI scanned</div>
              {code && <div className="mono text-[13px]">{code}</div>}
            </div>
          </>
        )}
      </div>

      <p className="mt-3 text-sm text-[var(--muted)]">
        Line the barcode up in the box, or fill it with the phone&apos;s
        <span className="mono"> *#06# </span> screen and tap Read.
      </p>
      {error && <p className="mt-2 px-4 text-sm text-[var(--bad)]">{error}</p>}
      {msg && <p className="mt-2 text-sm text-[var(--warn)]">{msg}</p>}

      <div className="mt-4 flex gap-2">
        <button className="btn" onClick={readScreen} disabled={reading}>
          {reading ? "Reading…" : "📸 Read *#06#"}
        </button>
        <button className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
