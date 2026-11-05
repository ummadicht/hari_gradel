"use client";
import { useEffect, useRef, useState } from "react";
import { withBase } from "@/lib/basePath";
import GradeBadge from "./GradeBadge";
import { anglesFor } from "@/lib/angles";
import { PoseIcon, poseFor, frameForPose } from "./AngleGuide";
import GradeSelect from "./GradeSelect";
import VisionCascade from "./VisionCascade";

// ── Live frame-quality assessment (blur / focus / lighting) ──────────────────
const SHARP_MIN = 65; // Laplacian variance — below = out of focus / blurry
const DARK = 45;
const BRIGHT = 228;
const CONTRAST_MIN = 13; // std-dev of luminance — low = washed-out / faded

type Quality = { ok: boolean; reason: string; level: "good" | "warn" | "bad" };

function assess(video: HTMLVideoElement): Quality {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return { ok: false, reason: "Starting camera…", level: "bad" };
  const cw = Math.round(vw * 0.6);
  const ch = Math.round(vh * 0.6);
  const S = 180;
  const sh = Math.round((S * ch) / cw);
  const c = document.createElement("canvas");
  c.width = S;
  c.height = sh;
  const ctx = c.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | null;
  if (!ctx) return { ok: true, reason: "", level: "good" };
  ctx.drawImage(video, (vw - cw) / 2, (vh - ch) / 2, cw, ch, 0, 0, S, sh);
  const { data } = ctx.getImageData(0, 0, S, sh);

  const n = S * sh;
  const g = new Float32Array(n);
  let sum = 0;
  for (let i = 0, j = 0; j < n; i += 4, j++) {
    const v = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    g[j] = v;
    sum += v;
  }
  const mean = sum / n;
  let varSum = 0;
  for (let j = 0; j < n; j++) {
    const d = g[j] - mean;
    varSum += d * d;
  }
  const contrast = Math.sqrt(varSum / n);
  let lSum = 0;
  let lSum2 = 0;
  let m = 0;
  for (let y = 1; y < sh - 1; y++) {
    for (let x = 1; x < S - 1; x++) {
      const i = y * S + x;
      const lap = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - S] - g[i + S];
      lSum += lap;
      lSum2 += lap * lap;
      m++;
    }
  }
  const sharp = lSum2 / m - (lSum / m) ** 2;

  if (mean < DARK) return { ok: false, reason: "Too dark — find better light", level: "bad" };
  if (mean > BRIGHT) return { ok: false, reason: "Glare — tilt away from the light", level: "bad" };
  if (contrast < CONTRAST_MIN) return { ok: false, reason: "Fill the box with the phone", level: "warn" };
  if (sharp < SHARP_MIN) return { ok: false, reason: "Hold steady — let it focus", level: "warn" };
  return { ok: true, reason: "Sharp — capture it", level: "good" };
}

// ── Phone-only crop ─────────────────────────────────────────────────────────
type Crop = { sx: number; sy: number; sw: number; sh: number };
function cropRect(v: HTMLVideoElement, pose: string): Crop {
  const vw = v.videoWidth || 1280;
  const vh = v.videoHeight || 960;
  const wFrac = pose === "left" || pose === "right" ? 0.36 : 0.56;
  const hFrac = 0.9;
  const sw = Math.round(vw * wFrac);
  const sh = Math.round(vh * hFrac);
  return { sx: Math.round((vw - sw) / 2), sy: Math.round((vh - sh) / 2), sw, sh };
}

