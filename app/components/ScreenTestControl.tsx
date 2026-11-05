"use client";
import { useEffect, useRef, useState } from "react";
import { withBase } from "@/lib/basePath";
import { lockOntoScreen, waitForPattern } from "@/lib/screenDetect";
import QR from "./QR";

// The COLLECTOR side, now PHOTO-BASED. The device-under-test scans the QR and
// its screen becomes a remote test panel. The inspector aims their camera at
// that screen and taps ONE button: the app auto-cycles the device through each
// test colour, auto-captures the lit screen for each, and Gemini validates the
// PANEL (dead pixels, driver-IC lines, discoloration, backlight bleed) — no
// manual photographing, no eyeballing.

const CAP: { key: string; label: string; hint: string }[] = [
  { key: "white", label: "White", hint: "dead pixels · discoloration" },
  { key: "red", label: "Red", hint: "colour uniformity" },
  { key: "green", label: "Green", hint: "stuck pixels · lines" },
  { key: "blue", label: "Blue", hint: "colour uniformity" },
  { key: "black", label: "Black", hint: "bright pixels · backlight bleed" },
  { key: "stripes", label: "Stripes", hint: "lines · surface" },
];

type Cap = { pattern: string; photo: string };
type Finding = { pattern: string; type: string; label: string; severity: string };
type Result = {
  verdict: "pass" | "fail" | "unknown";
  note: string;
  source: string;
  findings: Finding[];
  captures: Cap[];
};

