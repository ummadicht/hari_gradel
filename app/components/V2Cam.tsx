"use client";
import { useEffect, useRef, useState } from "react";
import { withBase } from "@/lib/basePath";
import { useGuidedCapture } from "@/lib/capture/useGuidedCapture";
import { PoseIcon } from "./AngleGuide";
import { DEFAULT_CAPTURE_STEPS } from "@/lib/journeyTypes";
import {
  exposureHoldKept,
  heldExposureConstraints,
  matchesOnTry,
  matchesPattern,
  retryBudgetLeftMs,
  retryHint,
  sweepColour,
  sweepTiming,
  withHeldExposure,
  EXPOSURE_SETTLE_MS,
  SWEEP_WHITE_ECHO_MS,
  type RegionStats,
  type SweepMiss,
} from "@/lib/displaySweep";
import { camDoneCopy } from "@/lib/camDoneCopy";

// The SECOND device's camera role in the guided v2 flow. It films the primary
// phone (the one being traded): a real quality-gated rotation for cosmetics,
// then a SYNCED display sweep (drives the primary's screen through each test
// pattern and captures when the primary confirms it's showing it), then films
// the primary's Settings for OCR. Everything grades via LIVE AI, then it signals
// the primary it's done. This is what restores 100% coverage for the 2-phone
// path (a phone can't film its own screen or Settings).
//
// TWO PASSES (optional `pass` prop, from `?pass=` on the page URL). The sweep
// above needs the test app open on the phone, and in a store flow the photos
// are taken BEFORE the phone has joined — so the one pass can be split:
//   "photos" — the angles, torch twins and cosmetic grading only. No display
//              sweep, no Settings scan, and nothing is ever asked of the phone's
//              screen (there is no app on it yet to answer).
//   "screen" — after the phone's own tests: the display sweep only.
// No `pass` is exactly the single full pass this component always ran.

type Step = "aim" | "rotate" | "grading" | "retake" | "display" | "settings" | "done";
type QLevel = "good" | "warn" | "bad";

// Fallback only — the live list comes from the tenant's journey config, same as
// the capture angles, so a channel can run a short reliable sweep instead of a
// long one that half-fails under glare.
import { DEFAULT_DISPLAY_PATTERNS } from "@/lib/journeyTypes";
// Default angles — the live list comes from the tenant's journey config
// (super-admin portal, /api/journey/<client>/<channel>), fetched on mount. The
// default is imported from the SAME module the portal editor edits, so the
// camera and the config screen can never drift apart.
// `id` is the STABLE step identifier from the capture-step catalog. It was
// being dropped here, which left telemetry keyed on the display LABEL — so a
// tenant that renames "Back" to "Rear glass" looks like a brand-new step, and
// two different steps that share a label merge into one.
const ANGLES = DEFAULT_CAPTURE_STEPS.map((s) => ({ id: s.id, label: s.label, how: s.how }));
type Angle = { id: string; label: string; how: string };
const COOLDOWN_MS = 900; // brief settle after a shot so the next tap isn't the same frame

/**
 * Quality of the frame — measured INSIDE THE GUIDE RECTANGLE, not across the
 * whole scene.
 *
 * This used to average the entire frame. In a restaurant, a café, a workshop —
 * anywhere with a busy background — the plates, table edge and chair backs are
 * sharp and textured enough to carry the score on their own while the phone
 * itself sits soft and small in the middle. That is exactly how a back photo
 * whose Apple logo carried a clear scratch was accepted, graded, and reported
 * as "rear glass clean": the mark was never resolvable in the pixels we kept.
 *
 * The guide rectangle drawn on screen (60% × 56%, centred) is where the phone is
 * supposed to be, so that is the only region worth judging. Same maths, honest
 * subject.
 */
const GUIDE_W = 0.6, GUIDE_H = 0.56; // must match the on-screen frame below

function assess(video: HTMLVideoElement): { ok: boolean; reason: string; level: QLevel } {
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return { ok: false, reason: "Starting camera…", level: "bad" };
  const S = 200, sh = Math.round((S * vh) / vw);
  const c = document.createElement("canvas");
  c.width = S; c.height = sh;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return { ok: true, reason: "", level: "good" };
  ctx.drawImage(video, 0, 0, S, sh);

  // Crop to the guide box before measuring anything.
  const bw = Math.max(8, Math.round(S * GUIDE_W));
  const bh = Math.max(8, Math.round(sh * GUIDE_H));
  const bx = Math.round((S - bw) / 2);
  const by = Math.round((sh - bh) / 2);
  const { data } = ctx.getImageData(bx, by, bw, bh);

  const n = bw * bh, g = new Float32Array(n);
  let sum = 0;
  for (let i = 0, j = 0; j < n; i += 4, j++) {
    const v = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    g[j] = v; sum += v;
  }
  const mean = sum / n;
  let vsum = 0;
  for (let j = 0; j < n; j++) { const d = g[j] - mean; vsum += d * d; }
  const contrast = Math.sqrt(vsum / n);
  let lap2 = 0, lap = 0, m = 0;
  for (let y = 1; y < bh - 1; y++) for (let x = 1; x < bw - 1; x++) {
    const i = y * bw + x;
    const l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - bw] - g[i + bw];
    lap += l; lap2 += l * l; m++;
  }
  const sharp = lap2 / m - (lap / m) ** 2;

  // Blown-out specular patch: a ceiling light reflecting off the panel erases
  // exactly the fine marks we are here to find, so it is a real reject.
  let hot = 0;
  for (let j = 0; j < n; j++) if (g[j] > 246) hot++;
  const hotFrac = hot / n;

  if (mean < 42) return { ok: false, reason: "Too dark — add light", level: "bad" };
  if (mean > 232) return { ok: false, reason: "Glare — tilt away from the light", level: "bad" };
  if (hotFrac > 0.06) return { ok: false, reason: "Bright reflection on the phone — tilt it slightly", level: "warn" };
  if (contrast < 12) return { ok: false, reason: "Move closer — fill the frame with the phone", level: "warn" };
  if (sharp < 90) return { ok: false, reason: "Not sharp yet — hold still, let it focus", level: "warn" };
  return { ok: true, reason: "Sharp ✓", level: "good" };
}

// Perceptual signature (tiny grayscale grid) — verifies the phone was rotated to a
// genuinely different view between angles (back ≠ front ≠ side), not the same twice.
const SIG_W = 16, SIG_H = 12;
const CHANGE_MIN = 11; // mean abs grayscale diff (0–255) required vs the last angle
/**
 * Score a frame that has ALREADY been taken.
 *
 * `assess` judges the live preview and decides when the shutter may fire. It
 * cannot judge the photo, because the frame that lands is not the frame that
 * was previewed — focus hunts, a hand moves, the flash fires. So a shot could
 * pass the preview gate and still arrive soft, and the only thing that noticed
 * was the SERVER gate, which meant leaving the camera, waiting for an upload,
 * and being bounced back into AR to do the same angle again.
 *
 * Three outcomes, matching what a person would actually do with a bad photo:
 *
 *   unusable  too soft or too dark to carry a grade   → discard, shoot it again
 *   soft      usable but not good                     → keep, flag it, move on
 *   good      keep, say nothing
 *
 * Deliberately cheap: a 160px greyscale Laplacian, a few milliseconds, no
 * network. Nothing here may make the camera stutter, so accuracy is traded for
 * staying out of the way — the server gate is still the authority, this exists
 * so it almost never has to speak.
 */
export type ShotVerdict = { level: "good" | "soft" | "unusable"; reason: string; sharp: number };

async function scoreShot(dataUrl: string): Promise<ShotVerdict> {
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = rej;
      im.src = dataUrl;
    });
    const S = 160, sh = Math.max(1, Math.round((S * img.height) / img.width));
    const c = document.createElement("canvas");
    c.width = S; c.height = sh;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) return { level: "good", reason: "", sharp: 999 };
    ctx.drawImage(img, 0, 0, S, sh);
    const d = ctx.getImageData(0, 0, S, sh).data;
    const n = S * sh;
    const g = new Float32Array(n);
    let mean = 0;
    for (let j = 0; j < n; j++) {
      const v = 0.299 * d[j * 4] + 0.587 * d[j * 4 + 1] + 0.114 * d[j * 4 + 2];
      g[j] = v; mean += v;
    }
    mean /= n;

    let lap = 0, lap2 = 0, m = 0;
    for (let y = 1; y < sh - 1; y++) for (let x = 1; x < S - 1; x++) {
      const i = y * S + x;
      const l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - S] - g[i + S];
      lap += l; lap2 += l * l; m++;
    }
    const sharp = m ? lap2 / m - (lap / m) ** 2 : 0;

    if (mean < 38) return { level: "unusable", reason: "came out too dark", sharp };
    if (mean > 236) return { level: "unusable", reason: "blown out by glare", sharp };
    // The floors are below the preview gate's 90 on purpose: this judges a
    // shot already taken, and discarding a borderline frame the seller
    // believes they nailed is its own kind of wrong.
    if (sharp < 45) return { level: "unusable", reason: "came out blurry", sharp };
    if (sharp < 80) return { level: "soft", reason: "a little soft", sharp };
    return { level: "good", reason: "", sharp };
  } catch {
    // Never block a capture because scoring failed.
    return { level: "good", reason: "", sharp: 999 };
  }
}

function signature(v: HTMLVideoElement): Uint8Array | null {
  if (!v.videoWidth) return null;
  const c = document.createElement("canvas");
  c.width = SIG_W;
  c.height = SIG_H;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(v, 0, 0, SIG_W, SIG_H);
  const { data } = ctx.getImageData(0, 0, SIG_W, SIG_H);
  const out = new Uint8Array(SIG_W * SIG_H);
  for (let i = 0, j = 0; j < out.length; i += 4, j++)
    out[j] = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
  return out;
}
function frameDiff(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return 999;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}
// ---- Lit-screen detection (closed-loop display sweep) ----
// The sweep used to fire on a handshake alone: the PRIMARY phone echoed "I'm
// showing white" and the camera captured blind. If the seller hadn't framed the
// screen yet, all six pattern shots caught nothing — and the grader then had to
// judge a display it never saw. These helpers let the camera VERIFY it can
// actually see the lit screen showing the expected colour before it captures,
// which also gives the seller time to position the phone.
type ScreenBox = { x0: number; y0: number; x1: number; y1: number };
const SCN_W = 64, SCN_H = 48;

function scaledPixels(v: HTMLVideoElement): Uint8ClampedArray | null {
  if (!v.videoWidth) return null;
  const c = document.createElement("canvas");
  c.width = SCN_W;
  c.height = SCN_H;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(v, 0, 0, SCN_W, SCN_H);
  return ctx.getImageData(0, 0, SCN_W, SCN_H).data;
}

