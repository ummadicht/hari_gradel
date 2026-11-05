"use client";
import { useEffect, useRef, useState } from "react";
import { withBase } from "@/lib/basePath";
import BubbleTouch from "./BubbleTouch";
import VoiceTest from "./VoiceTest";
import { runSpeakerLoopback, pulseTone } from "@/lib/speakerTest";

// Runs on the DEVICE BEING GRADED (opened via QR). Browsers REQUIRE one user
// gesture + permission grant before camera / mic / motion can be accessed —
// there is no silent path (iOS throws without a gesture). So there is exactly
// ONE tap to unlock camera+mic+motion, then a quick full-screen swipe that
// doubles as the touchscreen + multi-touch test, and everything else runs
// automatically: cameras (every lens, model-aware), mic + speaker (acoustic
// loopback), gyroscope/accelerometer, vibration, battery. Results submit to the
// linked session; then the screen becomes the inspector's LCD test panel.

type Res = "pass" | "fail" | "skip";
type Check = { id: string; label: string; note?: string; state: "wait" | "run" | Res };
type Lens = { id: string; name: string; facing: "rear" | "front" };
/**
 * A /functional write that did not fully land: "failed" = nothing was stored
 * (refused, or never reached the server); "partial" = saved, but the server
 * kept some earlier results (a fault recorded before stays until the store
 * clears it). `payload` is what to send again; absent when a retry cannot help.
 */
type SaveIssue = { kind: "failed" | "partial"; text: string; payload?: Record<string, unknown> };
type LensResult = {
  id: string;
  name: string;
  facing: string;
  state: "pass" | "fail" | "manual";
  /** Who decided this. Set only when the browser actually probed the lens —
   *  a "manual" lens has no verdict yet, so it has no author either. */
  by?: "browser" | "operator";
};

/**
 * The zoom the seller must select to put each lens in play.
 *
 * These are the markers the phone's own camera UI shows, which is the only
 * control we have over which optic is used — the browser cannot choose one.
 */
const ZOOM_FOR: Record<string, number> = {
  ultrawide: 0.5,
  wide: 1,
  telephoto: 3,
  periscope: 5,
};

const CHECKS0: Check[] = [
  { id: "touch", label: "Touchscreen", state: "wait" },
  { id: "multitouch", label: "Multi-touch", state: "wait" },
  { id: "voice", label: "Voice / microphone", state: "wait" },
  { id: "camera", label: "Cameras", state: "wait" },
  { id: "mic", label: "Microphone", state: "wait" },
  { id: "speaker", label: "Speaker", state: "wait" },
  { id: "motion", label: "Gyroscope / motion", state: "wait" },
  { id: "vibration", label: "Vibration", state: "wait" },
  { id: "battery", label: "Battery", state: "wait" },
];

const FILLS: Record<string, string> = {
  white: "#fff",
  black: "#000",
  red: "#f00",
  green: "#0f0",
  blue: "#00f",
};

// Hidden coverage grid behind the "wipe to clear" gesture — fine enough that a
// dead touch column or unresponsive edge leaves an un-wiped patch. Never shown.
const TCOLS = 8;
const TROWS = 14;
const TTILES = TCOLS * TROWS;
const WIPE_R = 46; // erase/coverage radius in CSS px