export default function ScreenTestControl({
  sessionId,
  nextHref,
}: {
  sessionId: string;
  nextHref: string;
}) {
  const [origin, setOrigin] = useState("");
  const [connected, setConnected] = useState(false);
  const [phase, setPhase] = useState<"wait" | "ready" | "scanning" | "validating" | "done" | "manual">("wait");
  const [current, setCurrent] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [err, setErr] = useState("");
  const [hint, setHint] = useState(""); // live guidance while locking onto the screen
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => setOrigin(window.location.origin), []);

  // Poll for the device checking in.
  useEffect(() => {
    let stop = false;
    const poll = async () => {
      try {
        const r = await fetch(withBase(`/api/sessions/${sessionId}/screen`));
        const d = await r.json();
        if (d.connectedAt) {
          setConnected(true);
          setPhase((p) => (p === "wait" ? "ready" : p));
        }
      } catch {
        /* ignore */
      }
    };
    poll();
    const t = setInterval(() => !stop && poll(), 2000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [sessionId]);

  useEffect(() => () => streamRef.current?.getTracks().forEach((t) => t.stop()), []);

  async function drive(pattern: string) {
    setCurrent(pattern);
    try {
      await fetch(withBase(`/api/sessions/${sessionId}/screen`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pattern }),
      });
    } catch {
      /* ignore */
    }
  }

  function grab(): string | null {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return null;
    const cv = document.createElement("canvas");
    cv.width = Math.min(v.videoWidth, 1280);
    cv.height = Math.round((cv.width / v.videoWidth) * v.videoHeight);
    cv.getContext("2d")?.drawImage(v, 0, 0, cv.width, cv.height);
    return cv.toDataURL("image/jpeg", 0.72);
  }

  // ONE gesture: open the inspector camera, then auto-cycle + capture + validate.
  async function startScan() {
    setErr("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
    } catch {
      setErr("Couldn't open the camera — switching to manual patterns.");
      setPhase("manual");
      return;
    }
    setPhase("scanning");
    const captures: Cap[] = [];

    // Wait until the camera can actually SEE the lit screen, then lock onto it.
    // This replaced a bare 1300ms timer per pattern, which captured whatever was
    // in frame — often nothing — and handed the grader photos of a screen it had
    // never seen. Locking also gives the inspector time to aim.
    await drive("white");
    const lock = await lockOntoScreen(() => videoRef.current, 20000, setHint);
    if (!lock) {
      setHint("");
      await drive("idle");
      streamRef.current?.getTracks().forEach((t) => t.stop());
      setErr("Couldn't see the screen — aim at the lit display and try again.");
      setPhase("manual");
      return;
    }

    for (const p of CAP) {
      setHint(`Showing ${p.key} — hold steady`);
      await drive(p.key);
      // Only capture once the locked region really shows this pattern; skip it
      // otherwise rather than banking a frame that doesn't show it.
      if (await waitForPattern(() => videoRef.current, lock, p.key, 4000)) {
        const shot = grab();
        if (shot) captures.push({ pattern: p.key, photo: shot });
      }
    }
    setHint("");
    await drive("idle");
    streamRef.current?.getTracks().forEach((t) => t.stop());
    setPhase("validating");
    try {
      const r = await fetch(withBase(`/api/sessions/${sessionId}/display`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ captures }),
      });
      const d = await r.json();
      setResult(d.display);
    } catch {
      setResult(null);
    }
    setPhase("done");
  }

  const url = origin ? `${origin}${withBase(`/screen/${sessionId}`)}` : "";

  return (
    <div className="mx-auto w-full max-w-lg px-4 pb-10">
      <div className="py-6 text-center">
        <div className="brandmark mx-auto h-14 w-14 text-xl">IQ</div>
        <h1 className="mt-3 text-2xl font-extrabold">Screen test</h1>
        <p className="text-sm text-[var(--muted)]">
          Scan this with the device being graded — its screen becomes a test
          panel. Aim your camera at it and GradeIQ captures &amp; validates it
          automatically.
        </p>
      </div>

      {phase === "wait" && (
        <div className="card p-6 text-center">
          <div className="flex justify-center">{url && <QR text={url} size={200} />}</div>
          <div className="mt-4 inline-flex items-center gap-2 rounded-full bg-[var(--bg-soft)] px-3 py-1.5 text-sm text-[var(--muted)]">
            <span className="h-2 w-2 animate-pulse rounded-full bg-[var(--muted)]" />
            Waiting for the device to connect…
          </div>
        </div>
      )}

      {phase === "ready" && (
        <div className="card p-5 text-center">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium" style={{ color: "var(--green-ink)", background: "color-mix(in oklch, var(--green) 14%, transparent)" }}>
            <span className="h-2 w-2 rounded-full bg-[var(--green-ink)]" />
            Device connected
          </div>
          <p className="mb-4 text-sm text-[var(--muted)]">
            Hold your camera steady facing the device&apos;s screen. GradeIQ will
            flash each test colour and photograph it — about 8 seconds.
          </p>
          <button className="btn w-full" onClick={startScan}>
            Start screen scan
          </button>
          {err && <p className="mt-3 text-sm text-[var(--bad)]">{err}</p>}
          <button onClick={() => setPhase("manual")} className="mt-3 block w-full text-[13px] text-[var(--muted)] underline">
            Do it manually instead
          </button>
        </div>
      )}

      {(phase === "scanning" || phase === "validating") && (
        <div className="card overflow-hidden p-0">
          <div className="relative bg-black" style={{ aspectRatio: "3/4" }}>
            <video ref={videoRef} playsInline muted className="h-full w-full object-cover" />
            <div className="pointer-events-none absolute inset-0 grid place-items-center">
              <div className="rounded-2xl border-2 border-white/70" style={{ width: "70%", height: "60%" }} />
            </div>
            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-4 text-center text-white">
              {phase === "validating" ? (
                <div className="text-sm font-semibold">Validating display…</div>
              ) : (
                <>
                  <div className="text-sm font-semibold">
                    {hint || `Capturing ${current || "…"} · hold steady`}
                  </div>
                  <div className="mt-2 flex justify-center gap-1.5">
                    {CAP.map((p) => (
                      <span
                        key={p.key}
                        className="h-1.5 w-6 rounded-full"
                        style={{
                          background:
                            CAP.findIndex((x) => x.key === current) >= CAP.findIndex((x) => x.key === p.key)
                              ? "var(--brand)"
                              : "rgba(255,255,255,0.35)",
                        }}
                      />
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {phase === "done" && (
        <div className="card p-5">
          {result ? (
            <>
              <div
                className="mb-3 inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-semibold"
                style={
                  result.verdict === "pass"
                    ? { color: "var(--green-ink)", background: "color-mix(in oklch, var(--green) 14%, transparent)" }
                    : result.verdict === "fail"
                      ? { color: "var(--bad)", background: "color-mix(in oklch, var(--bad) 12%, transparent)" }
                      : { color: "var(--gold-2)", background: "color-mix(in oklch, var(--gold) 12%, transparent)" }
                }
              >
                {result.verdict === "pass" ? "✓ Display OK" : result.verdict === "fail" ? "✕ Display defects found" : "– Couldn't auto-validate"}
              </div>
              <p className="text-sm text-[var(--muted)]">{result.note}</p>
              {result.findings?.length > 0 && (
                <ul className="mt-2 space-y-1 text-[13px]">
                  {result.findings.map((f, i) => (
                    <li key={i} style={{ color: "var(--bad)" }}>
                      • {f.label} <span className="text-[var(--muted)]">({f.pattern})</span>
                    </li>
                  ))}
                </ul>
              )}
              {result.captures?.length > 0 && (
                <div className="mt-3 flex gap-1.5 overflow-x-auto">
                  {result.captures.map((c, i) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      key={i}
                      src={withBase(c.photo)}
                      alt={c.pattern}
                      className="h-16 w-16 shrink-0 rounded-lg object-cover"
                    />
                  ))}
                </div>
              )}
            </>
          ) : (
            <p className="text-sm text-[var(--muted)]">
              Couldn&apos;t validate the display — try again or check manually.
            </p>
          )}
          <button
            onClick={() => {
              setResult(null);
              setPhase("ready");
            }}
            className="mt-4 block w-full text-[13px] text-[var(--muted)] underline"
          >
            Rescan
          </button>
        </div>
      )}

      {phase === "manual" && (
        <div className="card p-5">
          <p className="mb-3 text-sm text-[var(--muted)]">
            Tap a pattern — the device switches instantly. Photograph its screen.
          </p>
          <div className="grid grid-cols-3 gap-2">
            {CAP.map((p) => (
              <button
                key={p.key}
                onClick={() => drive(p.key)}
                className="rounded-xl border p-3 text-center"
                style={{
                  borderColor: current === p.key ? "var(--brand)" : "var(--border)",
                  background: current === p.key ? "color-mix(in oklch, var(--brand) 10%, transparent)" : "var(--card)",
                }}
              >
                <div className="text-sm font-semibold">{p.label}</div>
              </button>
            ))}
          </div>
          {current && current !== "idle" && (
            <p className="mt-3 text-center text-[13px] text-[var(--muted)]">
              Showing <b>{current}</b> — {CAP.find((x) => x.key === current)?.hint}
            </p>
          )}
          <button onClick={() => drive("idle")} className="mt-2 block w-full text-center text-[13px] text-[var(--muted)] underline">
            Blank the screen
          </button>
        </div>
      )}

      <a className="btn mt-5 w-full" href={withBase(nextHref)}>
        {connected ? "Done — continue →" : "Skip screen test →"}
      </a>
    </div>
  );
}

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