function shortLabel(a: string): string {
  return a
    .replace(/\s*—.*$/, " camera")
    .replace(/\(.*?\)/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export default function CosmeticCapture({
  sessionId,
  model = "",
  photoTarget = 6,
  screenOffFirst = false,
  nextHref,
}: {
  sessionId: string;
  model?: string;
  photoTarget?: number;
  screenOffFirst?: boolean;
  nextHref?: string;
  manualFirst?: boolean;
  verifyEachAngle?: boolean;
}) {
  const next = nextHref ?? `/report/${sessionId}`;
  const toTest = /handoff/.test(next);
  const nextLabel = toTest ? "Next: hand it the test →" : "See offer →";
  const target = Math.max(2, Math.min(photoTarget, 12));
  const core = anglesFor(model).slice(0, target);
  const ANGLES =
    screenOffFirst && core.length
      ? [
          "Front — screen OFF",
          "Screen ON — white (dead-pixel check)",
          "Screen ON — gray (LCD line check)",
          ...core.slice(1),
        ]
      : core;

  const videoRef = useRef<HTMLVideoElement>(null);
  const [shots, setShots] = useState<(string | null)[]>(() => ANGLES.map(() => null));
  const [extras, setExtras] = useState<string[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [extraMode, setExtraMode] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [gradeErr, setGradeErr] = useState("");
  const [result, setResult] = useState<any>(null);
  const [manual, setManual] = useState(false);
  const [quality, setQuality] = useState<Quality>({ ok: false, reason: "Starting camera…", level: "bad" });
  const [reject, setReject] = useState("");
  const [flash, setFlash] = useState(false);
  const activeRef = useRef(0);
  activeRef.current = activeIdx;

  const allDone = shots.every(Boolean);
  const doneCount = shots.filter(Boolean).length;
  const activeAngle = extraMode ? "Extra close-up" : ANGLES[activeIdx] ?? "Front / screen";

  // Drive the linked device's screen to the pattern this angle needs.
  useEffect(() => {
    if (result) return;
    let pattern = "black";
    if (/screen off/i.test(activeAngle)) pattern = "black";
    else if (/stripe/i.test(activeAngle)) pattern = "stripes";
    // Gray must be tested BEFORE white — "Screen ON — gray" also matches /screen on/.
    else if (/gray|grey|lcd line/i.test(activeAngle)) pattern = "gray";
    else if (/screen on|bright|white|dead-pixel/i.test(activeAngle)) pattern = "white";
    fetch(withBase(`/api/sessions/${sessionId}/screen`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pattern }),
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIdx, allDone, result, extraMode]);

  // Camera setup.
  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | null = null;
    (async () => {
      try {
        let s: MediaStream;
        try {
          s = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 960 } },
          });
        } catch {
          s = await navigator.mediaDevices.getUserMedia({ video: true });
        }
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        if (videoRef.current) {
          videoRef.current.srcObject = s;
          videoRef.current.setAttribute("playsinline", "true");
          await videoRef.current.play().catch(() => {});
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : "camera blocked");
      }
    })();
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // Live quality coaching only — NO auto-capture.
  useEffect(() => {
    if (err || result) return;
    const t = setInterval(() => {
      const v = videoRef.current;
      if (!v || v.readyState < 2) return;
      setQuality(assess(v));
    }, 180);
    return () => clearInterval(t);
  }, [err, result]);

  function grabFrame(): string | null {
    const v = videoRef.current;
    if (!v) return null;
    const pose = poseFor(activeAngle);
    const crop = cropRect(v, pose);
    const scale = Math.min(1, 1024 / Math.max(crop.sw, crop.sh));
    const w = Math.round(crop.sw * scale);
    const h = Math.round(crop.sh * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(v, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, w, h);
    return canvas.toDataURL("image/jpeg", 0.72);
  }

  // Manual capture — auto-VALIDATES focus/light/framing before it counts.
  function capture(force = false) {
    const v = videoRef.current;
    if (!v || err) return;
    if (!force) {
      const q = assess(v);
      if (!q.ok) {
        setReject(q.reason);
        return;
      }
    }
    const url = grabFrame();
    if (!url) return;
    setFlash(true);
    setTimeout(() => setFlash(false), 300);
    setReject("");
    if (extraMode) {
      setExtras((e) => [...e, url]);
      return;
    }
    const idx = activeRef.current;
    setShots((prev) => {
      const nextShots = [...prev];
      nextShots[idx] = url;
      const nextEmpty = nextShots.findIndex((x) => !x);
      setActiveIdx(nextEmpty === -1 ? idx : nextEmpty);
      return nextShots;
    });
  }

  const allPhotos = () => [...shots.filter((s): s is string => !!s), ...extras];

  async function postGrade(): Promise<any | null> {
    const r = await fetch(withBase(`/api/sessions/${sessionId}/cosmetic`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photos: allPhotos() }),
    });
    if (!r.ok) throw new Error(String(r.status));
    return (await r.json()).cosmetic;
  }

  async function grade() {
    setBusy(true);
    setGradeErr("");
    try {
      setResult(await postGrade());
    } catch (e) {
      setGradeErr(`Grading failed (${e instanceof Error ? e.message : "network"}). Check your connection and tap again.`);
    } finally {
      setBusy(false);
    }
  }

  if (busy && !result && !gradeErr) {
    return (
      <div className="container text-center">
        <div className="card mt-10 p-8">
          <div className="text-4xl floaty">🤖</div>
          <p className="mt-3 text-lg font-bold">Analyzing device…</p>
          <p className="mt-1 text-sm text-[var(--muted)]">Checking each side, every lens &amp; the finish.</p>
          <div className="mx-auto mt-4 h-1.5 w-40 overflow-hidden rounded-full bg-[var(--card-2)]">
            <div className="h-full w-1/2 animate-pulse rounded-full" style={{ background: "var(--grad)" }} />
          </div>
        </div>
      </div>
    );
  }

  const conclusive = result && result.conclusive;
  const borderline = result && !result.conclusive && result.gradeRange;
  const gathering = result && !result.conclusive && !result.gradeRange;

  if (conclusive) {
    return (
      <div className="mx-auto w-full max-w-5xl px-4 pb-8">
        <div className="card mt-6 p-6 text-center">
          <p className="text-sm text-[var(--muted)]">Cosmetic grade</p>
          <div className="my-4 flex justify-center">
            <GradeBadge grade={result.grade} />
          </div>
          <p className="text-sm text-[var(--muted)]">
            confidence {Math.round((result.confidence ?? 0) * 100)}% ·{" "}
            {result.source === "gemini" ? "GradeIQ inspection" : "preview (not inspected)"}
          </p>
          <p className="mt-2 text-sm text-[var(--muted)]">{result.notes}</p>
        </div>
        {result.specialists?.length > 0 ? (
          <VisionCascade photos={allPhotos()} cascade={result} model={model} />
        ) : (
          result.defects?.length > 0 && (
            <ul className="card mt-4 p-4 text-sm">
              {result.defects.map((d: string, i: number) => (
                <li key={i} className="text-[var(--warn)]">• {d}</li>
              ))}
            </ul>
          )
        )}
        <a className="btn mt-5 w-full" href={withBase(next)}>{nextLabel}</a>
      </div>
    );
  }

  if (borderline) {
    return (
      <div className="container text-center">
        <div className="card mt-8 p-6">
          <p className="text-sm text-[var(--muted)]">Couldn&apos;t fully confirm</p>
          <div className="my-3 text-2xl font-black">Grade {result.gradeRange.best}–{result.gradeRange.worst}</div>
          <p className="text-sm text-[var(--muted)]">{Math.round((result.confidence ?? 0) * 100)}% confident</p>
          {result.question && <div className="card mt-3 p-3 text-left text-sm chip-yellow">🤖 {result.question}</div>}
          <button className="btn mt-4 w-full" onClick={() => setResult(null)}>📸 Add a close-up &amp; re-grade</button>
          <a className="btn btn-ghost mt-2 w-full" href={withBase(next)}>Proceed with provisional offer →</a>
        </div>
      </div>
    );
  }

  const box = frameForPose(poseFor(activeAngle));
  const step = Math.min(activeIdx + 1, ANGLES.length);

  return (
    <div className="mx-auto w-full max-w-md px-3 pb-8">
      {/* header — device · photo intake */}
      <div className="flex items-center justify-between py-3">
        <span className="text-[11px] font-semibold uppercase tracking-[0.15em] text-[var(--muted)]">Device · Photo intake</span>
        <span className="mono text-[11px] text-[var(--muted)]">
          #{sessionId}
          {model ? ` · ${model}` : ""}
        </span>
      </div>

      <div className="mb-2 text-center text-[12px] font-semibold" style={{ color: allDone ? "var(--green-ink)" : "var(--muted)" }}>
        {allDone ? "✓ All sides captured — grade when ready" : `${doneCount} / ${ANGLES.length} sides · now: ${shortLabel(activeAngle)}`}
      </div>

      {activeAngle === "Front — screen OFF" && (
        <div className="card mb-2 p-2.5 text-[13px] chip-yellow">
          🔌 <b>Screen OFF</b> — a dark screen shows the glass without glare.
        </div>
      )}
      {activeAngle.startsWith("Screen ON") && (
        <div className="card mb-2 p-2.5 text-[13px] chip-yellow">
          💡 <b>Screen ON, white &amp; bright</b> — reveals dead pixels, lines &amp; burn-in.
        </div>
      )}
      {gathering && (
        <div className="card mb-2 p-2.5 text-[13px] chip-yellow">
          {result.photoIssues?.length > 0 && <div>📷 Retake: <b>{result.photoIssues.join(", ")}</b></div>}
          {result.needMoreAngles?.length > 0 && (
            <div className={result.photoIssues?.length ? "mt-1" : ""}>🤖 Also need: <b>{result.needMoreAngles.join(", ")}</b></div>
          )}
          {result.question && <div className="mt-1">❓ {result.question}</div>}
          <a href={withBase(next)} className="btn btn-good mt-3 w-full">Looks good enough — grade it &amp; see offer →</a>
        </div>
      )}

      {/* ── BIG viewfinder with shutter ── */}
      <div className="relative overflow-hidden rounded-3xl border border-[var(--border)] bg-black" style={{ aspectRatio: "4 / 5" }}>
        <video ref={videoRef} playsInline autoPlay muted className="absolute inset-0 h-full w-full object-cover" />
        <div
          className="frame-box pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
          style={{
            width: box.width,
            aspectRatio: box.ar,
            ["--corner" as any]: quality.level === "good" ? "var(--green)" : quality.level === "warn" ? "var(--gold)" : "var(--bad)",
          }}
        >
          <span className="frame-corner tl" />
          <span className="frame-corner tr" />
          <span className="frame-corner bl" />
          <span className="frame-corner br" />
        </div>
        {flash && <div className="pointer-events-none absolute inset-0 bg-white/70" />}
        <div className="absolute left-3 top-3 pill" style={{ fontSize: 11 }}>
          {extraMode ? "Extra" : `Side ${step}/${ANGLES.length}`}
        </div>
        <div className="absolute right-3 top-3 rounded-full bg-black/45 px-3 py-1 text-[12px] font-bold text-white">
          {shortLabel(activeAngle)}
        </div>
        {!err ? (
          <div
            className="absolute bottom-24 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full px-3 py-1 text-center text-[12px] font-bold text-white"
            style={{ background: quality.level === "good" ? "var(--green)" : quality.level === "warn" ? "var(--amber-ink)" : "var(--bad)" }}
          >
            {quality.reason}
          </div>
        ) : (
          <div className="absolute bottom-24 left-1/2 -translate-x-1/2 rounded-lg bg-black/70 px-2 py-1 text-center text-[11px] text-white">
            Camera off — allow access (HTTPS/localhost)
          </div>
        )}
        {/* big shutter */}
        <button
          onClick={() => capture(false)}
          disabled={!!err}
          aria-label="Capture"
          className="absolute bottom-4 left-1/2 grid -translate-x-1/2 place-items-center rounded-full active:scale-95"
          style={{ width: 74, height: 74, background: "rgba(255,255,255,0.25)", border: "3px solid #fff" }}
        >
          <span className="rounded-full" style={{ width: 56, height: 56, background: "#fff" }} />
        </button>
      </div>

      {reject && (
        <div className="mt-3 flex items-center gap-2 rounded-xl chip-red p-2 text-sm">
          <span className="flex-1">✕ {reject}</span>
          <button className="pill" onClick={() => capture(true)} style={{ fontSize: 11 }}>Capture anyway</button>
        </div>
      )}
      {gradeErr && <p className="mt-3 text-center text-sm text-[var(--bad)]">{gradeErr}</p>}

      {/* ── BOTTOM side tiles (Pandas-style) — tap to select, ✓ when captured ── */}
      <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
        {ANGLES.map((a, i) => {
          const done = !!shots[i];
          const active = !extraMode && i === activeIdx;
          return (
            <button
              key={i}
              onClick={() => {
                setActiveIdx(i);
                setExtraMode(false);
                setReject("");
              }}
              className="relative flex w-[86px] shrink-0 flex-col items-center gap-1 rounded-2xl border p-2"
              style={{
                borderColor: active ? "var(--brand)" : done ? "color-mix(in oklch, var(--green) 45%, transparent)" : "var(--border)",
                background: active ? "color-mix(in oklch, var(--brand) 10%, transparent)" : "var(--card)",
              }}
            >
              {done && shots[i] ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={shots[i] as string} alt="" className="h-11 w-11 rounded-lg object-cover" />
              ) : (
                <div className="grid h-11 w-11 place-items-center">
                  <PoseIcon label={a} size={40} />
                </div>
              )}
              <div className="w-full truncate text-center text-[11px] font-semibold">{shortLabel(a)}</div>
              {done && (
                <span className="absolute right-1 top-1 grid h-4 w-4 place-items-center rounded-full text-[10px] text-white" style={{ background: "var(--green)" }}>
                  ✓
                </span>
              )}
            </button>
          );
        })}
      </div>

      {allDone && (
        <button onClick={() => setExtraMode((m) => !m)} className="mt-2 block w-full text-center text-[12px] text-[var(--muted)] underline">
          {extraMode ? "← Back to sides" : "＋ Add an optional close-up"}
        </button>
      )}
      {extras.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {extras.map((p, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={i} src={p} alt="" className="h-12 w-12 rounded-lg border border-[var(--border)] object-cover" />
          ))}
        </div>
      )}

      <button className="btn mt-3 w-full" onClick={grade} disabled={!allDone || busy}>
        {busy ? "Grading…" : gathering ? "Re-grade →" : allDone ? "Get condition grade →" : `Capture all ${ANGLES.length} sides`}
      </button>

      {/* Manual fallback — no camera / skip the automatic grade. */}
      <div className="mt-4 border-t border-[var(--border)] pt-3">
        {manual ? (
          <>
            <p className="mb-2 text-sm font-semibold">Pick the condition</p>
            <GradeSelect sessionId={sessionId} onDone={() => (window.location.href = withBase(next))} />
          </>
        ) : (
          <button onClick={() => setManual(true)} className="block w-full text-center text-sm text-[var(--muted)] underline">
            Can&apos;t use the camera? Grade condition manually →
          </button>
        )}
      </div>
    </div>
  );
}