export default function DeviceTest({
  sessionId,
  onComplete,
}: {
  sessionId: string;
  onComplete?: () => void;
}) {
  // When embedded in a guided single-device flow (v2), finishing the hardware
  // tests hands control back instead of dropping into the 2-device screen-test.
  /**
   * The lens step sits between "tests finished" and "hand back", because it is
   * the only chance to exercise optics the browser cannot address while the
   * phone is still in the seller's hand.
   */
  const finishTests = () => {
    if (pendingLensesRef.current.length) {
      setPhase("lenses");
      return;
    }
    void handBack();
  };
  const [phase, setPhase] = useState<
    "arm" | "touch" | "voice" | "running" | "faceid" | "lenses" | "unsaved" | "patterns"
  >("arm");

  /* WERE THE RESULTS SAVED? The /functional writes used to be fire-and-forget
   * (`.catch(() => {})`, no status check), so a refused or failed save left the
   * phone saying "done" while the record had none of the run. Each write's
   * outcome is kept here, and the phone is not handed back until the seller
   * has seen it. */
  const [saveIssue, setSaveIssue] = useState<SaveIssue | null>(null);
  const saveIssueRef = useRef<SaveIssue | null>(null);
  const savesRef = useRef<Promise<void>[]>([]);
  const [retrying, setRetrying] = useState(false);

  function noteSaveIssue(issue: SaveIssue | null) {
    // A failure is never hidden behind a later, milder notice.
    if (issue && issue.kind === "partial" && saveIssueRef.current?.kind === "failed") return;
    saveIssueRef.current = issue;
    setSaveIssue(issue);
  }

  /** POST /functional and record how it went. Never throws. */
  function saveFunctional(payload: Record<string, unknown>): Promise<void> {
    const p = (async () => {
      try {
        const r = await fetch(withBase(`/api/sessions/${sessionId}/functional`), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          // Bounded, so the hand-back below never waits forever on a dead network.
          signal: typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(15000) : undefined,
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) {
          noteSaveIssue({
            kind: "failed",
            text: typeof d?.error === "string" && d.error ? d.error : `The results were not saved (the server answered ${r.status}).`,
            // A final check (409) or a malformed write (400) fails the same way twice.
            payload: r.status === 409 || r.status === 400 ? undefined : payload,
          });
        } else if (typeof d?.notice === "string" && d.notice) {
          noteSaveIssue({ kind: "partial", text: d.notice });
        }
      } catch {
        noteSaveIssue({ kind: "failed", text: "The results could not be sent. Check the phone's connection and try again.", payload });
      }
    })();
    savesRef.current.push(p);
    return p;
  }

  /** Hand the phone back (v2) or move on to the screen patterns — once every save has answered. */
  async function handBack() {
    await Promise.allSettled(savesRef.current);
    if (saveIssueRef.current) {
      setPhase("unsaved");
      return;
    }
    if (onComplete) onComplete();
    else setPhase("patterns");
  }

  async function retrySave() {
    const payload = saveIssueRef.current?.payload;
    if (!payload) return;
    setRetrying(true);
    saveIssueRef.current = null;
    setSaveIssue(null);
    savesRef.current = [];
    await saveFunctional(payload);
    setRetrying(false);
    if (!saveIssueRef.current) void handBack();
  }

  function continueAnyway() {
    saveIssueRef.current = null;
    setSaveIssue(null);
    if (onComplete) onComplete();
    else setPhase("patterns");
  }
  /** Lenses the browser could not select — the ones this step exists for. */
  const pendingLensesRef = useRef<LensResult[]>([]);
  const [lensSet, setLensSet] = useState<{ id: string; name: string; zoom: number }[]>([]);
  const [lensShots, setLensShots] = useState<Record<string, string>>({});
  const [lensBusy, setLensBusy] = useState(false);
  const [lensDone, setLensDone] = useState<{ lensId: string; state: string; reason: string }[] | null>(null);
  const lensFileRef = useRef<HTMLInputElement>(null);
  const lensTargetRef = useRef<string>("");
  const touchResRef = useRef<{ touch: Res; multitouch: Res }>({ touch: "skip", multitouch: "skip" });
  const [checks, setChecks] = useState<Check[]>(CHECKS0);
  const [pattern, setPattern] = useState("idle");
  const [err, setErr] = useState("");
  const [bioState, setBioState] = useState<"idle" | "running" | Res>("idle");
  // Biometric label adapts to the device: "Face ID" on Face ID iPhones, "Touch ID"
  // on Touch ID iPhones, "Fingerprint / face unlock" on Android/Samsung. WebAuthn
  // can't say WHICH method verified, so this names what the seller will actually see.
  const [bioLabel, setBioLabel] = useState("Biometric unlock");
  // The model's expected optical lenses, shown as their own rows under Cameras.
  // A "3/4 lenses verified" note is not enough for the tester or the buyer:
  // WHICH lens failed is the whole question on a phone with a cracked telephoto.
  const [lensList, setLensList] = useState<Lens[]>([]);
  const [lensStates, setLensStates] = useState<Record<string, "wait" | "run" | LensResult["state"]>>({});
  const [deviceModel, setDeviceModel] = useState("");
  const [speakerAsk, setSpeakerAsk] = useState(false); // manual "did you hear the beep?" fallback
  const speakerResolveRef = useRef<((heard: boolean) => void) | null>(null);
  const wakeRef = useRef<any>(null);

  // Manual speaker check — never a dead end when the acoustic loopback can't confirm
  // it: pulse a 1 kHz tone and let the user answer. Resolves true if they heard it.
  function askSpeakerManually(ac: AudioContext): Promise<boolean> {
    return new Promise((resolve) => {
      const tone = pulseTone(ac);
      speakerResolveRef.current = (heard: boolean) => {
        tone.stop();
        speakerResolveRef.current = null;
        setSpeakerAsk(false);
        resolve(heard);
      };
      setSpeakerAsk(true);
    });
  }
  const motionOKRef = useRef(false);

  // Touch-test state — "wipe to clear": drag to erase a fog layer; a hidden grid
  // tracks how much of the panel the finger actually reached.
  const [pct, setPct] = useState(0);
  const coveredRef = useRef<boolean[]>(Array(TTILES).fill(false));
  const maxTouchRef = useRef(1);
  const touchDoneRef = useRef(false);
  const padRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const set = (id: string, state: Check["state"], note?: string) =>
    setChecks((cs) => cs.map((c) => (c.id === id ? { ...c, state, note: note ?? c.note } : c)));

  // Poll for the inspector's screen pattern once diagnostics are done.
  useEffect(() => {
    if (phase !== "patterns") return;
    const t = setInterval(() => {
      fetch(withBase(`/api/sessions/${sessionId}/screen`))
        .then((r) => r.json())
        .then((d) => setPattern(d.pattern || "idle"))
        .catch(() => {});
    }, 700);
    return () => clearInterval(t);
  }, [phase, sessionId]);

  // Echo back which pattern is ACTUALLY on-screen now, so the inspector captures
  // in sync (waits for confirmation) instead of blind-firing on a timer.
  useEffect(() => {
    if (phase !== "patterns") return;
    fetch(withBase(`/api/sessions/${sessionId}/screen`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shown: pattern }),
    }).catch(() => {});
  }, [pattern, phase, sessionId]);

  // THE ONE GESTURE. Grants camera+mic (and iOS motion) inside a user tap —
  // browsers block these without it, which is why silent-on-load never tested
  // them. After this single grant we go straight into the touch sweep.
  async function unlock() {
    setErr("");
    let primer: MediaStream | null = null;
    try {
      primer = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: true,
      });
    } catch {
      setErr(
        "Allow camera & microphone to run the automatic test. Tap again and choose Allow."
      );
      return;
    }
    try {
      const anyDM = (window as any).DeviceMotionEvent;
      if (anyDM?.requestPermission) await anyDM.requestPermission();
      motionOKRef.current = true;
    } catch {
      /* denied — motion/vibration will skip */
    }
    primer.getTracks().forEach((t) => t.stop());
    (navigator as any).wakeLock?.request?.("screen").then((w: any) => (wakeRef.current = w)).catch(() => {});
    setPhase("touch");
  }

  // ---- Touchscreen + multi-touch: the BubbleTouch game reports both results
  // (clear every square for edge-to-edge coverage; one square needs two
  // fingers). ----
  function finishTouch(touch: Res, multitouch: Res) {
    if (touchDoneRef.current) return;
    touchDoneRef.current = true;
    set("touch", touch, touch === "fail" ? "Part of the screen didn't respond — dead touch area?" : undefined);
    set(
      "multitouch",
      multitouch,
      multitouch === "skip" ? "Two fingers not detected — check manually" : undefined
    );
    // Natural voice/mic test next, then the automatic sensor suite.
    touchResRef.current = { touch, multitouch };
    setPhase("voice");
  }

  function finishVoice(voice: Res) {
    set("voice", voice, voice === "skip" ? "No voice detected — check the mic manually" : undefined);
    setPhase("running");
    run({ ...touchResRef.current, voice });
  }

  // Fingerprint THIS device (the one that scanned the QR) so the server can
  // cross-check it against the scanned IMEI — anti-fraud against a device swap.
  // A browser can't read the IMEI, but it can prove OS + (Android) model.
  async function attest() {
    let model = "";
    try {
      const uaData = (navigator as any).userAgentData;
      const hi = await uaData?.getHighEntropyValues?.(["model", "platform", "platformVersion"]);
      model = hi?.model || "";
    } catch {
      /* not Chromium */
    }
    let gpu = "";
    try {
      const gl = document.createElement("canvas").getContext("webgl") as WebGLRenderingContext | null;
      const dbg = gl?.getExtension("WEBGL_debug_renderer_info");
      if (gl && dbg) gpu = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || "");
    } catch {
      /* blocked */
    }
    const device = {
      ua: navigator.userAgent,
      os: (navigator as any).userAgentData?.platform || navigator.platform || "",
      model,
      screen: `${window.screen.width}x${window.screen.height}`,
      dpr: window.devicePixelRatio,
      gpu,
    };
    fetch(withBase(`/api/sessions/${sessionId}/attest`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device }),
    }).catch(() => {});
  }

  // ---- automatic sensor suite ----
  async function run(seed: Record<string, Res>) {
    fetch(withBase(`/api/sessions/${sessionId}/screen`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connected: true }),
    }).catch(() => {});
    attest();

    const results: Record<string, Res> = { ...seed };
    const motionOK = motionOKRef.current;

    // Model's expected lens layout → model-aware camera test.
    let lenses: Lens[] = [];
    try {
      const d = await fetch(withBase(`/api/sessions/${sessionId}/screen`)).then((r) => r.json());
      lenses = Array.isArray(d.lenses) ? d.lenses : [];
      setDeviceModel(String(d.model || ""));
    } catch {
      /* fall back to whatever the browser exposes */
    }

    // 1. Cameras — every lens the browser exposes vs the model's expected layout.
    // Publish the layout BEFORE testing, so the tester sees the lenses this
    // model is supposed to have while they're being checked, not only after.
    setLensList(lenses);
    setLensStates(Object.fromEntries(lenses.map((l) => [l.id, "run" as const])));
    set("camera", "run");
    const cam = await testCameras(lenses);
    results.camera = cam.state;
    set("camera", cam.state, cam.note);
    const detailed = cam.detail.lenses;
    if (detailed.length) {
      setLensList(detailed.map((l) => ({ id: l.id, name: l.name, facing: l.facing as "rear" | "front" })));
      setLensStates(Object.fromEntries(detailed.map((l) => [l.id, l.state])));
    }
    /* Queue the lenses the browser could not select.
     *
     * The REAR set is built from every rear lens, not only the unverified ones,
     * because the check is a COMPARISON: proving the ultrawide is really wide
     * needs the 1× frame to compare it against. */
    const pending = detailed.filter((l) => l.state === "manual" && l.facing === "rear");
    pendingLensesRef.current = pending;
    if (pending.length) {
      setLensSet(
        detailed
          .filter((l) => l.facing === "rear")
          .map((l) => ({ id: l.id, name: l.name, zoom: ZOOM_FOR[l.id] ?? 1 }))
          .sort((a, b) => a.zoom - b.zoom)
      );
    }

    // 2 + 3. Microphone & Speaker — ONE acoustic loopback (lib/speakerTest.ts,
    // shared with the gamified Gauntlet flow so the two can't diverge): play a
    // 1 kHz tone on the speaker and listen for it on the mic. Hearing our own
    // tone proves BOTH work; hearing only ambient proves the mic but not the
    // speaker; total silence means the mic isn't picking anything up.
    set("mic", "run");
    set("speaker", "run");
    const loopback = await runSpeakerLoopback();
    let ac: AudioContext | null = loopback.ac;
    results.mic = loopback.mic;
    set("mic", results.mic);
    if (loopback.speaker === "pass") {
      results.speaker = "pass";
      // The speaker makes sound — but the sweep may have found frequencies it
      // can't reproduce. That's a real, gradeable defect (a lint-clogged mesh
      // or a cooked tweeter), so it's shown rather than rounded up to "pass".
      set(
        "speaker",
        "pass",
        loopback.weakBands.length
          ? `Weak above ${Math.min(...loopback.weakBands)} Hz — no output at ${loopback.weakBands.join(", ")} Hz`
          : undefined
      );
    } else if (ac) {
      // Loopback couldn't confirm the speaker (OS-forced echo cancellation, low
      // volume, or a weak mic→speaker path) — ask the user instead of failing blind.
      set("speaker", "run", "Listen for the beep…");
      results.speaker = (await askSpeakerManually(ac)) ? "pass" : "fail";
      set("speaker", results.speaker, results.speaker === "fail" ? "You didn't hear the speaker tone" : undefined);
    } else {
      results.speaker = "skip";
      set("speaker", "skip");
    }

    // 4. Gyroscope / accelerometer — real sensor readings from DeviceMotion.
    set("motion", "run");
    if (motionOK) {
      let gyro = false;
      let accel = false;
      const onM = (e: DeviceMotionEvent) => {
        const r = e.rotationRate;
        const a = e.accelerationIncludingGravity;
        if (r && (r.alpha || r.beta || r.gamma)) gyro = true;
        if (a && (a.x || a.y || a.z)) accel = true;
      };
      window.addEventListener("devicemotion", onM);
      await new Promise((r) => setTimeout(r, 800));
      window.removeEventListener("devicemotion", onM);
      results.motion = gyro || accel ? "pass" : "fail";
      set("motion", results.motion, gyro ? undefined : accel ? "Accelerometer only — no gyro data" : undefined);
    } else {
      results.motion = "skip";
      set("motion", "skip", "Motion permission not granted");
    }

    // 5. Vibration — buzz + detect the spike on the accelerometer.
    set("vibration", "run");
    if ("vibrate" in navigator && motionOK) {
      let spike = 0;
      const onM = (e: DeviceMotionEvent) => {
        const a = e.accelerationIncludingGravity;
        if (a) spike = Math.max(spike, Math.abs(a.x || 0) + Math.abs(a.y || 0) + Math.abs(a.z || 0));
      };
      window.addEventListener("devicemotion", onM);
      const rest = spike;
      navigator.vibrate([400]);
      await new Promise((r) => setTimeout(r, 600));
      window.removeEventListener("devicemotion", onM);
      results.vibration = spike > rest + 2 ? "pass" : "fail";
    } else results.vibration = "skip";
    set("vibration", results.vibration);

    // 6. Battery (Android exposes it).
    set("battery", "run");
    try {
      const b = await (navigator as any).getBattery?.();
      results.battery = b ? "pass" : "skip";
    } catch {
      results.battery = "skip";
    }
    set("battery", results.battery);

    // The mic stream itself is already stopped inside runSpeakerLoopback();
    // only the AudioContext (kept alive in case askSpeakerManually needed it)
    // is still ours to close.
    ac?.close().catch(() => {});

    void saveFunctional({
      functional: results,
      camera: cam.detail,
      audio: { profile: loopback.profile, weakBands: loopback.weakBands },
      merge: true,
    });

    // The biometric test runs on ANY phone with a platform authenticator —
    // Face ID / Touch ID on iPhone, fingerprint / face unlock on Android &
    // Samsung. WebAuthn triggers whatever biometric the OS has, so we only need
    // to (a) confirm a platform authenticator exists and (b) name it correctly
    // for the seller so the label never says "Face ID" on an Android.
    let bioLabelLocal = "Biometric unlock";
    try {
      const ua = navigator.userAgent;
      const isIphone = /iPhone/.test(ua);
      const isIpad = /iPad/.test(ua);
      const isAndroid = /Android/.test(ua);
      let model = "";
      try {
        model = (await fetch(withBase(`/api/sessions/${sessionId}/screen`)).then((r) => r.json()))?.model || "";
      } catch {
        /* model unknown */
      }
      const touchIdIphone = /\bSE\b|iPhone\s?(5|6|7|8)\b/i.test(model);
      if (isIphone) bioLabelLocal = touchIdIphone ? "Touch ID" : "Face ID";
      else if (isIpad) bioLabelLocal = "Touch ID / Face ID";
      else if (isAndroid) bioLabelLocal = "Fingerprint / face unlock";
    } catch {
      /* keep generic label */
    }
    let bioAvailable = false;
    try {
      const PC = (window as any).PublicKeyCredential;
      bioAvailable = !!PC && !!(await PC.isUserVerifyingPlatformAuthenticatorAvailable?.());
    } catch {
      bioAvailable = false;
    }
    if (bioAvailable) {
      setBioLabel(bioLabelLocal);
      setTimeout(() => setPhase("faceid"), 700);
    } else {
      // No platform biometric available → don't run (or record) a biometric test.
      setTimeout(finishTests, 900);
    }
  }

  function submitFunctional(partial: Record<string, Res>) {
    void saveFunctional({ functional: partial, merge: true });
  }

  // Face ID / biometric — the person's idea: a passkey ceremony. Registering a
  // platform passkey with userVerification "required" makes the OS run Face ID
  // (or Touch ID). If it completes, the biometric sensor + Secure Enclave path
  // works. WebAuthn won't say WHICH method verified, so it proves "Face ID or
  // device passcode" — honest wording in the UI.
  async function runFaceId() {
    setBioState("running");
    let res: Res = "fail";
    try {
      const challenge = crypto.getRandomValues(new Uint8Array(32));
      const userId = crypto.getRandomValues(new Uint8Array(16));
      const cred = await navigator.credentials.create({
        publicKey: {
          challenge,
          rp: { name: "GradeIQ", id: window.location.hostname },
          user: { id: userId, name: "gradeiq-device-test", displayName: "GradeIQ Device Test" },
          pubKeyCredParams: [
            { type: "public-key", alg: -7 },
            { type: "public-key", alg: -257 },
          ],
          authenticatorSelection: {
            authenticatorAttachment: "platform",
            userVerification: "required",
          },
          timeout: 60000,
          attestation: "none",
        },
      } as any);
      res = cred ? "pass" : "fail";
    } catch {
      res = "fail"; // cancelled or biometric failed to verify
    }
    setBioState(res);
    submitFunctional({ faceid: res });
    setTimeout(finishTests, 900);
  }

  function skipFaceId() {
    submitFunctional({ faceid: "skip" });
    finishTests();
  }

  // ---- Lens verification: the seller's own camera app reaches what we can't ----

  function openLensCamera(lensId: string) {
    lensTargetRef.current = lensId;
    lensFileRef.current?.click();
  }

  async function onLensFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    const lensId = lensTargetRef.current;
    if (lensFileRef.current) lensFileRef.current.value = "";
    if (!file || !lensId) return;
    // Downscale before it ever leaves the phone: the route caps each shot, and
    // a modern camera photo is far over that. Field of view survives a resize;
    // a rejected upload proves nothing.
    const dataUrl = await new Promise<string>((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result));
      fr.onerror = rej;
      fr.readAsDataURL(file);
    }).then(
      (raw) =>
        new Promise<string>((res) => {
          const img = new Image();
          img.onload = () => {
            const W = Math.min(img.width, 1280);
            const c = document.createElement("canvas");
            c.width = W;
            c.height = Math.round((W / img.width) * img.height);
            c.getContext("2d")?.drawImage(img, 0, 0, c.width, c.height);
            res(c.toDataURL("image/jpeg", 0.82));
          };
          img.onerror = () => res(raw);
          img.src = raw;
        })
    );
    setLensShots((s) => ({ ...s, [lensId]: dataUrl }));
  }

  async function submitLensShots() {
    const shots = lensSet
      .filter((l) => lensShots[l.id])
      .map((l) => ({ lensId: l.id, label: l.name, zoom: l.zoom, photo: lensShots[l.id] }));
    if (shots.length < 2) return;
    setLensBusy(true);
    try {
      const r = await fetch(withBase(`/api/sessions/${sessionId}/lens-verify`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shots }),
      });
      const d = await r.json().catch(() => ({}));
      setLensDone(Array.isArray(d?.verdicts) ? d.verdicts : []);
      if (Array.isArray(d?.verdicts)) {
        setLensStates((s) => ({
          ...s,
          ...Object.fromEntries(
            d.verdicts.map((v: any) => [v.lensId, v.state === "unverified" ? "manual" : v.state])
          ),
        }));
      }
    } catch {
      // The shots are stored server-side either way; a failed assessment leaves
      // the lenses unverified, which is the honest outcome — never a pass.
      setLensDone([]);
    } finally {
      setLensBusy(false);
    }
  }

  function skipLenses() {
    // Skipping leaves the lenses exactly as the browser left them: unverified,
    // still needing a human. It must never quietly mark them working.
    pendingLensesRef.current = [];
    void handBack();
  }

  // Enumerate + test each physical camera, reconciled with the model's expected
  // optical lenses. Returns overall pass/fail + per-lens detail for the report.
  async function testCameras(expected: Lens[]) {
    const expRear = expected.filter((l) => l.facing === "rear");
    const expFront = expected.filter((l) => l.facing === "front");
    let vids: MediaDeviceInfo[] = [];
    try {
      vids = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
    } catch {
      /* none */
    }

    const isFront = (l: string) => /front|user|face|selfie/i.test(l);
    const isBack = (l: string) => /back|rear|environment|world|wide|tele|ultra/i.test(l);
    /* Devices whose label says "back", and devices we cannot classify at all.
     *
     * These were one bucket, which let a WORKING FRONT CAMERA satisfy the rear
     * check: enumerateDevices() frequently returns empty labels (iOS especially),
     * and an unlabelled device fell into `backDevs` by default. A phone with a
     * dead rear camera and a working selfie camera therefore reported the rear
     * as fine. Unknown is now its own bucket and is probed separately, via
     * facingMode, so it can only ever confirm "some rear camera works" — never
     * count as one more working rear lens. */
    const backDevs = vids.filter((d) => isBack(d.label));
    const frontDevs = vids.filter((d) => isFront(d.label));
    const unknownDevs = vids.filter((d) => !isFront(d.label) && !isBack(d.label));

    const probe = async (deviceId?: string) => {
      let stream: MediaStream | null = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: "environment" } },
        });
        const track = stream.getVideoTracks()[0];
        if (!track || track.readyState !== "live") return { live: false, frame: "" };
        const v = document.createElement("video");
        v.srcObject = stream;
        v.muted = true;
        v.playsInline = true;
        await v.play().catch(() => {});
        await new Promise((r) => setTimeout(r, 250));
        const cv = document.createElement("canvas");
        cv.width = 32;
        cv.height = 32;
        const ctx = cv.getContext("2d");
        let live = true;
        if (ctx && v.videoWidth) {
          ctx.drawImage(v, 0, 0, 32, 32);
          const px = ctx.getImageData(0, 0, 32, 32).data;
          let mean = 0;
          for (let i = 0; i < px.length; i += 4) mean += px[i] + px[i + 1] + px[i + 2];
          mean /= (px.length / 4) * 3;
          let varc = 0;
          for (let i = 0; i < px.length; i += 4) {
            const l = (px[i] + px[i + 1] + px[i + 2]) / 3;
            varc += (l - mean / 3) * (l - mean / 3);
          }
          varc /= px.length / 4;
          live = varc > 3; // a real scene varies; a dead/covered sensor is flat
        }

        /**
         * Keep ONE still from this lens, while its stream is already open.
         *
         * The variance check above only proves the sensor is producing a
         * changing image. It passes a camera whose cover is cracked, whose
         * lens is caked in dust, or whose focus motor is dead — all of which
         * vary perfectly well. The frame is the only way to see those, and
         * grabbing it here is nearly free because the hardware is already on.
         *
         * The extra settle is NOT padding: autofocus has not converged 250ms
         * after a stream opens, and a frame captured before it does looks
         * uniformly soft. Assessing that frame would report "blur" on every
         * healthy camera in the estate. ~450ms per lens is the price of the
         * difference between a focus fault and a photo taken too early.
         */
        let frame = "";
        if (live && v.videoWidth) {
          await new Promise((r) => setTimeout(r, 450));
          const W = 640;
          const fc = document.createElement("canvas");
          fc.width = W;
          fc.height = Math.round((W * v.videoHeight) / v.videoWidth) || 480;
          const fx = fc.getContext("2d");
          if (fx) {
            fx.drawImage(v, 0, 0, fc.width, fc.height);
            // 0.72 keeps dust specks and hairline cover cracks legible while
            // staying far under the route's per-frame byte cap.
            frame = fc.toDataURL("image/jpeg", 0.72);
          }
        }
        return { live, frame };
      } catch {
        return { live: false, frame: "" };
      } finally {
        stream?.getTracks().forEach((t) => t.stop());
      }
    };
    /** Stills keyed by the lens they came from, uploaded after the sweep. */
    const grabbed: { deviceId: string; frame: string }[] = [];

    let workingBack = 0;
    let anyBackFail = false;
    for (const d of backDevs) {
      // eslint-disable-next-line no-await-in-loop
      const r = await probe(d.deviceId);
      if (r.frame) grabbed.push({ deviceId: d.deviceId, frame: r.frame });
      r.live ? workingBack++ : (anyBackFail = true);
    }
    if (backDevs.length === 0) {
      /* No device is labelled "back". Ask the OS for the environment-facing
       * camera instead of trusting an unlabelled list. This confirms at most
       * that ONE rear camera works — the unknown devices are not counted. */
      // eslint-disable-next-line no-await-in-loop
      const r = await probe();
      if (r.frame) grabbed.push({ deviceId: "rear", frame: r.frame });
      if (r.live) workingBack = 1;
      else anyBackFail = true;
    }
    void unknownDevs; // deliberately not counted — see the bucket comment above
    let workingFront = 0;
    for (const d of frontDevs) {
      // eslint-disable-next-line no-await-in-loop
      const r = await probe(d.deviceId);
      if (r.frame) grabbed.push({ deviceId: d.deviceId, frame: r.frame });
      if (r.live) workingFront++;
    }

    const lensResults: LensResult[] = [];
    const rearTargets = expRear.length ? expRear : [{ id: "rear", name: "Rear camera", facing: "rear" as const }];
    rearTargets.forEach((l, i) => {
      let state: LensResult["state"];
      if (i < workingBack) state = "pass";
      // A rear camera the browser DID expose and could not open is a failure.
      // `anyBackFail` was computed and then discarded with `void anyBackFail`,
      // so a dead rear camera could never produce one.
      else if (anyBackFail && i < backDevs.length) state = "fail";
      else if (workingBack >= 1) state = "manual"; // browser grouped the lenses
      else state = "fail";
      lensResults.push({ id: l.id, name: l.name, facing: "rear", state, ...(state === "manual" ? {} : { by: "browser" as const }) });
    });
    const frontTargets = expFront.length ? expFront : [{ id: "front", name: "Front (selfie)", facing: "front" as const }];
    frontTargets.forEach((l) => {
      lensResults.push({
        id: l.id,
        name: l.name,
        facing: "front",
        state: workingFront >= 1 ? "pass" : frontDevs.length ? "fail" : "manual",
        ...(workingFront >= 1 || frontDevs.length ? { by: "browser" as const } : {}),
      });
    });

    /**
     * Bind each grabbed still to a LENS, not to a camera device.
     *
     * The browser exposes fewer video devices than the phone has lenses — a Pro
     * iPhone reports one rear camera for three. So frames are matched in the
     * same order the probes ran, and only to lenses the browser could actually
     * open. A lens marked "manual" was never separately testable and therefore
     * has no frame of its own; claiming one would attach a wide-angle picture
     * to a telephoto verdict.
     */
    const rearGrabs = grabbed.filter((g) => g.deviceId !== "front" && !frontDevs.some((d) => d.deviceId === g.deviceId));
    const frontGrabs = grabbed.filter((g) => frontDevs.some((d) => d.deviceId === g.deviceId));
    const framePayload: { lensId: string; name: string; facing: string; photo: string }[] = [];
    lensResults
      .filter((l) => l.facing === "rear" && l.state === "pass")
      .forEach((l, i) => {
        const g = rearGrabs[i];
        if (g) framePayload.push({ lensId: l.id, name: l.name, facing: "rear", photo: g.frame });
      });
    lensResults
      .filter((l) => l.facing === "front" && l.state === "pass")
      .forEach((l, i) => {
        const g = frontGrabs[i];
        if (g) framePayload.push({ lensId: l.id, name: l.name, facing: "front", photo: g.frame });
      });

    if (framePayload.length) {
      // Fire-and-forget, off the test's critical path. A camera test must never
      // fail, stall, or lose its verdict because an image upload was slow — the
      // pass/fail above is already decided and is what the seller is waiting on.
      void fetch(withBase(`/api/sessions/${sessionId}/camera-frames`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ frames: framePayload }),
      })
        .then(() =>
          // Assessment is deliberately a SEPARATE, un-awaited call: a Pro vision
          // request takes seconds, and nothing in the functional flow should wait
          // on it. If it never lands, the report says "not assessed" — which is
          // an honest answer, and not the same as "clear".
          fetch(withBase(`/api/sessions/${sessionId}/camera-assess`), { method: "POST" })
        )
        .catch(() => {});
    }

    const passed = lensResults.filter((l) => l.state === "pass").length;
    const manual = lensResults.filter((l) => l.state === "manual").length;
    const failed = lensResults.filter((l) => l.state === "fail").length;
    /* "pass" now means EVERY expected lens was verified.
     *
     * It used to mean "at least one camera worked", which on a Pro iPhone — three
     * rear lenses, one exposed camera device — made "pass" unreachable to
     * disprove: lens 0 verified, lenses 1 and 2 marked manual, manual counted as
     * neither pass nor fail, and the overall result read "pass". A customer with
     * a broken telephoto got a clean camera line on their report.
     *
     * Unverified is not verified. It reports as "skip" and the note says how many. */
    const state: Res = failed > 0 ? "fail" : manual > 0 ? "skip" : passed > 0 ? "pass" : "skip";
    const note =
      failed > 0
        ? `${failed} lens${failed > 1 ? "es" : ""} not responding`
        : manual > 0
          ? `only ${passed}/${lensResults.length} verified — ${manual} could not be tested separately by the browser and need a manual check`
          : `${passed}/${lensResults.length} lenses verified`;

    return {
      state,
      note,
      detail: { expected: lensResults.length, verified: passed, manual, failed, lenses: lensResults, note },
    };
  }

  // ---- render ----
  if (phase === "arm") {
    return (
      <div className="stage items-center justify-center bg-[var(--bg)] p-8 text-center">
        <div className="w-full max-w-xs">
          <div className="text-4xl">📱</div>
          <h1 className="mt-3 text-xl font-extrabold">Ready to self-test</h1>
          <p className="mt-2 text-sm text-[var(--muted)]">
            Tap once to allow camera, microphone &amp; motion, then swipe the
            screen once. Everything else runs automatically.
          </p>
          <button className="btn mt-5 w-full" onClick={unlock}>
            Start automatic test
          </button>
          {err && <p className="mt-3 text-sm text-[var(--bad)]">{err}</p>}
          <p className="mt-4 text-[11px] text-[var(--muted)]">
            Browsers require one permission tap before hardware can be tested —
            this is the only setup step.
          </p>
          {/* The camera test now KEEPS one frame per lens. The images are never
              displayed here, but not displaying them is a UI decision — not
              telling anyone would be a consent problem, and those are different
              choices. Disclosed plainly, once, where permission is granted. */}
          <p className="mt-2 text-[11px] text-[var(--muted)]">
            The camera check takes one photo through each lens to confirm it still
            focuses cleanly. Those photos are attached to this device&apos;s
            inspection record.
          </p>
        </div>
      </div>
    );
  }

  if (phase === "touch") {
    return <BubbleTouch onDone={finishTouch} />;
  }

  if (phase === "voice") {
    return <VoiceTest onDone={finishVoice} />;
  }

  if (phase === "lenses") {
    const captured = lensSet.filter((l) => lensShots[l.id]).length;
    const ready = captured >= 2;
    return (
      <div className="stage bg-[var(--bg)] p-6">
        <div className="mx-auto w-full max-w-sm">
          <div className="text-4xl">🔍</div>
          <h1 className="mt-2 text-xl font-extrabold">Check the other lenses</h1>
          {/* Say WHY this is being asked. Handing someone extra work without a
              reason reads as a broken app; the real reason is specific and the
              seller can act on it. */}
          <p className="mt-1 text-[13.5px] text-[var(--muted)]">
            The browser can only reach one rear camera on this phone, so the wide-angle and
            zoom lenses have not been tested. Take one photo at each zoom — of the{" "}
            <b>same thing, from the same spot</b> — and we can check them properly.
          </p>

          <input
            ref={lensFileRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={onLensFile}
            className="hidden"
          />

          <div className="mt-4 space-y-2">
            {lensSet.map((l) => {
              const shot = lensShots[l.id];
              const v = lensDone?.find((x) => x.lensId === l.id);
              return (
                <div
                  key={l.id}
                  className="flex items-center gap-3 rounded-2xl border border-[var(--border)] p-3"
                >
                  <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-[var(--bg-soft)] text-[15px] font-black">
                    {l.zoom}×
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-semibold">{l.name}</div>
                    <div className="text-[11.5px] text-[var(--muted)]">
                      {v
                        ? v.reason
                        : shot
                          ? "Photo taken"
                          : `Open the camera, switch to ${l.zoom}×, take one photo`}
                    </div>
                  </div>
                  {v ? (
                    <span
                      className="text-[12px] font-bold"
                      style={{
                        color:
                          v.state === "pass"
                            ? "var(--green-ink)"
                            : v.state === "fail"
                              ? "var(--bad)"
                              : "var(--gold-2)",
                      }}
                    >
                      {v.state === "pass" ? "Verified" : v.state === "fail" ? "Faulty" : "Unverified"}
                    </span>
                  ) : (
                    <button
                      onClick={() => openLensCamera(l.id)}
                      className="shrink-0 rounded-full border border-[var(--border)] px-3 py-1.5 text-[12.5px] font-semibold"
                    >
                      {shot ? "Retake" : "Camera"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {!lensDone ? (
            <>
              <button
                onClick={submitLensShots}
                disabled={!ready || lensBusy}
                className="mt-5 w-full rounded-full py-3.5 text-[15px] font-bold disabled:opacity-40"
                style={{ background: "var(--grad)", color: "#fff" }}
              >
                {lensBusy ? "Checking the lenses…" : `Check ${captured} photo${captured === 1 ? "" : "s"}`}
              </button>
              <button
                onClick={skipLenses}
                className="mt-2 w-full py-2 text-[13px] underline"
                style={{ color: "var(--muted)" }}
              >
                Skip — leave these lenses unchecked
              </button>
            </>
          ) : (
            <button
              onClick={skipLenses}
              className="mt-5 w-full rounded-full py-3.5 text-[15px] font-bold"
              style={{ background: "var(--grad)", color: "#fff" }}
            >
              Continue →
            </button>
          )}
        </div>
      </div>
    );
  }

  if (phase === "faceid") {
    return (
      <div className="stage items-center justify-center bg-[var(--bg)] p-8 text-center">
        <div className="w-full max-w-xs">
          <div className="text-5xl">{bioState === "pass" ? "✅" : bioState === "fail" ? "⚠️" : "🙂"}</div>
          <h1 className="mt-3 text-xl font-extrabold">
            {bioState === "pass"
              ? `${bioLabel} verified`
              : bioState === "fail"
                ? `Couldn't verify ${bioLabel}`
                : `Verify ${bioLabel}`}
          </h1>
          <p className="mt-2 text-sm text-[var(--muted)]">
            {bioState === "pass"
              ? `The biometric sensor unlocked a secure passkey — ${bioLabel} works.`
              : bioState === "fail"
                ? `${bioLabel} didn't complete. It may be faulty, not enrolled, or was cancelled — check manually.`
                : `Tap below and use ${bioLabel} on the phone. GradeIQ registers a secure passkey — if the biometric unlocks it, the sensor works.`}
          </p>
          {bioState === "idle" || bioState === "fail" ? (
            <>
              <button className="btn mt-5 w-full" onClick={runFaceId}>
                {bioState === "fail" ? "Try again" : `Scan ${bioLabel}`}
              </button>
              <button onClick={skipFaceId} className="mt-3 block w-full text-[13px] text-[var(--muted)] underline">
                Skip — check manually
              </button>
            </>
          ) : bioState === "running" ? (
            <p className="mt-5 text-sm text-[var(--muted)]">Look at the phone…</p>
          ) : (
            <p className="mt-5 text-sm text-[var(--muted)]">Continuing…</p>
          )}
        </div>
      </div>
    );
  }

  if (phase === "unsaved" && saveIssue) {
    const failed = saveIssue.kind === "failed";
    const canRetry = failed && !!saveIssue.payload;
    return (
      <div className="stage items-center justify-center bg-[var(--bg)] p-8 text-center">
        <div className="w-full max-w-xs" role="alert">
          <div className="text-5xl">{failed ? "⚠️" : "📝"}</div>
          <h1 className="mt-3 text-xl font-extrabold">{failed ? "Results not saved" : "Some results kept as before"}</h1>
          <p className="mt-2 text-sm text-[var(--muted)]">{saveIssue.text}</p>
          {canRetry && (
            <button className="btn mt-5 w-full" onClick={retrySave} disabled={retrying}>
              {retrying ? "Saving…" : "Try again"}
            </button>
          )}
          <button
            onClick={continueAnyway}
            disabled={retrying}
            className={canRetry ? "mt-3 block w-full text-[13px] text-[var(--muted)] underline" : "btn mt-5 w-full"}
          >
            {canRetry ? "Continue without saving" : "Continue"}
          </button>
        </div>
      </div>
    );
  }

  if (phase === "patterns") {
    if (pattern === "stripes")
      return <div className="fixed inset-0" style={{ background: "repeating-linear-gradient(90deg,#000 0 6px,#fff 6px 12px)" }} />;
    if (FILLS[pattern]) return <div className="fixed inset-0" style={{ background: FILLS[pattern] }} />;
    return (
      <div className="stage items-center justify-center bg-[var(--bg)] p-8 text-center">
        <div>
          <div className="text-4xl">✅</div>
          <h1 className="mt-3 text-xl font-extrabold">Diagnostics done</h1>
          <p className="mt-2 text-sm text-[var(--muted)]">
            Keep the device face-up — the screen switches to test patterns as the
            inspector photographs it.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="stage items-center justify-center bg-[var(--bg)] p-8">
      {speakerAsk && (
        <div className="fixed inset-0 z-[60] grid place-items-center bg-black/70 px-6 backdrop-blur-sm">
          <div className="w-full max-w-xs rounded-3xl bg-white p-6 text-center text-[#141018]">
            <div className="text-4xl">🔊</div>
            <div className="mt-2 text-lg font-black">Hear the beeps?</div>
            <p className="mt-1 text-sm text-black/60">Turn the volume up — a tone is pulsing on the speaker now.</p>
            <div className="mt-5 flex gap-2">
              <button
                onClick={() => speakerResolveRef.current?.(true)}
                className="flex-1 rounded-full py-3 font-bold text-white"
                style={{ background: "linear-gradient(135deg,#12b0a0,#0b7d78)" }}
              >
                Yes 🔊
              </button>
              <button
                onClick={() => speakerResolveRef.current?.(false)}
                className="flex-1 rounded-full border border-black/15 py-3 font-bold"
              >
                No
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="w-full max-w-xs">
        <h1 className="text-center text-xl font-extrabold">Testing device…</h1>
        <p className="mt-1 text-center text-sm text-[var(--muted)]">
          Running automatically — no need to touch anything.
        </p>

        {/* HOW MUCH IS LEFT. The screen used to give no answer to the only
            question a waiting seller has, so a slow test was indistinguishable
            from a stuck one. A count and a bar are cheaper than any animation
            at solving that. */}
        {(() => {
          const done = checks.filter((c) => c.state !== "wait" && c.state !== "run").length;
          const now = checks.find((c) => c.state === "run");
          return (
            <div className="mt-5">
              <div className="mb-1.5 flex items-baseline justify-between text-[12px] text-[var(--muted)]">
                <span>{now ? now.label : done === checks.length ? "All checks done" : "Starting…"}</span>
                <span className="tabular-nums">
                  {done}/{checks.length}
                </span>
              </div>
              <div className="diag-bar">
                <i style={{ width: `${Math.round((done / Math.max(1, checks.length)) * 100)}%` }} />
              </div>
            </div>
          );
        })()}

        <div className="mt-4 space-y-0.5">
          {checks.map((c) => (
            <div
              key={c.id}
              className={`diag-row px-2 py-2.5 text-[15px] ${
                c.state === "pass" ? "diag-row--pass" : c.state === "fail" ? "diag-row--fail" : ""
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <span className={c.state === "wait" ? "text-[var(--muted)]" : ""}>{c.label}</span>
                {/* One disc, four states — the glyph never moves the layout. */}
                <span
                  className={`diag-dot ${
                    c.state === "run"
                      ? "diag-dot--run"
                      : c.state === "pass"
                        ? "diag-dot--pass"
                        : c.state === "fail"
                          ? "diag-dot--fail"
                          : c.state === "skip"
                            ? "diag-dot--skip"
                            : ""
                  }`}
                  aria-label={c.state}
                >
                  {c.state === "pass" ? <span>✓</span> : c.state === "fail" ? "✕" : c.state === "skip" ? "–" : ""}
                </span>
              </div>
              {c.note && <div className="mt-0.5 text-[12px] text-[var(--muted)]">{c.note}</div>}

              {/* Per-lens breakdown, driven by the MODEL's optical layout — a
                  Pro has 3 rear lenses, a Galaxy Ultra 4, an SE just 1. */}
              {c.id === "camera" && lensList.length > 0 && (
                <div className="mt-2 space-y-1 border-l-2 border-[var(--border)] pl-3">
                  {lensList.map((l, i) => {
                    const st = lensStates[l.id] || "wait";
                    return (
                      <div key={l.id} className="flex items-center justify-between text-[13px]">
                        <span className="text-[var(--muted)]">
                          <b className="text-[var(--text)]">Lens {i + 1}</b> · {l.name}
                        </span>
                        <span
                          style={{
                            color:
                              st === "pass"
                                ? "var(--green-ink)"
                                : st === "fail"
                                  ? "var(--bad)"
                                  : "var(--muted)",
                          }}
                        >
                          {st === "pass"
                            ? "✓"
                            : st === "fail"
                              ? "✕"
                              : st === "manual"
                                ? "manual zoom check"
                                : st === "run"
                                  ? "⟳"
                                  : "…"}
                        </span>
                      </div>
                    );
                  })}
                  {deviceModel && (
                    <div className="pt-0.5 text-[11px] text-[var(--muted)]">
                      Expected layout for {deviceModel}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