/** Locate a bright, lit rectangle (the phone's screen showing white). */
function findLitScreen(v: HTMLVideoElement): { box: ScreenBox; coverage: number } | null {
  const d = scaledPixels(v);
  if (!d) return null;
  let x0 = SCN_W, y0 = SCN_H, x1 = -1, y1 = -1, n = 0;
  for (let y = 0; y < SCN_H; y++) {
    for (let x = 0; x < SCN_W; x++) {
      const i = (y * SCN_W + x) * 4;
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (lum > 150) {
        n++;
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  }
  const coverage = n / (SCN_W * SCN_H);
  // Too little = not framed yet; too much = the camera is staring at a lamp or
  // the whole frame is blown out, not a phone screen.
  if (coverage < 0.05 || coverage > 0.85 || x1 < 0) return null;
  return { box: { x0, y0, x1, y1 }, coverage };
}

/** Mean colour + contrast inside a locked screen box. */
function regionStats(v: HTMLVideoElement, b: ScreenBox): RegionStats | null {
  const d = scaledPixels(v);
  if (!d) return null;
  let r = 0, g = 0, bl = 0, n = 0;
  const lums: number[] = [];
  for (let y = b.y0; y <= b.y1; y++) {
    for (let x = b.x0; x <= b.x1; x++) {
      const i = (y * SCN_W + x) * 4;
      r += d[i]; g += d[i + 1]; bl += d[i + 2];
      lums.push(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
      n++;
    }
  }
  if (!n) return null;
  r /= n; g /= n; bl /= n;
  const mean = lums.reduce((a, x) => a + x, 0) / lums.length;
  const sd = Math.sqrt(lums.reduce((a, x) => a + (x - mean) ** 2, 0) / lums.length);
  return { r, g, b: bl, sd };
}

// Whether the colour inside the locked box is the one asked for —
// `matchesPattern` — lives in lib/displaySweep.ts with the sweep's timings, so
// its rules are unit-tested (SUP-264).

/**
 * The rotation take's bitrate, set rather than left to the browser.
 *
 * It is evidence of one continuous sweep, not of detail — the stills carry the
 * detail — and /video caps the upload (SUP-80, lib/uploadLimits.ts). Left to
 * the browser the size of a take was unknowable; at 2 Mbps a 3-minute sweep is
 * about 45 MB (60 MB as the data URL it travels in), well under the cap.
 */
const ROTATION_VIDEO_BPS = 2_000_000;

function pickRecorderMime(): MediaRecorderOptions {
  const types = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"];
  for (const t of types) {
    try {
      if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t))
        return { mimeType: t, videoBitsPerSecond: ROTATION_VIDEO_BPS };
    } catch {
      /* ignore */
    }
  }
  return { videoBitsPerSecond: ROTATION_VIDEO_BPS };
}

export default function V2Cam({ sessionId, pass }: { sessionId: string; pass?: "photos" | "screen" }) {
  /** Photos gated and stored — shown briefly so success is visible. */
  const [accepted, setAccepted] = useState(false);
  /** Per-angle verdict on the frame that was actually taken. */
  const [verdicts, setVerdicts] = useState<(ShotVerdict | null)[]>([]);
  const verdictsRef = useRef<(ShotVerdict | null)[]>([]);
  /** Angles that were kept but are not great — offered, never enforced. */
  const [softAngles, setSoftAngles] = useState<string[]>([]);
  const [step, setStep] = useState<Step>("aim");
  // Pre-capture acknowledgements — the seller confirms BOTH prep steps (case off,
  // screen wiped) before the camera can start, so we never grade a covered/smudged
  // device. Both must be ticked to enable "Start camera".
  const [acks, setAcks] = useState<[boolean, boolean]>([false, false]);
  const [progress, setProgress] = useState(0);
  const [quality, setQuality] = useState<{ reason: string; level: QLevel }>({ reason: "", level: "bad" });
  const [dispPattern, setDispPattern] = useState("");
  const [err, setErr] = useState("");
  const [angleIdx, setAngleIdx] = useState(0);
  const [shots, setShots] = useState<(string | null)[]>(() => ANGLES.map(() => null));
  const [camLive, setCamLive] = useState(false); // the video is actually playing frames
  // THE SELLER TAKES THE PHOTO. The camera coaches — lighting, focus, framing,
  // "you haven't turned it yet" — and says plainly when the shot is good, but it
  // never fires on its own. Auto-capture kept firing the instant a frame went
  // sharp, which is how a half-raised phone, a thumb, or the same side twice
  // ended up in the set; and someone who can see their own phone is better at
  // judging "that's the back, framed" than a variance threshold is.
  const [ready, setReady] = useState(false); // this exact frame is worth capturing
  const [recording, setRecording] = useState(false); // background rotation video is rolling
  // Server-side capture-gate rejection: why, and which attempt this is.
  const [gateReasons, setGateReasons] = useState<string[]>([]);
  const [gateAttempt, setGateAttempt] = useState(0);
  const [dispHint, setDispHint] = useState(""); // live guidance during the display sweep
  // How many colours the sweep actually verified (null until it has run), and
  // how many it asked for. "Screen checked" over a sweep that never saw the
  // screen would read as a pass, so the screen pass's done screen says so when
  // this is 0 — and a SwapUp session's full pass whenever it is short
  // (lib/camDoneCopy.ts).
  const [sweepSeen, setSweepSeen] = useState<number | null>(null);
  const [sweepAsked, setSweepAsked] = useState(0);
  // Which app opened this camera (the session's `profile.app`, set only by a
  // server-key create — SwapUp's). It picks the done screen's words; anything
  // else, or a session that could not be read, keeps GradeIQ's own (SUP-265).
  const [sessionApp, setSessionApp] = useState<string | null>(null);
  // Tenant journey config: which angles this client's channel captures, and
  // which phases (torch pass / display sweep / Settings OCR) run at all.
  const [angles, setAngles] = useState<Angle[]>(ANGLES);
  const anglesRef = useRef<Angle[]>(ANGLES);
  const phasesRef = useRef({ torchPass: true, displaySweep: true, settingsOcr: true, gradeAtEnd: true });
  const patternsRef = useRef<string[]>([...DEFAULT_DISPLAY_PATTERNS]);
  // Settles once the journey config fetch below has finished (or failed). The
  // full pass never needs it — its sweep starts minutes after load — but the
  // screen pass starts its sweep on the first tap, which can beat the fetch and
  // run the default colour list instead of this channel's.
  const journeyReadyRef = useRef<Promise<void> | null>(null);
  const [torchOn, setTorchOn] = useState(false); // torch available on this camera?
  // Which camera captures. Default the rear/environment cam (you photograph the
  // device in front of you); the front/"selfie" cam is offered too (mirror rig,
  // or a device propped facing the operator) and the operator can flip per angle
  // — so which camera each angle step uses is chosen live, not fixed.
  const [facing, setFacing] = useState<"environment" | "user">("environment");
  const litFramesRef = useRef<string[]>([]); // torch-lit twin of each angle
  const settingsCtlRef = useRef<string>("");
  /** "photo" = seller-shot stills (default), "film" = the legacy timed grab. */
  const settingsModeRef = useRef<"photo" | "film">("photo");
  /** Stills taken in photo mode, shown as a filmstrip so a bad one can be dropped. */
  const [settingsShots, setSettingsShots] = useState<string[]>([]);
  /** Resolves the photo-mode step when the seller submits or skips. */
  const settingsResolveRef = useRef<((shots: string[], skipped: boolean) => void) | null>(null);
  // The Settings OCR upload is a separate, cancellable phase after the frames
  // The Settings upload no longer blocks the seller, so there is no "busy"
  // phase left to announce and nothing to abort — Skip just leaves.

  const videoRef = useRef<HTMLVideoElement>(null);
  /** Angle indexes that have already produced a frame — a second frame for the
   *  same index is a REPLACEMENT, not a fresh capture, and conflating the two
   *  hides exactly the rework guidance is meant to remove. */
  const capturedOnceRef = useRef<Set<number>>(new Set());

  /**
   * OBSERVATION-MODE capture telemetry (Release 1).
   *
   * Runs alongside V2Cam's own assess() loop and changes nothing about what is
   * accepted — it only records how each frame was captured, so we can later ask
   * whether capture quality predicts grade instability. Sampled at 250ms rather
   * than the hook's default 125ms because nothing here drives UI, and a second
   * getImageData loop on a low-end Android is a real cost to spend carefully.
   *
   * Release 2 collapses V2Cam's assess() into this hook; until the telemetry
   * says which sharpness threshold is right (V2Cam uses 90, CosmeticCapture 65)
   * merging them would just be picking one at random.
   */
  const guided = useGuidedCapture({
    videoRef,
    sessionId,
    surface: "v2cam",
    // From the ACTIVE angle list (tenant journeys override it), not the static
    // default — that mismatch is what made Release 1's step attribution wrong.
    stepId: angles[angleIdx]?.id || `angle-${angleIdx}`,
    stepLabel: angles[angleIdx]?.label || `angle-${angleIdx}`,
    profile: "v2cam",
    intervalMs: 250,
    active: step === "rotate",
  });
  const streamRef = useRef<MediaStream | null>(null);
  const framesRef = useRef<string[]>([]);
  const loopRef = useRef<any>(null);
  const angleIdxRef = useRef(0);
  const cooldownRef = useRef(0);

  const sigRef = useRef<Uint8Array | null>(null); // signature of the last accepted angle (view-change check)
  const allSigsRef = useRef<Uint8Array[]>([]); // every accepted angle — a new view must differ from ALL of them
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  // Check the primary in on load (so it knows we're connected), and pull the
  // tenant's journey config so the capture walks THIS client's steps.
  useEffect(() => {
    fetch(withBase(`/api/sessions/${sessionId}/screen`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connected: true }),
    }).catch(() => {});
    journeyReadyRef.current = (async () => {
      try {
        const sess = await fetch(withBase(`/api/sessions/${sessionId}`)).then((r) => r.json());
        if (typeof sess?.profile?.app === "string") setSessionApp(sess.profile.app);
        const client = sess?.client_id || "default";
        const channel = sess?.profile?.channel || "consumer";
        const d = await fetch(withBase(`/api/journey/${client}/${channel}`)).then((r) => r.json());
        const cfg = d?.config;
        if (cfg?.captureSteps) {
          const on = cfg.captureSteps
            .filter((x: any) => x.enabled)
            .map((x: any) => ({ id: String(x.id || x.label || ""), label: x.label, how: x.how }));
          if (on.length >= 4) {
            setAngles(on);
            anglesRef.current = on;
            setShots(on.map(() => null));
          }
        }
        if (Array.isArray(cfg?.displayPatterns) && cfg.displayPatterns.length) {
          patternsRef.current = cfg.displayPatterns;
        }
        if (cfg?.phases) {
          phasesRef.current = {
            torchPass: cfg.phases.torchPass !== false,
            displaySweep: cfg.phases.displaySweep !== false,
            gradeAtEnd: cfg.phases.gradeAtEnd !== false,
            settingsOcr: cfg.phases.settingsOcr !== false,
          };
        }
        // Only an explicit "film" keeps the timed capture — same rule the server
        // applies, so a config that never mentions it lands on photo here too.
        settingsModeRef.current = cfg?.settingsCapture === "film" ? "film" : "photo";
      } catch {
        /* config fetch is best-effort — defaults are always valid */
      }
    })();
    return () => {
      clearInterval(loopRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      void exitFullscreen();
    };
  }, [sessionId]);

  useEffect(() => {
    const shows = step === "rotate" || step === "grading" || step === "display" || step === "settings";
    const v = videoRef.current;
    if (shows && v && streamRef.current && v.srcObject !== streamRef.current) {
      v.srcObject = streamRef.current;
      v.play().catch(() => {});
    }
  }, [step]);

  /**
   * Full-screen for the shoot. The browser chrome costs ~15% of a phone screen —
   * on a viewfinder that is the difference between seeing the whole device and
   * cropping its edges — and an address bar that slides in mid-rotation moves
   * the frame under the seller. Best-effort: iOS Safari has no Fullscreen API on
   * iPhone, so the layout below fills the viewport on its own regardless.
   */
  async function goFullscreen() {
    try {
      const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
      if (document.fullscreenElement) return;
      if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: "hide" } as FullscreenOptions);
      else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen();
    } catch {
      /* denied or unsupported — the flow works either way */
    }
  }

  async function exitFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
    } catch {
      /* ignore */
    }
  }

  async function start() {
    setErr("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: facing },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          // Continuous AF matters more than resolution for a 1px scratch.
          advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet],
        },
      });
      streamRef.current = stream;
    } catch {
      setErr("Allow camera access, then tap again.");
      return;
    }
    // Screen pass: the photos were taken in an earlier visit, so none of the
    // rotation set-up below applies — no angles, no background video, no
    // coaching loop. Straight to the sweep.
    if (pass === "screen") {
      void goFullscreen(); // this tap is the user gesture fullscreen requires
      void runScreenPass();
      return;
    }
    framesRef.current = [];
    angleIdxRef.current = 0;
    setAngleIdx(0);
    setShots(anglesRef.current.map(() => null));
    setCamLive(false);
    setReady(false);
    sigRef.current = null;
    allSigsRef.current = [];
    litFramesRef.current = [];
    setQuality({ reason: "Starting camera…", level: "bad" });
    // Support is unknown until a real attempt — see setTorch().
    torchStateRef.current = "";
    setTorchOn(false);
    void goFullscreen(); // this tap is the user gesture fullscreen requires
    startRecording(); // roll the background video for the whole sweep
    // Photos pass: the phone has no test app open yet, so there is nothing to
    // show a pattern — and a "white" left on the session would be the first
    // thing the app picks up when it does join.
    if (pass !== "photos") setPatternOnPrimary("white");
    setStep("rotate");
    beginCaptureLoop();
  }

  /**
   * Pass 2 of the two-pass flow: the customer's phone has run its own tests and
   * is sitting on its photo screen, so it can now show the colours. Only the
   * display sweep runs — the exterior photos were graded in pass 1, so there is
   * no /cosmetic submit and no rotation video here.
   *
   * `handoffDone` is what releases the phone from its photo screen, and in the
   * two-pass flow it comes from HERE and nowhere else: pass 1 ran before the
   * phone was even connected.
   */
  async function runScreenPass() {
    // Show the camera at once; the sweep below keeps this step and takes over
    // the hint as soon as it starts.
    setStep("display");
    setDispHint("Point the camera at the phone's screen…");
    // Use this channel's colour list, not the default — but never let a hung
    // config fetch hold the sweep back.
    await Promise.race([journeyReadyRef.current, wait(4000)]);
    const seen = await displaySweep();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    // GET /screen hides handoffDone while the capture verdict reads "retake"
    // (a rejected set must not release the phone). In the two-pass flow that
    // verdict can only be pass 1's, abandoned when the advisor skipped the
    // photos — it says nothing about this screen check. Clear it (the route lets
    // the camera clear a verdict, never set one to "ok"), or the phone would sit
    // on its photo screen for good. cosmeticDone is left exactly as it is.
    try {
      const sc = await fetch(withBase(`/api/sessions/${sessionId}/screen`)).then((r) => r.json());
      if (sc?.capture?.verdict === "retake") {
        await fetch(withBase(`/api/sessions/${sessionId}/screen`), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ capture: null }),
        });
      }
    } catch { /* the phone still has its own way out */ }
    await fetch(withBase(`/api/sessions/${sessionId}/screen`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handoffDone: true, pattern: "idle" }),
    }).catch(() => {});
    setSweepSeen(seen);
    setStep("done");
  }

  /**
   * Back to the photo screen after a server rejection. Deliberately routed
   * through start() so every capture invariant is re-established the same way a
   * first attempt does — a hand-rolled partial reset is how stale signatures and
   * half-filled angle slots leak into the retake.
   */
  async function restartCapture() {
    // Tell both devices we are shooting again, and un-stick any stale verdict.
    // The photos pass still announces the retake but drives no pattern — there
    // is no app on the phone yet to show it (see start()).
    await fetch(withBase(`/api/sessions/${sessionId}/screen`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        pass === "photos" ? { capture: { verdict: "retaking" } } : { capture: { verdict: "retaking" }, pattern: "white" },
      ),
    }).catch(() => {});
    setGateReasons([]);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    await start();
  }

  /**
   * Swap between the rear and front ("selfie") camera mid-capture WITHOUT losing
   * the shots already taken — just re-opens the stream on the other facing. Lets
   * the operator pick the best camera per angle (rear for a handheld device,
   * front for a mirror rig or a device propped facing them). Torch resets with
   * the new camera; the front preview is mirrored (see the <video>).
   */
  async function flipCamera() {
    const next = facing === "environment" ? "user" : "environment";
    setFacing(next);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: next },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet],
        },
      });
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = stream;
      const v = videoRef.current;
      if (v) v.srcObject = stream;
      torchStateRef.current = "";
      setTorchOn(false);
    } catch {
      setErr("Couldn't switch camera — it may be in use.");
    }
  }

  /**
   * Torch (flash) control. Raking light is how a human grader reveals hairlines
   * and micro-scratches that flat lighting hides, so each angle is shot twice:
   * once normally, once torch-lit.
   *
   * Chrome/Android only — iOS Safari exposes no torch constraint, so this
   * degrades to the single normal shot rather than pretending.
   */
  /**
   * TORCH — try it, don't interview it first.
   *
   * This used to return null whenever `getCapabilities().torch` was falsy, and
   * every caller then skipped the flash-lit pass silently. On production runs
   * that meant `lit: 0` on every single session — the raking-light shot that
   * exposes hairline scratches was never taken on ANY device.
   *
   * The capability probe is the problem, not the torch: plenty of Android Chrome
   * builds omit `torch` from getCapabilities() (or report it only after the
   * track has been live for a while) on cameras whose flash works perfectly via
   * applyConstraints. So: attempt the constraint, both the `advanced` form and
   * the plain form, and let the device answer by succeeding or throwing.
   *
   * iOS Safari genuinely has no torch API — it throws, we record "unsupported",
   * and the single normal frame stands. That is a real limit, honestly reported,
   * which is different from never trying.
   */
  function videoTrack(): MediaStreamTrack | null {
    return streamRef.current?.getVideoTracks?.()[0] ?? null;
  }

  /** "" = untested · "ok" · "unsupported" — surfaced so a missing pass is explainable. */
  const torchStateRef = useRef<"" | "ok" | "unsupported">("");

  async function setTorch(on: boolean): Promise<boolean> {
    const t = videoTrack();
    if (!t || t.readyState !== "live") return false;
    if (torchStateRef.current === "unsupported") return false;

    // Did the torch ACTUALLY change? `getSettings().torch` is the truth. This is
    // the Android fix: `advanced: [{torch}]` is a BEST-EFFORT constraint, so
    // applyConstraints RESOLVES even when the device silently ignores it (common
    // on Android Chrome/WebView) — the old code then recorded "ok" while the
    // flash never fired. We read the setting back and only trust a form that the
    // device confirms. `undefined` = the browser doesn't report torch → we can't
    // disprove it, so we trust the (non-throwing) apply.
    const reflectsOn = (): boolean | null => {
      try {
        const s = (t.getSettings?.() ?? {}) as { torch?: boolean };
        return s.torch === undefined ? null : s.torch === on;
      } catch {
        return null;
      }
    };
    const tryForm = async (c: MediaTrackConstraints): Promise<boolean> => {
      try {
        // `torch` isn't in lib.dom's constraint types yet, hence the casts.
        await t.applyConstraints(c);
        await new Promise((r) => setTimeout(r, 50)); // let the setting settle before readback
        return reflectsOn() !== false;
      } catch {
        return false;
      }
    };

    // Form 1 (advanced, the spec'd Chrome/Android form) then Form 2 (plain).
    if (await tryForm({ advanced: [{ torch: on }] } as unknown as MediaTrackConstraints)) {
      torchStateRef.current = "ok";
      setTorchOn(on);
      return true;
    }
    if (await tryForm({ torch: on } as unknown as MediaTrackConstraints)) {
      torchStateRef.current = "ok";
      setTorchOn(on);
      return true;
    }
    // Only NOW is it genuinely unsupported — and only for turning it ON. A failed
    // turn-OFF must not permanently mark the device unsupported.
    if (on) torchStateRef.current = "unsupported";
    return false;
  }

  /**
   * Hold the camera's exposure where the white screen put it (SUP-264).
   *
   * Left on auto, the camera brightens a black screen towards grey and washes
   * the colours out — so black and green, judged against the white frame the
   * sweep locked on, drift away from it while the sweep looks. Where the camera
   * offers a manual exposure mode (Android Chrome), switching to it — with the
   * exposure time and ISO it reports in force now — keeps the exposure white
   * set. Where it does not (iOS Safari), nothing happens: the relative rules
   * and the retries do the work. True only if the camera says it is now on
   * manual — `releaseExposure` then gives it back.
   *
   * Whether the hold KEPT the white is checked separately, on the picture
   * (`verifyHeldWhite` in the sweep): a driver that drops to its default ISO
   * makes white several stops darker, and then the exposure is given back
   * before the colours run.
   */
  async function holdExposure(): Promise<boolean> {
    const t = videoTrack();
    if (!t || t.readyState !== "live") return false;
    try {
      const caps = (t.getCapabilities?.() ?? {}) as {
        exposureMode?: string[];
        exposureTime?: { min?: number; max?: number };
        iso?: { min?: number; max?: number };
      };
      if (!Array.isArray(caps.exposureMode) || !caps.exposureMode.includes("manual")) return false;
      const now = (t.getSettings?.() ?? {}) as { exposureTime?: unknown; iso?: unknown };
      // `exposureMode` isn't in lib.dom's constraint types yet, hence the cast.
      await t.applyConstraints({ advanced: [heldExposureConstraints(caps, now)] } as unknown as MediaTrackConstraints);
      // An advanced set the camera can't satisfy is skipped silently, so ask.
      const mode = (t.getSettings?.() as { exposureMode?: string } | undefined)?.exposureMode;
      return mode === undefined || mode === "manual";
    } catch {
      return false;
    }
  }

  /** Back to automatic exposure after the sweep, before the Settings photos. */
  async function releaseExposure(): Promise<void> {
    const t = videoTrack();
    if (!t || t.readyState !== "live") return;
    try {
      const caps = (t.getCapabilities?.() ?? {}) as { exposureMode?: string[] };
      if (Array.isArray(caps.exposureMode) && !caps.exposureMode.includes("continuous")) return;
      await t.applyConstraints({ advanced: [{ exposureMode: "continuous" }] } as unknown as MediaTrackConstraints);
    } catch {
      /* best effort — the next step's photos are judged on their own */
    }
  }

  /**
   * Capture ONLY the phone's screen, using the rectangle the sweep locked onto.
   *
   * The display frames used to be whole-frame grabs, which caused two problems
   * that look unrelated and are not:
   *
   *  • WRONG MARKS. The grader was handed a picture of a screen surrounded by a
   *    hand, an arm and a wall, and asked to find display defects — so it marked
   *    the arm. On a grey or white pattern, skin and a pale wall are the most
   *    screen-like things in the frame, which is exactly why grey was the worst
   *    offender. A defect cannot be outside the screen; cropping to the screen
   *    makes that true of the evidence rather than merely asking for it.
   *  • SIZE. Seven full-resolution frames in one POST is the upload the seller
   *    was waiting on at the end of the sweep. The screen is a fraction of the
   *    frame, so this cuts most of it.
   *
   * `box` is in the detector's 64×48 grid, so it is converted to fractions of
   * the real frame here. The small margin keeps the bezel edge in view — a
   * defect at the very border of the panel is still a defect — without letting
   * the background back in.
   */
  function grabScreen(box: ScreenBox): string | null {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return null;
    const MARGIN = 0.06;
    const fx0 = box.x0 / SCN_W;
    const fx1 = (box.x1 + 1) / SCN_W;
    const fy0 = box.y0 / SCN_H;
    const fy1 = (box.y1 + 1) / SCN_H;
    const mx = (fx1 - fx0) * MARGIN;
    const my = (fy1 - fy0) * MARGIN;
    const sx = Math.max(0, (fx0 - mx)) * v.videoWidth;
    const sy = Math.max(0, (fy0 - my)) * v.videoHeight;
    const sw = Math.min(1, fx1 + mx) * v.videoWidth - sx;
    const sh = Math.min(1, fy1 + my) * v.videoHeight - sy;
    // A degenerate lock would produce a useless sliver — fall back to the whole
    // frame rather than storing something unreadable.
    if (sw < 40 || sh < 40) return grab();
    const cv = document.createElement("canvas");
    cv.width = Math.round(Math.min(sw, 1080));
    cv.height = Math.round((cv.width / sw) * sh);
    cv.getContext("2d")?.drawImage(v, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
    return cv.toDataURL("image/jpeg", 0.86);
  }

  function grab(): string | null {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return null;
    const cv = document.createElement("canvas");
    // Hairline scratches are one or two pixels wide. Downscaling to 1080 and
    // re-encoding at 0.72 removed them before the grader ever saw the photo.
    cv.width = Math.min(v.videoWidth, 1440);
    cv.height = Math.round((cv.width / v.videoWidth) * v.videoHeight);
    cv.getContext("2d")?.drawImage(v, 0, 0, cv.width, cv.height);
    return cv.toDataURL("image/jpeg", 0.86);
  }

  // ── Background rotation video — one continuous take under the per-angle stills. ──
  function startRecording() {
    const stream = streamRef.current;
    if (!stream || typeof MediaRecorder === "undefined") return;
    chunksRef.current = [];
    try {
      const mr = new MediaRecorder(stream, pickRecorderMime());
      mr.ondataavailable = (e) => { if (e.data && e.data.size) chunksRef.current.push(e.data); };
      mr.start(1000);
      recorderRef.current = mr;
      setRecording(true);
    } catch {
      recorderRef.current = null;
      setRecording(false);
    }
  }
  function stopRecording(): Promise<Blob | null> {
    const mr = recorderRef.current;
    recorderRef.current = null;
    setRecording(false);
    if (!mr || mr.state === "inactive") return Promise.resolve(null);
    return new Promise((res) => {
      mr.onstop = () =>
        res(chunksRef.current.length ? new Blob(chunksRef.current, { type: chunksRef.current[0].type || "video/webm" }) : null);
      try {
        mr.stop();
      } catch {
        res(null);
      }
    });
  }
  async function uploadVideo(blob: Blob) {
    try {
      const dataUrl: string = await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result));
        fr.onerror = rej;
        fr.readAsDataURL(blob);
      });
      await fetch(withBase(`/api/sessions/${sessionId}/video`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ video: dataUrl }),
      });
    } catch {
      /* best-effort evidence upload */
    }
  }

  /**
   * `source` splits the rules into two kinds, and the split is the whole point:
   *
   *  - PATIENCE rules (lighting, focus, framing) exist to help someone frame a
   *    good shot. A seller in a dim room genuinely knows better than assess()
   *    does, so the shutter MAY override these — otherwise a dark room becomes
   *    an unescapable dead end.
   *  - EVIDENCE rules (is a device in frame, is this a new view) are what the
   *    grade rests on. NOTHING may override these — six taps at one unchanging
   *    view must not fill six angle slots.
   *
   * Every capture is now `manual`; the parameter is kept because the display
   * sweep still captures programmatically once it has VERIFIED the lit screen.
   */
  function captureAngle(source: "auto" | "manual" = "auto") {
    const i = angleIdxRef.current;
    if (i >= anglesRef.current.length) return;
    const vEl = videoRef.current;

    if (source === "manual" && vEl) {
      const sig = signature(vEl);
      // A frame we cannot even signature is not evidence of anything.
      if (!sig) {
        const reason = "Hold steady — waiting for a clear frame 📷";
        setQuality({ reason, level: "warn" });
        // A refused shutter press is the single most informative capture event
        // there is: the operator believed the shot was ready and the app did
        // not. Release 1 recorded only accepted frames and threw these away.
        guided.record({ outcome: "rejected_quality", actualVerdict: { accepted: false, reason }, photoIndex: i });
        return;
      }
      // Must be a genuinely new view versus EVERY angle already accepted, not
      // merely the previous one.
      const dup = allSigsRef.current.some((prev) => frameDiff(sig, prev) < CHANGE_MIN);
      if (dup) {
        const reason = `Turn the phone — show the ${anglesRef.current[i].label.toLowerCase()} 🔄`;
        setQuality({ reason, level: "warn" });
        guided.record({ outcome: "rejected_duplicate", actualVerdict: { accepted: false, reason }, photoIndex: i });
        return;
      }
    }

    // The front-glass angle is shot with the PRIMARY's own screen facing this
    // camera (its "how" is "Screen toward you") — if that screen is still lit
    // (e.g. showing the "scan this QR" waiting page, or any bright UI) it
    // floods the glass with its own light and washes out exactly the
    // raking-light scratch signal the torch pass exists to reveal. Every other
    // angle points at a side the primary's own display can't light, so only
    // this one angle needs the detour.
    //
    // Not in the photos pass: the detour works by asking the phone's app to go
    // black, and there is no app on it yet. Waiting for a confirmation that can
    // never come would only add a pause, so the front is shot like any side.
    if (pass !== "photos" && /front/i.test(anglesRef.current[i]?.label || "")) {
      void captureFrontAngle(i);
      return;
    }

    const f = grab();
    if (!f) return;
    commitFrame(i, f, vEl);
    void captureTorchTwin(i);
    if (i + 1 >= anglesRef.current.length) finishRotate();
  }

  /** Records an accepted frame's bookkeeping — shared by the normal capture
   *  path and the front-angle detour below. */
  function commitFrame(i: number, f: string, vEl: HTMLVideoElement | null) {
    if (vEl) {
      const sig = signature(vEl);
      if (sig) {
        sigRef.current = sig; // reference the NEXT angle must differ from
        allSigsRef.current.push(sig);
      }
    }
    framesRef.current.push(f);
    // The one place BOTH capture paths converge — the normal shutter and the
    // front-angle detour — so telemetry can't miss a shot by being wired to
    // only one of them.
    guided.record({
      outcome: capturedOnceRef.current.has(i) ? "replaced" : "captured",
      actualVerdict: { accepted: true, reason: "accepted by V2Cam assess()" },
      photoIndex: i,
    });
    capturedOnceRef.current.add(i);
    setShots((prev) => { const n = [...prev]; n[i] = f; return n; });
    angleIdxRef.current = i + 1;
    setAngleIdx(i + 1);
    cooldownRef.current = performance.now() + COOLDOWN_MS;
    setReady(false);
    setProgress(Math.min(1, (i + 1) / anglesRef.current.length));

    /* JUDGE THE SHOT WITHOUT LEAVING THE CAMERA.
     *
     * Scored off the main flow — the angle has already advanced, so a slow
     * decode never stalls the shutter. If the frame turns out unusable we walk
     * the index BACK one and drop it, which re-arms the same side with a reason
     * attached. The seller stays in AR throughout; previously the only thing
     * that noticed a bad frame was the server, after six uploads. */
    void scoreShot(f).then((v) => {
      verdictsRef.current[i] = v;
      setVerdicts([...verdictsRef.current]);
      if (v.level !== "unusable") return;
      // Only rewind if nothing else has been shot since — rewinding past a
      // later good frame would silently delete work the seller can see.
      if (angleIdxRef.current !== i + 1) return;
      framesRef.current = framesRef.current.filter((x) => x !== f);
      capturedOnceRef.current.delete(i);
      verdictsRef.current[i] = null;
      setVerdicts([...verdictsRef.current]);
      setShots((prev) => { const n = [...prev]; n[i] = ""; return n; });
      angleIdxRef.current = i;
      setAngleIdx(i);
      setProgress(Math.min(1, i / anglesRef.current.length));
      setQuality({
        reason: `That ${anglesRef.current[i]?.label.toLowerCase() ?? "shot"} ${v.reason} — same side again 🔄`,
        level: "warn",
      });
      cooldownRef.current = performance.now() + 600;
    });
  }

  /**
   * Torch-lit twin of angle `litIdx`: flat light shows true colour and cracks,
   * raking light shows the hairlines flat light hides. Best-effort — a device
   * without torch just keeps the single normal frame. Fire-and-forget for
   * every ordinary angle (see call site); the front-angle detour below awaits
   * it directly so it can keep the primary's screen dark until this is done.
   */
  async function captureTorchTwin(litIdx: number) {
    if (!phasesRef.current.torchPass) return; // tenant disabled the torch pass
    if (!(await setTorch(true))) return;
    await new Promise((r) => setTimeout(r, 320)); // let AE settle under torch
    const lit = grab();
    await setTorch(false);
    if (lit) litFramesRef.current[litIdx] = lit;
  }

  /**
   * Front-glass angle detour: blank the primary's screen to black over the
   * same pattern-sync channel the display sweep uses (`setPatternOnPrimary` /
   * `waitForShown`, defined below), take the normal + torch-lit shots while
   * it's dark, THEN restore it — so neither shot competes with the primary's
   * own display for light. Best-effort: if the primary never confirms black
   * (mid-navigation, flaky connection, or an older client build that doesn't
   * echo `shown`), proceed anyway after a short timeout rather than stall the
   * seller on a shot the app can still take, just without the benefit.
   */
  async function captureFrontAngle(i: number) {
    clearInterval(loopRef.current); // hold this message instead of letting the coaching loop overwrite it
    setQuality({ reason: "Dimming the other phone's screen for a clean shot…", level: "warn" });
    setReady(false);
    await setPatternOnPrimary("black");
    await waitForShown("black", 1500);

    const f = grab();
    if (!f) {
      await setPatternOnPrimary("idle");
      beginCaptureLoop();
      return;
    }
    commitFrame(i, f, videoRef.current);
    await captureTorchTwin(i);
    // Only the front angle needed the primary dark — restore its normal
    // waiting screen now rather than leaving it blacked out through the rest
    // of the rotation.
    await setPatternOnPrimary("idle");
    if (i + 1 >= anglesRef.current.length) {
      finishRotate();
    } else {
      beginCaptureLoop();
    }
  }

  /**
   * The coaching loop. It runs continuously while the seller frames a shot and
   * answers ONE question: is this frame worth capturing right now, and if not,
   * what exactly should they change? It no longer captures anything itself.
   */
  function beginCaptureLoop() {
    cooldownRef.current = performance.now() + 400;
    clearInterval(loopRef.current);
    loopRef.current = setInterval(() => {
      const v = videoRef.current;
      // Gate on the camera actually delivering live frames — never coach against
      // a black/half-initialised feed. Surfaces "Starting camera…".
      if (!v || v.readyState < 2 || !v.videoWidth) {
        setCamLive(false);
        setQuality({ reason: "Starting camera…", level: "bad" });
        setReady(false);
        return;
      }
      setCamLive(true);
      if (angleIdxRef.current >= anglesRef.current.length) return;

      const q = assess(v);
      const idx = angleIdxRef.current;

      // EVIDENCE rule, shown live: the phone must actually be turned to a new
      // view. Checked against EVERY accepted angle, not just the previous one,
      // so "front, front, front" can't fill the set. The shutter enforces this
      // too — this is the seller finding out before they tap, not after.
      let turned = true;
      if (idx > 0 && allSigsRef.current.length) {
        const sig = signature(v);
        if (sig && allSigsRef.current.some((prev) => frameDiff(sig, prev) < CHANGE_MIN)) turned = false;
      }

      if (!turned) {
        setQuality({
          reason: `Turn the phone — show the ${anglesRef.current[idx].label.toLowerCase()} 🔄`,
          level: "warn",
        });
        setReady(false);
        return;
      }
      // Sets expectation before the tap: the front-glass shot pauses briefly
      // afterward to dim the primary's screen (see captureFrontAngle) — worth
      // telling the operator up front rather than leaving it a silent pause.
      const isFront = /front/i.test(anglesRef.current[idx]?.label || "");
      // The photos pass can't dim the screen for them (no app on the phone
      // yet), so for the front it asks the person holding it to switch it off.
      const readyMsg = !isFront
        ? "Looks good — take the shot"
        : pass === "photos"
          ? "Looks good — take the shot (switch its screen off for the clearest glass)"
          : "Looks good — take the shot (we'll dim the other screen first)";
      setQuality({ reason: q.ok ? readyMsg : q.reason, level: q.level });
      setReady(q.ok && performance.now() >= cooldownRef.current);
    }, 200);
  }

  async function finishRotate() {
    clearInterval(loopRef.current);
    setStep("grading");
    setSweepSeen(null); // this attempt's sweep, not an earlier one's
    const videoBlob = await stopRecording(); // stop the rotation take (stream stays live for the sweep)
    if (videoBlob) void uploadVideo(videoBlob);

    // The SERVER decides whether these photos are gradeable. A 422 means the
    // capture gate rejected the set (no phone in frame, or the same side shot
    // repeatedly) — nothing was graded and nothing was persisted, so we must send
    // the seller back to the photo screen rather than continue into the display
    // sweep and the functional tests.
    //
    // A network failure is NOT a rejection: treating an unreachable server as a
    // reject would trap a seller on flaky wifi in an unescapable retake loop, so
    // an exception falls through to the normal path and the server's own
    // cosmeticDone rule (which never trusts a lost response) keeps us honest.
    /* ORDER OF OPERATIONS.
     *
     * This used to submit the photos here — which graded the device, set
     * cosmeticDone and released the primary — and only THEN ran the display
     * sweep and the Settings scan. Two consequences: the stored grade was
     * computed from exterior photos alone, and the LCD frames arrived after the
     * number had already been produced, so the Display component never had
     * anything to judge.
     *
     * With `gradeAtEnd` the photo set is only VALIDATED here. The capture gate
     * still runs, so an unusable set is still rejected immediately — the seller
     * is never made to complete a whole sweep before finding out. Everything is
     * then collected, and ONE submit at the end grades the device from the
     * complete record. */
    const deferred = phasesRef.current.gradeAtEnd;

    const submitCosmetic = async (validateOnly: boolean, background = false) =>
      fetch(withBase(`/api/sessions/${sessionId}/cosmetic`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // `lit` is deliberately a separate field: the torch twin of an angle is
        // the SAME view, so folding it into `photos` would trip the gate's
        // duplicate-view check. The gate judges the normal set; the grader gets
        // both.
        body: JSON.stringify({
          /* The FINAL submit carries no images.
             The validate pass already put these six frames (and their torch
             twins) on the server, so re-sending them meant transferring the
             same ten-to-twenty megabytes twice from a phone — which was most
             of the wait the seller experienced as "checking the photos". */
          photos: background ? [] : framesRef.current.slice(-6),
          // The exact angle each photo was shot at, in order — so the report
          // labels every side correctly instead of guessing from a fixed
          // sequence (which drifts when the journey's capture steps are
          // customised or reordered).
          angleLabels: anglesRef.current.map((a) => a.label),
          lit: background ? [] : litFramesRef.current.filter(Boolean),
          // Why the lit set is the size it is: "ok" = the flash fired,
          // "unsupported" = this browser has no torch API (iOS), "" = never
          // attempted (tenant disabled the pass).
          torch: torchStateRef.current || "untested",
          validateOnly,
          // Answer once the photos are stored; grade afterwards. The gate has
          // already passed, so there is nothing left here for the seller to wait on.
          background,
        }),
      });

    const handleGate = async (res: Response): Promise<boolean> => {
      // Refused before it was read (SUP-80: too many uploads, or too large) — the photos were NOT
      // stored, so it is never "accepted": say why, plainly, on the retake screen.
      if (res.status === 429 || res.status === 413) {
        const body = await res.json().catch(() => null);
        setGateReasons([
          res.status === 429 && typeof body?.error === "string"
            ? body.error
            : res.status === 413
              ? "Those photos were too large to send — please retake them."
              : "The photos couldn't be sent — please try again in a few minutes.",
        ]);
        setGateAttempt(1);
        setStep("retake");
        return false;
      }
      if (res.status !== 422) return true;
      const body = await res.json().catch(() => null);
      const reasons: string[] = body?.capture?.reasons?.length
        ? body.capture.reasons
        : ["We couldn't grade those photos — please retake them."];
      // Name the specific angles that were too soft — "retake the blurry ones"
      // is only actionable if the seller knows WHICH ones.
      const blurry: number[] = body?.capture?.blurryIndexes || [];
      if (blurry.length) {
        const names = blurry.map((i) => anglesRef.current[i]?.label).filter(Boolean).join(", ");
        if (names) reasons.push(`Blurry: ${names}.`);
      }
      // The AUTHORITATIVE gate sent these angles back. Recorded per angle, not
      // once per session, so "which step fails server validation" is answerable
      // — that is the question a store-level retake dashboard turns on.
      for (const bi of blurry) {
        guided.record({
          outcome: "rejected_server",
          actualVerdict: { accepted: false, reason: (body?.capture?.code || "server gate").slice(0, 120) },
          photoIndex: bi,
        });
      }
      setGateReasons(reasons);
      setGateAttempt(body?.capture?.attempt || 1);
      setStep("retake");
      return false;
    };

    // When /cosmetic set cosmeticDone BEFORE the sweep (gradeAtEnd off), the
    // phone's 30 s grace runs from about then; the sweep keeps inside it
    // (lib/displaySweep.ts sweepTiming). Null in the deferred journey.
    let cosmeticDoneAt: number | null = null;
    try {
      // Deferred: gate only. Immediate: the legacy behaviour, grade right here.
      if (!(await handleGate(await submitCosmetic(deferred)))) return;
      if (!deferred) cosmeticDoneAt = performance.now();
      /* SAY SO WHEN THE PHOTOS ARE IN.
         The gate passing is the moment the seller's photo work is finished and
         accepted, and nothing said so — the screen held "Checking the photos…"
         through the sweep, the Settings scan and the upload, so a flow that had
         already succeeded looked like one still deciding. */
      if (deferred) {
        /* SUGGEST, DO NOT BLOCK.
         *
         * Soft shots are usable — they just grade worse. Stopping a finished
         * capture to demand a retake spends the seller's patience on a photo
         * the grader can still read, so this offers the retake and lets the
         * flow continue if they would rather move on. A hard reject already
         * happened in-camera, at the moment it was actionable. */
        const soft = verdictsRef.current
          .map((v, i) => (v?.level === "soft" ? anglesRef.current[i]?.label : null))
          .filter(Boolean) as string[];
        setSoftAngles(soft);
        setAccepted(true);
        await new Promise((r) => setTimeout(r, soft.length ? 1400 : 700));
      }
    } catch {
      /* unreachable server → fall through, never a false reject. The grade
         may still have landed and set cosmeticDone, so keep inside the grace. */
      if (!deferred) cosmeticDoneAt = performance.now();
    }

    // The photos pass runs neither, whatever the journey says: both need the
    // test app open on the phone, and in that flow the phone hasn't joined yet.
    // The sweep comes later, in its own visit (pass "screen").
    if (phasesRef.current.displaySweep && pass !== "photos") {
      // Kept for the done screen: the advisor is still holding the phone there,
      // and a SwapUp session must not show a plain ✓ over a short sweep.
      const seen = await displaySweep(cosmeticDoneAt);
      setSweepSeen(seen);
      setSweepAsked(patternsRef.current.length);
    }
    if (phasesRef.current.settingsOcr && pass !== "photos") await settingsScan();

    /* Leave whichever step just ended BEFORE the long grade.
     *
     * `displaySweep` and `settingsScan` each set their own step and never clear
     * it, so without this the seller sits on "Checking the screen" or "Now film
     * its Settings" for the whole grading call. The Settings buttons handle
     * their own tap, but this covers the paths they cannot: the capture loop
     * finishing on its own, and a journey with settingsOcr switched off, which
     * would otherwise freeze on the display screen instead. */
    setStep("grading");

    // Everything is now on the session — photos, torch twins, the verified
    // screen-on patterns, the Settings scan. Grade once, from all of it.
    if (deferred) {
      try {
        /* Upload, don't wait for the grade.
         *
         * This await now covers only the transfer and the disk write — the
         * vision pass runs after the response. Six photos plus an LCD sweep
         * used to end in a 8-30s blank stare at the exact moment the phone was
         * ready to hand back, for a number this screen never displays: the
         * report collects it, and says "still locating marks" until it lands. */
        if (!(await handleGate(await submitCosmetic(false, true)))) return;
      } catch { /* unreachable server → the primary's own gate still applies */ }
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    // Tell the primary it can proceed to its functional tests. `handoffDone` is
    // the "camera is FULLY finished" signal — sent only here, AFTER the display
    // sweep + Settings scan — so the primary keeps driving the white/green
    // patterns during the sweep instead of advancing the moment /cosmetic marks
    // the photos accepted.
    //
    // The photos pass must NOT send it. There the camera is not finished — the
    // screen check is still to come, after the phone's own tests — and a
    // handoffDone now would walk the phone straight past its photo screen
    // before that check could run. Only the screen pass sends it.
    await fetch(withBase(`/api/sessions/${sessionId}/screen`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        pass === "photos"
          ? { cosmeticDone: true, pattern: "idle" }
          : { cosmeticDone: true, handoffDone: true, pattern: "idle" },
      ),
    }).catch(() => {});
    setStep("done");
  }

  async function setPatternOnPrimary(p: string) {
    await fetch(withBase(`/api/sessions/${sessionId}/screen`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pattern: p }),
    }).catch(() => {});
  }

  async function waitForShown(p: string, timeout: number): Promise<boolean> {
    const t0 = performance.now();
    while (performance.now() - t0 < timeout) {
      try {
        const d = await fetch(withBase(`/api/sessions/${sessionId}/screen`)).then((r) => r.json());
        if (d.shown === p) return true;
      } catch { /* ignore */ }
      await wait(200);
    }
    return false;
  }

  /**
   * Closed-loop display sweep.
   *
   * The old version trusted a handshake: the primary echoed "I'm showing white"
   * and the camera captured on a timer. If the seller hadn't framed the screen
   * yet, all six shots caught nothing — and the grader was handed a display it
   * had never seen (which then got recorded as a PASS). Now the camera has to
   * SEE it: it waits for a genuinely lit white screen, locks onto that
   * rectangle, and for every later colour waits until the pixels inside that
   * rectangle actually turn that colour before capturing. That verification is
   * also what gives the seller time to position the phone.
   *
   * Resolves to the number of colours it verified (0 when it never saw the
   * screen) — the screen pass shows that on its done screen; the full pass
   * doesn't need it.
   *
   * `cosmeticDoneAt` (performance.now) is when /cosmetic set cosmeticDone, if
   * it did so before this sweep: the phone then leaves its pattern screen 30 s
   * later, and the retries are kept inside that (lib/displaySweep.ts).
   */
  async function displaySweep(cosmeticDoneAt: number | null = null): Promise<number> {
    setStep("display");
    setDispPattern("white");
    setDispHint("Point the camera at the phone's screen…");
    await setPatternOnPrimary("white");

    // Report the sweep's outcome even when it captured nothing.
    //
    // The completion path below already says "post even when NOTHING verified",
    // but the two abort paths returned BEFORE reaching it — so a sweep that
    // couldn't see the screen left no record at all. The report then showed no
    // white/blue/black frames with no explanation, and, worse, the grader still
    // produced a Display verdict for a screen it had never been shown (prod
    // session 9016c5b4: zero frames, Display graded D off an edge photo).
    // Silence read as "not attempted"; it was actually "attempted and failed".
    const reportSweep = async (
      captures: { pattern: string; photo: string }[],
      requested: string[],
      reason?: string,
      // What the camera saw of the white it locked on and of each colour it
      // missed — numbers only, kept so the cut-offs can be tuned on real
      // sweeps (lib/displaySweep.ts cleanSweepStats).
      stats?: { white: RegionStats | null; misses: SweepMiss[] },
    ) => {
      await fetch(withBase(`/api/sessions/${sessionId}/display`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ captures, requested, reason, stats }),
      }).catch(() => {});
    };

    // The primary must actually be driving patterns; otherwise skip honestly.
    const driving = await waitForShown("white", SWEEP_WHITE_ECHO_MS);
    if (!driving) {
      setDispHint("");
      await setPatternOnPrimary("idle");
      await reportSweep([], patternsRef.current, "the phone never confirmed it was showing the test patterns");
      return 0;
    }

    // ── Wait until we can SEE a lit white screen, then lock onto it ──
    let lock: ScreenBox | null = null;
    let lockStats: RegionStats | null = null;
    const findDeadline = performance.now() + 20000; // generous: the seller is aiming
    while (performance.now() < findDeadline && !lock) {
      const v = videoRef.current;
      if (v && v.readyState >= 2) {
        const hit = findLitScreen(v);
        if (hit) {
          const st = regionStats(v, hit.box);
          if (st && matchesPattern(st, "white")) {
            // Require it to hold briefly so a passing glare doesn't lock us on.
            await wait(350);
            const again = findLitScreen(v);
            const st2 = again && regionStats(v, again.box);
            if (again && st2 && matchesPattern(st2, "white")) {
              lock = again.box;
              lockStats = st2;
            }
          } else {
            setDispHint("Screen found — hold steady on the white screen");
          }
        } else {
          setDispHint("Point the camera at the phone's screen…");
        }
      }
      if (!lock) await wait(200);
    }

    if (!lock) {
      // Never fake it: no verified screen → no display captures at all, so the
      // grader can't be handed frames of nothing. But DO record that we tried:
      // on a foldable this is the common case (the inner screen is the display
      // under test and it stays folded shut), and "we asked, we never saw it"
      // is what the report should say instead of showing nothing.
      setDispHint("");
      await setPatternOnPrimary("idle");
      await reportSweep(
        [],
        patternsRef.current,
        "the camera never got a clear view of the lit screen (on a folding phone, unfold it and show the inner display)",
      );
      return 0;
    }

    // ── Step the colours, verifying each one inside the locked rectangle ──
    //
    // The white frame we locked on is the reference black and green are judged
    // against (lib/displaySweep.ts) — on a try whose echo arrived, so the
    // looser relative rules only ever judge the colour the phone says it is
    // showing — and the exposure is held where white put it while the colours
    // run. A colour that is not seen is tried again on the same lock, up to
    // SWEEP_RETRIES more times while the retry budget lasts.
    const box: ScreenBox = lock;
    const vLock = videoRef.current;
    const whiteNow = vLock && vLock.readyState >= 2 ? regionStats(vLock, box) : null;
    // Only a frame that still reads as white may be the reference — anything
    // else would skew the black and green rules.
    const whiteRef = whiteNow && matchesPattern(whiteNow, "white") ? whiteNow : lockStats;
    const captures: { pattern: string; photo: string }[] = [];
    const wanted = patternsRef.current;
    const misses: SweepMiss[] = [];
    /** The last region stats seen while looking for the colour under way. */
    let lastSeen: RegionStats | null = null;
    /** Look for `p` inside the lock for up to `ms`; capture it the moment it shows. */
    const lookFor = async (p: string, ms: number, echoed: boolean): Promise<boolean> => {
      const deadline = performance.now() + ms;
      while (performance.now() < deadline) {
        const v = videoRef.current;
        const st = v && v.readyState >= 2 ? regionStats(v, box) : null;
        if (st) lastSeen = st;
        if (st && matchesOnTry(st, p, whiteRef, echoed)) {
          // The locked rectangle only — a display defect cannot be outside the
          // display, and a whole-frame grab is what let arms and walls get marked.
          const f = grabScreen(box);
          if (f) {
            captures.push({ pattern: p, photo: f });
            return true;
          }
        }
        await wait(150);
      }
      return false;
    };
    /** After the hold: does the box still show the white the rules are judged against? */
    const verifyHeldWhite = async (): Promise<boolean> => {
      await wait(EXPOSURE_SETTLE_MS);
      const v = videoRef.current;
      return exposureHoldKept(whiteRef, v && v.readyState >= 2 ? regionStats(v, box) : null);
    };
    const lockAt = performance.now();
    const timing = sweepTiming(lockAt, cosmeticDoneAt);
    await withHeldExposure(holdExposure, releaseExposure, async () => {
      for (let i = 0; i < wanted.length; i++) {
        const p = wanted[i];
        setDispPattern(p);
        setDispHint(`Showing ${p} — hold steady`);
        lastSeen = null;
        const r = await sweepColour({
          post: () => setPatternOnPrimary(p),
          waitEcho: (ms) => waitForShown(p, ms),
          look: (ms, echoed) => lookFor(p, ms, echoed),
          now: () => performance.now(),
          // Retries while the sweep is under its budget since the lock, with a
          // first try kept back for each colour still to come (≈ 68 s at worst;
          // inside the phone's grace when cosmeticDone came first).
          echoMs: timing.echoMs,
          budgetLeftMs: retryBudgetLeftMs(performance.now() - lockAt, wanted.length - i - 1, timing.tryMs, timing.budgetMs),
          onRetry: () => setDispHint(retryHint(p)),
        });
        // Not verified after its tries → skip this pattern rather than capture
        // a frame that doesn't show it. A missing pattern is honest; a wrong one
        // is not. What the camera last saw is kept for calibration.
        if (!r.captured) misses.push({ pattern: p, attempts: r.attempts, echoed: r.echoed, seen: lastSeen });
      }
    }, verifyHeldWhite);

    // The last colour appeared to hang here: the sweep was finished, but the
    // upload of every captured frame still had to go out and nothing said so.
    setDispHint("Saving the screen test…");
    await setPatternOnPrimary("idle");
    // Post even when NOTHING verified: "we asked for six and confirmed none"
    // is the single most useful thing the report can say about a display that
    // couldn't be checked, and staying silent looked like the sweep never ran.
    await reportSweep(
      captures,
      wanted,
      captures.length ? undefined : "the screen never displayed a verifiable test pattern",
      { white: whiteRef, misses },
    );
    setDispHint("");
    return captures.length;
  }

  /** Send whatever Settings stills we have. Never blocks — see the note below. */
  function submitSettingsFrames(frames: string[], issuedAt: number) {
    if (!frames.length) return;
    void fetch(withBase(`/api/sessions/${sessionId}/ocr`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Both stamps come from THIS device's clock, so the freshness check on
      // the server compares like with like (see lib/compliance.ts).
      body: JSON.stringify({ frames, issuedAt, takenAt: Date.now() }),
      keepalive: true,
    }).catch(() => {
      /* enrichment only — a failure costs the record, never the grade */
    });
  }

  /**
   * PHOTO MODE — the seller decides when the shot is worth taking.
   *
   * Filming captured on a timer, so a frame landed whenever the window elapsed,
   * which on a real counter is usually before the right screen is even open.
   * Production bears that out: the OCR read a battery figure on 11 sessions and
   * an IMEI on ZERO. Handing the shutter over means fewer frames, of the two
   * screens that actually matter, chosen by the person who can see them.
   *
   * Resolves when the seller submits or skips; `finishRotate` then carries on
   * to grading exactly as before.
   */
  function settingsPhoto(): Promise<void> {
    setStep("settings");
    setProgress(0);
    setSettingsShots([]);
    settingsCtlRef.current = "";
    const issuedAt = Date.now();
    return new Promise<void>((resolve) => {
      settingsResolveRef.current = (shots: string[], skipped: boolean) => {
        settingsResolveRef.current = null;
        if (!skipped) submitSettingsFrames(shots, issuedAt);
        resolve();
      };
    });
  }

  async function settingsScan() {
    // Photo is the default everywhere; film is opt-in per channel.
    if (settingsModeRef.current === "photo") return settingsPhoto();
    setStep("settings");
    setProgress(0);
    settingsCtlRef.current = "";
    const issuedAt = Date.now();
    const frames: string[] = [];
    /**
     * FOUR frames, polled every 70ms.
     *
     * It was six frames spaced by nine 210ms sleeps — 11.3 seconds of standing
     * still before the step could even finish, and up to 210ms of dead air
     * after a Skip tap because the control flag was only read once per sleep.
     *
     * Six frames was never buying six screens: production OCR reads
     * batteryHealth on 11 sessions and an IMEI on ZERO, because the IMEI sits
     * below the fold on iOS Settings ▸ About. Extra frames of the same screen
     * do not fix that; a dedicated *#06# step would.
     *
     * So: fewer frames, and a poll fine enough that Skip and Done feel like
     * button presses rather than requests.
     */
    const FRAMES = 4;
    const GAP_MS = 1400;
    const TICK_MS = 70;
    for (let i = 0; i < FRAMES; i++) {
      for (let w = 0; w < GAP_MS / TICK_MS; w++) {
        if (settingsCtlRef.current) break;
        await wait(TICK_MS);
      }
      // SKIP LEAVES NOW. Not after this frame, not after the upload — the whole
      // step is optional, so the only correct response to "skip" is to stop.
      if (settingsCtlRef.current === "skip") return;
      const f = grab();
      if (f) frames.push(f);
      setProgress(Math.min(1, (i + 1) / FRAMES));
      if (settingsCtlRef.current === "done") break;
    }
    /**
     * THE UPLOAD DOES NOT BLOCK THE SELLER.
     *
     * This used to `await` the OCR — six base64 frames POSTed to a vision model,
     * capped at 25s — while the seller stared at a screen that still said "Now
     * film its Settings". Combined with the ~11s capture loop above, the step
     * could hold someone for half a minute at the end of an inspection.
     *
     * The wait was never justified: this endpoint enriches the record with
     * model/IMEI/battery text and, as the flow's own design says, is NEVER a
     * gate on the grade. Nothing downstream reads its result synchronously. So
     * it is sent and the seller moves on; the session is enriched whenever the
     * call lands, and if it never does, the report simply has no Settings data
     * — which is exactly what it had while the seller was waiting anyway.
     *
     * `keepalive` so the request survives this component unmounting as the flow
     * advances, which is now the normal case rather than an edge one.
     */
    submitSettingsFrames(frames, issuedAt);
  }

  // 100dvh + safe-area padding: the viewfinder owns the whole screen even when
  // the browser refuses fullscreen (iOS Safari) or the URL bar is showing.
  const wrap = "min-h-[100dvh] w-full text-white";
  const fill = "fixed inset-0 h-[100dvh] w-screen overflow-hidden text-white";
  const bg = { background: "radial-gradient(120% 90% at 50% 0%, #12222b 0%, #0b0f14 60%)" };
  const grad = "linear-gradient(135deg,#12b0a0,#0b7d78)";

  // Prep gate. Getting the case off BEFORE the shoot is the single highest-value
  // instruction here: a covered phone can't be graded at all (its back, frame
  // and cameras come back "not assessed" and the offer is blocked), and a
  // smeared screen reads as haze. Cheaper to say it once now than to reject the
  // set and send them round again.
  //
  // The screen pass skips that gate: the case and the wipe were confirmed for
  // the photos in pass 1, and all this visit needs is the screen in view.
  if (step === "aim" && pass === "screen") {
    return (
      <div className={`${wrap} flex flex-col items-center justify-center px-6 text-center`} style={bg}>
        <div
          className="grid h-16 w-16 place-items-center rounded-full text-3xl"
          style={{ background: "rgba(18,176,160,0.2)" }}
          aria-hidden="true"
        >
          📱
        </div>
        <h1 className="mt-4 text-2xl font-extrabold">Check the screen</h1>
        <p className="mt-2 max-w-xs text-[14px] text-white/60">
          Hold the camera over the customer&apos;s phone screen.
        </p>
        <p className="mt-2 max-w-xs text-[12px] leading-relaxed text-white/40">
          It will show a few colours. Keep the whole screen in view until they finish.
        </p>
        <button
          onClick={start}
          className="mt-6 w-full max-w-xs rounded-full py-4 text-[16px] font-bold"
          style={{ background: grad }}
        >
          Start camera →
        </button>
        {err && <p className="mt-3 text-sm text-red-300">{err}</p>}
      </div>
    );
  }

  if (step === "aim") {
    const bothAcked = acks[0] && acks[1];
    const PREP = [
      {
        icon: "📵",
        t: "Case & accessories off",
        d: "Case, bumper, pop-socket, ring holder and any screen protector — a cover hides the real condition.",
      },
      {
        icon: "🧻",
        t: "Screen & back wiped",
        d: "A soft dry cloth. Fingerprints and smudges read as haze or scratches and can cost a grade.",
      },
    ];
    return (
      <div className={`${wrap} flex flex-col items-center justify-center px-6 text-center`} style={bg}>
        <style>{`
          .v2prep-stage{position:relative;width:150px;height:150px;display:grid;place-items:center}
          .v2prep-phone{position:relative;width:64px;height:126px;border-radius:16px;
            background:linear-gradient(160deg,rgba(255,255,255,.12),rgba(255,255,255,.03));
            border:1px solid rgba(255,255,255,.22);overflow:hidden;animation:v2prepFloat 3.6s ease-in-out infinite}
          .v2prep-notch{position:absolute;top:7px;left:50%;transform:translateX(-50%);width:26px;height:5px;border-radius:99px;background:rgba(255,255,255,.3)}
          .v2prep-shine{position:absolute;top:-30%;left:-24px;width:22px;height:160%;transform:rotate(18deg);
            background:linear-gradient(90deg,transparent,rgba(255,255,255,.6),transparent);animation:v2prepShine 3.6s ease-in-out infinite}
          .v2prep-case{position:absolute;width:74px;height:136px;border-radius:20px;border:2px solid rgba(255,255,255,.55);
            background:rgba(255,255,255,.05);animation:v2prepCaseOff 3.6s ease-in-out infinite}
          .v2prep-spark{position:absolute;font-size:12px;color:#fff;opacity:0}
          .v2prep-spark-1{top:16px;right:22px;animation:v2prepTwinkle 3.6s ease-in-out infinite}
          .v2prep-spark-2{bottom:22px;left:24px;animation:v2prepTwinkle 3.6s ease-in-out .35s infinite}
          @keyframes v2prepFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}
          @keyframes v2prepCaseOff{0%,18%{transform:translateX(0) rotate(0);opacity:1}52%,100%{transform:translateX(74px) rotate(9deg);opacity:0}}
          @keyframes v2prepShine{0%,48%{transform:translateX(0) rotate(18deg);opacity:0}58%{opacity:1}80%{transform:translateX(96px) rotate(18deg);opacity:1}86%,100%{transform:translateX(96px) rotate(18deg);opacity:0}}
          @keyframes v2prepTwinkle{0%,56%{opacity:0;transform:scale(.5)}70%{opacity:1;transform:scale(1)}86%,100%{opacity:0;transform:scale(.6)}}
          @media (prefers-reduced-motion:reduce){.v2prep-phone,.v2prep-shine,.v2prep-case,.v2prep-spark{animation:none}.v2prep-case{opacity:0}}
        `}</style>

        {/* animated prep — a case slides off the phone, then a clean-wipe shine */}
        <div className="v2prep-stage" aria-hidden="true">
          <div className="v2prep-phone">
            <span className="v2prep-notch" />
            <span className="v2prep-shine" />
          </div>
          <div className="v2prep-case" />
          <span className="v2prep-spark v2prep-spark-1">✦</span>
          <span className="v2prep-spark v2prep-spark-2">✦</span>
        </div>

        <h1 className="mt-3 text-2xl font-extrabold">Before you start</h1>
        <p className="mt-1.5 max-w-xs text-[13px] text-white/55">
          Tap to confirm both — so the phone can actually be graded.
        </p>

        <div className="mt-5 w-full max-w-xs space-y-3 text-left">
          {PREP.map((x, i) => {
            const on = acks[i];
            return (
              <button
                key={x.t}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  setAcks((a) => {
                    const n = [...a] as [boolean, boolean];
                    n[i] = !n[i];
                    return n;
                  })
                }
                className="flex w-full items-start gap-3 rounded-2xl px-4 py-3 text-left transition"
                style={{
                  background: on ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.06)",
                  border: `1px solid ${on ? "rgba(255,255,255,0.45)" : "rgba(255,255,255,0.12)"}`,
                }}
              >
                <span
                  className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full text-[13px] font-bold transition"
                  style={
                    on
                      ? { background: grad, color: "#fff" }
                      : { border: "2px solid rgba(255,255,255,0.35)", color: "transparent" }
                  }
                >
                  ✓
                </span>
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-[14px] font-bold">
                    <span aria-hidden="true">{x.icon}</span> {x.t}
                  </span>
                  <span className="mt-0.5 block text-[12px] text-white/55">{x.d}</span>
                </span>
              </button>
            );
          })}
        </div>

        <button
          onClick={start}
          disabled={!bothAcked}
          className="mt-6 w-full max-w-xs rounded-full py-4 text-[16px] font-bold transition disabled:opacity-40"
          style={{ background: grad }}
        >
          {bothAcked ? "Start camera →" : "Confirm both to start"}
        </button>
        <p className="mt-3 max-w-xs text-[11px] leading-relaxed text-white/40">
          You take each shot yourself — we&apos;ll guide the framing, light and focus, and which side to turn to next.
        </p>
        {err && <p className="mt-3 text-sm text-red-300">{err}</p>}
      </div>
    );
  }

  // A split pass ends with "what happens next", not "go back to the first
  // phone" — in pass 1 that phone hasn't even been connected yet.
  if (step === "done" && pass) {
    const title = pass === "photos" ? "Photos done" : "Screen checked";
    const body =
      pass === "photos"
        ? "Next, the customer's phone tests itself — you'll photograph its screen at the end."
        : sweepSeen === 0
          ? // Never let "checked" stand alone over a sweep that saw nothing.
            "The camera couldn't see the test colours clearly, so the report shows the screen as not checked."
          : "You can close this tab.";
    const unseen = pass === "screen" && sweepSeen === 0;
    return (
      <div className={`${wrap} flex flex-col items-center justify-center px-6 text-center`} style={bg}>
        <div
          className="grid h-16 w-16 place-items-center rounded-full text-3xl"
          style={unseen ? { background: "rgba(251,191,36,0.18)", color: "#fbbf24" } : { background: "rgba(52,211,153,0.2)", color: "#34d399" }}
        >
          {unseen ? "!" : "✓"}
        </div>
        <h1 className="mt-4 text-2xl font-extrabold">{title}</h1>
        <p className="mt-2 max-w-xs text-[14px] text-white/60">{body}</p>
      </div>
    );
  }

  if (step === "done") {
    // "Return to the first phone" is GradeIQ's two-phone wording; a SwapUp
    // session sends the advisor back to SwapUp Store instead, and says so in
    // amber when the sweep saw fewer colours than it asked for
    // (lib/camDoneCopy.ts). Every other session's screen is unchanged.
    const done = camDoneCopy(sessionApp, sweepSeen == null ? null : { seen: sweepSeen, requested: sweepAsked });
    const warn = done.tone === "warn";
    return (
      <div className={`${wrap} flex flex-col items-center justify-center px-6 text-center`} style={bg}>
        <div
          className="grid h-16 w-16 place-items-center rounded-full text-3xl"
          style={warn ? { background: "rgba(251,191,36,0.18)", color: "#fbbf24" } : { background: "rgba(52,211,153,0.2)", color: "#34d399" }}
        >
          {warn ? "!" : "✓"}
        </div>
        <h1 className="mt-4 text-2xl font-extrabold">{done.title}</h1>
        <p className="mt-2 max-w-xs text-[14px] text-white/60">{done.body}</p>
      </div>
    );
  }

  // The photo screen the seller is sent back to. Deliberately states WHAT was
  // wrong — a bare "try again" leaves someone re-shooting the same mistake — and
  // deliberately offers no way to proceed anyway: an ungradeable set cannot
  // become a valid offer by insisting.
  if (step === "retake") {
    return (
      <div className={`${wrap} flex flex-col items-center justify-center px-6 text-center`} style={bg}>
        <div
          className="grid h-16 w-16 place-items-center rounded-full text-3xl"
          style={{ background: "rgba(251,191,36,0.18)", color: "#fbbf24" }}
        >
          📷
        </div>
        <h1 className="mt-4 text-2xl font-extrabold">Let&apos;s retake those photos</h1>
        <ul className="mt-3 max-w-xs space-y-2 text-left text-[14px] text-white/70">
          {gateReasons.map((r, i) => (
            <li key={i} className="flex gap-2">
              <span aria-hidden="true">•</span>
              <span>{r}</span>
            </li>
          ))}
        </ul>
        <div className="mt-5 max-w-xs rounded-2xl px-4 py-3 text-left text-[13px] text-white/60" style={{ background: "rgba(255,255,255,0.06)" }}>
          <div className="font-bold text-white/80">Tips</div>
          <div className="mt-1">Fill the frame with the phone, and turn it to a new side for each shot — front, back, then each edge.</div>
        </div>
        {gateAttempt > 1 && (
          <p className="mt-3 text-[12px] text-white/40">Attempt {gateAttempt}</p>
        )}
        <button
          onClick={restartCapture}
          className="mt-6 w-full max-w-xs rounded-full py-4 text-[16px] font-bold"
          style={{ background: grad, color: "#fff" }}
        >
          Retake photos
        </button>
      </div>
    );
  }

  const pct = Math.round(progress * 100);
  const qColor = quality.level === "good" ? "#34d399" : quality.level === "warn" ? "#fbbf24" : "#f87171";
  const cur = angles[Math.min(angleIdx, angles.length - 1)];
  return (
    <div className={`${fill}`} style={{ background: "#000" }}>
      <video
        ref={videoRef}
        playsInline
        autoPlay
        muted
        className="absolute inset-0 h-full w-full object-cover opacity-90"
        // Mirror the PREVIEW for the front cam (natural selfie view). Only the
        // preview — grab() draws the raw frame off the canvas, so the captured/
        // graded photo stays true (un-mirrored), whichever camera is used.
        style={{ transform: facing === "user" ? "scaleX(-1)" : undefined }}
      />
      <div className="pointer-events-none absolute inset-0 grid place-items-center">
        {/* The guide box IS the measured region — assess() crops to exactly
            these proportions, so what the seller lines up inside the frame is
            what gets judged. Keep the two in step. */}
        <div
          className="relative grid place-items-center rounded-[2rem] border-2"
          style={{
            width: `${GUIDE_W * 100}%`,
            height: `${GUIDE_H * 100}%`,
            borderColor: step === "rotate" ? qColor : "rgba(255,255,255,0.4)",
          }}
        >
          {step === "rotate" && !camLive && (
            <div className="text-center">
              <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-white/30 border-t-white" />
              <div className="mt-2 text-[13px] font-semibold text-white/80">Starting camera…</div>
            </div>
          )}
          {step === "rotate" && camLive && ready && (
            <div
              className="rounded-full px-3 py-1 text-[13px] font-black uppercase tracking-wide"
              style={{ background: "rgba(52,211,153,0.9)", color: "#04231c" }}
            >
              Ready — tap
            </div>
          )}
        </div>
      </div>
      {(step === "rotate" || step === "grading") && (
        <>
          {recording && (
            <div className="absolute left-4 top-4 z-10 flex items-center gap-1.5 rounded-full bg-black/50 px-2.5 py-1 text-[11px] font-bold text-white">
              <span className="h-2 w-2 rounded-full bg-red-500" style={{ animation: "pulse 1.2s infinite" }} /> REC
            </div>
          )}
          {step === "rotate" && (
            <button
              onClick={flipCamera}
              className="absolute right-4 top-4 z-10 flex items-center gap-1.5 rounded-full bg-black/55 px-3 py-1.5 text-[12px] font-bold text-white active:scale-95"
              aria-label={`Switch camera (now ${facing === "user" ? "front" : "rear"})`}
            >
              <span aria-hidden>🔄</span> {facing === "user" ? "Front" : "Rear"} cam
            </button>
          )}
          <div className="absolute inset-x-0 top-4 flex justify-center gap-1.5 px-4">
            {angles.map((a, i) => {
              const done = !!shots[i];
              const active = i === angleIdx && step === "rotate";
              return (
                <div key={i} className="grid h-9 w-9 place-items-center rounded-xl" style={{ background: done ? "#12b0a0" : active ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.06)", border: active ? "2px solid #fff" : "none" }}>
                  {done ? <span className="text-[13px] font-bold text-white">✓</span> : <div style={{ opacity: active ? 1 : 0.5 }}><PoseIcon label={a.label} size={22} /></div>}
                </div>
              );
            })}
          </div>
          <div className="absolute right-4 top-20"><Ring pct={pct} /></div>
        </>
      )}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent px-6 pb-8 pt-16 text-center">
        {step === "settings" && settingsModeRef.current === "photo" ? (
          <>
            <div className="text-lg font-bold">Photograph its Settings</div>
            <div className="mt-1 text-[13px] text-white/70">
              Open <b>Settings ▸ General ▸ About</b> on the other phone and take a photo, then{" "}
              <b>Battery ▸ Battery Health</b> and take another.
            </div>
            {settingsShots.length > 0 && (
              <div className="mt-2 flex justify-center gap-1.5">
                {settingsShots.map((s, i) => (
                  <button
                    key={i}
                    // Tap a thumbnail to drop it — a mis-timed shot should cost
                    // one tap, not a restart of the step.
                    onClick={() => setSettingsShots((a) => a.filter((_, j) => j !== i))}
                    title="Remove this photo"
                    className="relative h-12 w-9 overflow-hidden rounded-md border border-white/30"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={s} alt="" className="h-full w-full object-cover" />
                    <span className="absolute inset-x-0 bottom-0 bg-black/60 text-[9px]">✕</span>
                  </button>
                ))}
              </div>
            )}
            <div className="mt-3 flex items-center justify-center gap-2">
              <button
                onClick={() => {
                  const f = grab();
                  if (f) setSettingsShots((a) => [...a, f].slice(0, 4));
                }}
                disabled={!camLive || settingsShots.length >= 4}
                className="rounded-full px-5 py-2.5 text-[14px] font-bold disabled:opacity-40"
                style={{ background: grad }}
              >
                📷 Take photo
              </button>
              <button
                onClick={() => {
                  setStep("grading");
                  settingsResolveRef.current?.(settingsShots, false);
                }}
                disabled={!settingsShots.length}
                className="rounded-full border border-white/25 px-4 py-2 text-[13px] font-semibold disabled:opacity-30"
              >
                Submit {settingsShots.length || ""}
              </button>
              <button
                onClick={() => {
                  // Skip discards the shots rather than submitting them —
                  // "skip" has to mean the step did not happen.
                  setStep("grading");
                  settingsResolveRef.current?.([], true);
                }}
                className="rounded-full px-3 py-2 text-[13px] text-white/60"
              >
                Skip
              </button>
            </div>
          </>
        ) : step === "settings" ? (
          <>
            <div className="text-lg font-bold">
              Now film its Settings
            </div>
            <div className="mt-1 text-[13px] text-white/70">
              {false ? (
                <>This is the last step — you can stop waiting and finish now.</>
              ) : (
                <>Show <b>Settings ▸ General ▸ About</b> (model, IMEI), then <b>Battery ▸ Battery Health</b> — hold on each screen a moment.</>
              )}
            </div>
            <div className="mx-auto mt-3 h-1.5 w-44 overflow-hidden rounded-full bg-white/20"><div className="h-full rounded-full" style={{ width: `${pct}%`, background: "#12b0a0" }} /></div>
            <div className="mt-4 flex justify-center gap-2">
              {/* Available from the first moment. A seller who has already shown
                  both screens should not sit through the remaining frames. */}
              {/* SWITCH THE SCREEN ON THE TAP, not when the work finishes.
                  Setting the ref alone made both buttons look broken: the
                  capture loop exits within a tick, but grading then runs for
                  8–30s with `step` still "settings", so the seller kept staring
                  at "Now film its Settings" and two buttons that nothing was
                  reading any more. Moving to "grading" here also removes them,
                  so a second tap can't land on a dead control. */}
              <button
                onClick={() => {
                  settingsCtlRef.current = "done";
                  setStep("grading");
                }}
                className="rounded-full px-4 py-2 text-[14px] font-bold"
                style={{ background: grad }}
              >
                Done →
              </button>
              <button
                onClick={() => {
                  settingsCtlRef.current = "skip";
                  setStep("grading");
                }}
                className="rounded-full border border-white/25 px-4 py-2 text-[13px] text-white/70"
              >
                Skip
              </button>
            </div>
          </>
        ) : step === "display" ? (
          <>
            <div className="text-lg font-bold">Checking the screen — hold on the display</div>
            <div className="mx-auto mt-2 inline-flex items-center gap-2 rounded-full bg-black/50 px-3 py-1 text-[13px] font-semibold">
              <span className="h-3 w-3 rounded" style={{ background: dispPattern === "stripes" ? "#888" : dispPattern || "#fff", border: "1px solid rgba(255,255,255,0.4)" }} />
              Showing {dispPattern || "…"} · dead-pixel scan
            </div>
            {dispHint && (
              <div className="mt-2 text-[13px] font-semibold text-white/80">{dispHint}</div>
            )}
          </>
        ) : step === "grading" ? (
          <>
            {accepted ? (
              <>
                <div className="text-lg font-bold" style={{ color: "var(--green)" }}>
                  ✓ Photos accepted
                </div>
                <div className="mt-1 text-[12px] text-white/50">
                  {framesRef.current.length} frames saved — grading continues in the background
                </div>
                {softAngles.length > 0 && (
                  <div className="mt-2 text-[12px]" style={{ color: "var(--amber-ink)" }}>
                    {softAngles.join(", ")} {softAngles.length === 1 ? "is" : "are"} a little soft.
                    <span className="text-white/50"> Still usable — they just grade more cautiously.</span>
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="text-lg font-bold">Checking the photos…</div>
                <div className="mt-1 text-[12px] text-white/50">
                  Reading {framesRef.current.length} real frames
                </div>
              </>
            )}
          </>
        ) : (
          <>
            <div className="text-[13px] font-semibold text-white/60">Angle {angleIdx + 1} of {angles.length}</div>
            <div className="mt-0.5 text-xl font-extrabold">{cur.label}</div>
            <div className="text-[13px] text-white/60">{cur.how}</div>
            <div
              className="mx-auto mt-2 inline-block rounded-full px-3 py-1 text-[13px] font-semibold"
              style={{ background: "rgba(0,0,0,0.5)", color: !camLive ? "#f87171" : ready ? "#34d399" : qColor }}
            >
              {!camLive ? "Starting camera…" : quality.reason}
            </div>
            {/* The shutter. Green when the frame is worth keeping, amber while
                something still needs fixing — but always tappable once the camera
                is live: the seller can see their own phone, and a lighting rule
                must never trap someone in a room we think is too dark. What it
                will NOT do is accept a shot of a side already captured. */}
            <button
              onClick={() => captureAngle("manual")}
              disabled={!camLive}
              className="mx-auto mt-3 grid h-[76px] w-[76px] place-items-center rounded-full transition-transform active:scale-90 disabled:opacity-40"
              style={{
                background: "rgba(255,255,255,0.2)",
                border: `4px solid ${ready ? "#34d399" : "#fff"}`,
                boxShadow: ready ? "0 0 0 6px rgba(52,211,153,0.25)" : "none",
              }}
              aria-label={`Capture the ${cur.label.toLowerCase()}`}
            >
              <span className="rounded-full" style={{ width: 56, height: 56, background: ready ? "#34d399" : "#fff" }} />
            </button>
            <div className="mt-2 text-[12px] font-semibold text-white/70">
              {ready ? `Tap to capture the ${cur.label.toLowerCase()}` : "Line it up, then tap the button"}
            </div>
          </>
        )}
      </div>
      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}`}</style>
    </div>
  );
}

function Ring({ pct }: { pct: number }) {
  const r = 20, c = 2 * Math.PI * r;
  return (
    <svg width={52} height={52} viewBox="0 0 52 52">
      <circle cx={26} cy={26} r={r} fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth={5} />
      <circle cx={26} cy={26} r={r} fill="none" stroke="#12b0a0" strokeWidth={5} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)} transform="rotate(-90 26 26)" />
      <text x={26} y={30} textAnchor="middle" fontSize={12} fontWeight={700} fill="#fff">{pct}%</text>
    </svg>
  );
}

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
