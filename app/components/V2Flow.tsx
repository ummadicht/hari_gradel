"use client";
import { useEffect, useRef, useState } from "react";
import { withBase } from "@/lib/basePath";
import DeviceTest from "./DeviceTest";
import QR from "./QR";
import ImeiScanner from "./ImeiScanner";
import { isLiveImeiSource } from "@/lib/imeiSource";
import { themeFor, themeVars } from "@/lib/clientTheme";
import { StepShell } from "./v2/StepChrome";
import {
  PhoneIdIllustration,
  TwoDeviceIllustration,
} from "./v2/Illustrations";
import BatteryExampleShot from "./v2/BatteryExampleShot";
import ManualDevicePicker, { DeviceIdFailed, type ManualPick } from "./v2/ManualDevicePicker";
import OfflineBanner from "./v2/OfflineBanner";
import SessionResume, { loadProgress, saveProgress, clearProgress, type V2Progress } from "./v2/SessionResume";
import type { ChannelConfig } from "@/lib/journeyTypes";

// ── GradeIQ v2 — the guided inspection (Pandas-style, device-centric)
// The phone being traded identifies itself (IMEI), then a SECOND device films it
// (QR handoff → V2Cam) for cosmetics, the screen dead-pixel sweep and Settings
// OCR; this phone then runs its own browser hardware tests and shows the offer.
//
// The mirror/front-camera path was REMOVED: a phone can't film its own screen or
// Settings, so it could never reach full coverage, and front-camera-through-a-
// mirror frames graded poorly. Two devices is now the only cosmetic route.
//
// Theming is PER CLIENT (lib/clientTheme.ts) — ?client=swapmore renders light +
// SwapMore-branded inside swapmore.com/buyback; default stays dark GradeIQ.
//
// REAL, not theatrical: cosmetic frames are quality-gated locally (sharp/lit)
// and graded by LIVE Gemini in production. IMEI resolves make/model server-side.

type Phase = "intro" | "identify" | "identifying" | "await2nd" | "battery" | "functional" | "offer";

const STEPS = [
  { key: "id", label: "Identity", phases: ["identify", "identifying"] },
  { key: "cos", label: "Cosmetic", phases: ["await2nd", "battery"] },
  { key: "fn", label: "Functional", phases: ["functional"] },
  { key: "offer", label: "Result", phases: ["offer"] },
];

// Where to find Battery Health, per platform — model-aware, including the DIAL
// CODE where one exists (Samsung/Android expose battery data through a service
// menu; iOS has none, so we must not invent one).
type BatteryGuide = {
  platform: "ios" | "samsung" | "pixel" | "android";
  title: string;
  steps: string[];
  note: string;
  command: string | null; // dial code, when the platform actually has one
  commandNote: string;
};

function batteryGuide(brand: string, model: string): BatteryGuide {
  const s = `${brand} ${model}`.toLowerCase();
  if (/apple|iphone|ipad|ipod/.test(s))
    return {
      platform: "ios",
      title: "iPhone · Battery Health",
      steps: ["Open Settings", "Tap Battery", "Tap Battery Health & Charging", "Screenshot the Maximum Capacity %"],
      note: "Settings ▸ Battery ▸ Battery Health & Charging → Maximum Capacity",
      command: null, // iOS has no battery dial code — only *#06# for the IMEI
      commandNote: "iPhones have no battery dial code — use the Settings path above.",
    };
  if (/samsung|galaxy/.test(s))
    return {
      platform: "samsung",
      title: "Samsung · Battery Health",
      steps: ["Open the Phone dialler", "Type the code below (it opens instantly)", "Find Battery status / capacity", "Screenshot it"],
      note: "Or: Settings ▸ Battery and device care ▸ Battery ▸ Diagnostics (One UI 6+: Battery health).",
      command: "*#0228#",
      commandNote: "Opens Samsung's battery status (voltage, temperature, capacity).",
    };
  if (/pixel|google/.test(s))
    return {
      platform: "pixel",
      title: "Pixel · Battery Health",
      steps: ["Open Settings", "Tap Battery", "Tap Battery health", "Screenshot the estimated capacity %"],
      note: "Pixel 8 and newer show estimated capacity directly in Settings.",
      command: "*#*#4636#*#*",
      commandNote: "Older Pixels: this opens Testing ▸ Battery information.",
    };
  return {
    platform: "android",
    title: "Android · Battery Health",
    steps: ["Open the Phone dialler", "Type the code below", "Tap Battery information", "Screenshot the health / capacity"],
    note: "No luck? Settings ▸ Battery / Device care, or install AccuBattery and screenshot it.",
    command: "*#*#4636#*#*",
    commandNote: "Opens Android's hidden Testing menu ▸ Battery information.",
  };
}

const FILLS: Record<string, string> = { white: "#fff", gray: "#808080", black: "#000", red: "#f00", green: "#0f0", blue: "#00f" };


export default function V2Flow() {
  const [sessionId, setSessionId] = useState("");
  const [phase, setPhase] = useState<Phase>("intro");
  const [imeiInput, setImeiInput] = useState("");
  const [brand, setBrand] = useState("");
  const [model, setModel] = useState("");
  const [valSteps, setValSteps] = useState<number>(0);
  const [identity, setIdentity] = useState<any>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [value, setValue] = useState<any>(null);
  const [trust, setTrust] = useState<any>(null);
  const [origin, setOrigin] = useState("");
  const [connected2nd, setConnected2nd] = useState(false);
  const [primaryPattern, setPrimaryPattern] = useState("idle");
  const [ocrBusy, setOcrBusy] = useState(false);
  const [batteryPct, setBatteryPct] = useState<number | null>(null); // read off the uploaded battery screenshot
  const [batteryBusy, setBatteryBusy] = useState(false);
  const [clientId, setClientId] = useState("default"); // tenant → theme + pricing
  /**
   * WHO OWNS THE PRICE.
   *
   * On the consumer journey GradeIQ quotes the device itself. At a counter it
   * must not: the desk computes its own offer from the store's book, faults and
   * all, so showing GradeIQ's number here puts two different prices in front of
   * one customer — and the one they read first is the one they argue from.
   *
   * Retail therefore ends on the GRADE. The counter presents the money.
   */
  const [channel, setChannel] = useState("consumer");
  const [resume, setResume] = useState<V2Progress | null>(null); // "Welcome back" gate
  const [showManual, setShowManual] = useState(false); // manual brand/model picker
  const [idFailed, setIdFailed] = useState(false); // IMEI lookup couldn't identify the device
  const [scanning, setScanning] = useState(false); // ZXing barcode scanner (works with no AI)
  const fileRef = useRef<HTMLInputElement>(null);
  const batteryFileRef = useRef<HTMLInputElement>(null);
  // In-flight battery-screenshot read, so Skip can cancel it rather than let it
  // finish into a step the seller has already left.
  const batteryAbortRef = useRef<AbortController | null>(null);
  useEffect(() => setOrigin(window.location.origin), []);
  // Tenant from the embed (?client=swapmore) drives BOTH the theme and the pricing;
  // then offer to resume an unfinished journey (Pandas-style "Welcome back").
  // Tenant journey config (super-admin portal): phase toggles + copy overrides.
  const [jcfg, setJcfg] = useState<ChannelConfig | null>(null);
  const jcfgRef = useRef<ChannelConfig | null>(null);
  useEffect(() => {
    const qs = new URLSearchParams(window.location.search);
    const c = qs.get("client") || "default";
    setClientId(c);

    // SESSION HANDOFF (?session=<id>): counter / employee journey already opened
    // a GradeIQ session. We ADOPT it and continue the guided v2 assessment.
    //
    // Retail channel (CounterIQ desk QR): still run IMEI photo verify → cosmetics
    // handoff → battery screenshot → functional tests (not the legacy /s gauntlet).
    // Other handoffs skip identify and land on cosmetics (await2nd).
    const injected = qs.get("session");
    const channelQs = qs.get("channel") || "";
    if (channelQs) setChannel(channelQs);
    if (injected) {
      fetch(withBase(`/api/sessions/${injected}`))
        .then((r) => (r.ok ? r.json() : null))
        .then((sess) => {
          if (!sess?.id) return;
          const sc = sess.client_id || c;
          setClientId(sc);
          setSessionId(sess.id);
          setBrand((sess.imei_info?.brand as string) || "");
          setModel(sess.model || (sess.imei_info?.model as string) || "");
          const imeiDigits = String(sess.imei || "").replace(/\D/g, "");
          if (imeiDigits.length === 15) setImeiInput(imeiDigits);
          const ch = channelQs || sess.profile?.channel || "consumer";
          setChannel(ch);
          // Retail desk: customer does full v2 checks (IMEI photo, battery, functional)
          // after confirm; other handoffs jump to cosmetics.
          setPhase(ch === "retail" ? "identify" : "await2nd");
          fetch(withBase(`/api/journey/${sc}/${ch}`))
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => {
              if (d?.config) {
                setJcfg(d.config);
                jcfgRef.current = d.config;
              }
            })
            .catch(() => {});
        })
        .catch(() => {});
      return; // skip the consumer resume/intro path entirely
    }

    const p = loadProgress(c);
    if (p) setResume(p);
    fetch(withBase(`/api/journey/${c}/consumer`))
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.config) {
          setJcfg(d.config);
          jcfgRef.current = d.config;
        }
      })
      .catch(() => {});
  }, []);
  // Persist progress so a reload/return lands on the resume gate instead of step 1.
  useEffect(() => {
    if (!sessionId || phase === "intro" || phase === "offer") return;
    saveProgress(clientId, { sessionId, phase, model: model || undefined, at: Date.now() });
  }, [clientId, sessionId, phase, model]);

  // Audit trail: report each phase the SELLER reaches, so the console's PATH
  // shows real dwell time ("battery · stayed for 42s") rather than only the
  // moments the server happened to be called.
  useEffect(() => {
    if (!sessionId) return;
    const STEP: Record<string, string> = {
      intro: "layout",
      identify: "device-identification",
      identifying: "device-identification",
      await2nd: "cosmetics",
      battery: "battery",
      functional: "functional-tests",
      offer: "offer",
    };
    const step = STEP[phase];
    if (!step) return;
    fetch(withBase(`/api/sessions/${sessionId}/event`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ step, event: "enter", detail: { phase } }),
    }).catch(() => {});
  }, [sessionId, phase]);

  // Grace timer — how long the primary has seen cosmeticDone (photos accepted)
  // without the 2nd phone signalling handoffDone (it's still driving the display
  // sweep). Lets us advance if the camera phone dies mid-sweep, without leaving
  // the primary hung.
  const doneSinceRef = useRef<number | null>(null);

  // Second-device mode: poll for the camera phone connecting + finishing, and
  // mirror its pattern commands (so it can capture the display test in sync).
  useEffect(() => {
    if (phase !== "await2nd" || !sessionId) return;
    doneSinceRef.current = null;
    // Tenant config decides whether the battery-screenshot step runs.
    const advance = () =>
      setPhase(jcfgRef.current?.phases?.battery === false ? "functional" : "battery");
    const t = setInterval(async () => {
      try {
        const d = await fetch(withBase(`/api/sessions/${sessionId}/screen`)).then((r) => r.json());
        if (d.connectedAt) setConnected2nd(true);
        setPrimaryPattern(d.pattern || "idle");
        // Advance ONLY when the camera phone is FULLY done (handoffDone) — not
        // merely when the photos were accepted (cosmeticDone). The display sweep
        // runs AFTER /cosmetic sets cosmeticDone, and the sweep needs THIS screen
        // to keep flashing white/green, so the primary must stay in await2nd
        // (driving patterns) until the camera signals it's done. Safety net: if
        // the camera dies mid-sweep and never sends handoffDone, advance after a
        // grace so the primary can't hang here forever.
        if (d.handoffDone) {
          clearInterval(t);
          advance();
        } else if (d.cosmeticDone) {
          if (doneSinceRef.current == null) doneSinceRef.current = Date.now();
          else if (Date.now() - doneSinceRef.current > 30000) {
            clearInterval(t);
            advance();
          }
        }
      } catch { /* ignore */ }
    }, 700);
    return () => clearInterval(t);
  }, [phase, sessionId]);

  // Echo which pattern THIS (primary) screen is showing, so the camera phone
  // captures it in sync.
  useEffect(() => {
    if (phase !== "await2nd") return;
    fetch(withBase(`/api/sessions/${sessionId}/screen`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shown: primaryPattern }),
    }).catch(() => {});
  }, [primaryPattern, phase, sessionId]);


  // ── Step 1: Identify (IMEI → resolve make/model server-side) ──
  const imeiValid = imeiInput.replace(/\D/g, "").length === 15;
  async function identify() {
    if (!imeiValid) return;
    setBusy(true);
    setErr("");
    setPhase("identifying");
    setValSteps(0);
    setIdentity(null);
    let info: any = null;
    try {
      // Per-tenant: ?client=swapmore on the embed → this session prices from SwapMore's book.
      const qs2 = new URLSearchParams(window.location.search);
      const client = qs2.get("client") || undefined;
      const channel = qs2.get("channel") || undefined;
      const purchase = qs2.get("purchase") || undefined;
      const imei = imeiInput.replace(/\D/g, "");

      // Retail / employee handoff: session already exists (CounterIQ desk) —
      // reuse it so the purchase stays linked; seller can still re-confirm IMEI
      // via photo upload / barcode before continuing to battery + functional.
      if (sessionId) {
        const existing = await fetch(withBase(`/api/sessions/${sessionId}`)).then((r) =>
          r.ok ? r.json() : null
        );
        info = existing?.imei_info || existing?.imeiInfo || { valid: imei.length === 15 };
        if (!info.imei) info = { ...info, imei, valid: imei.length === 15 };
        setIdentity(info);
        setBrand(info.brand || brand || "");
        setModel(existing?.model || info.model || model || "");
      } else {
        const r = await fetch(withBase("/api/sessions"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ segment: "c2b", imei, client, channel, purchase }),
        });
        const s = await r.json();
        setSessionId(s.id);
        info = s.imeiInfo || {};
        setIdentity(info);
        setBrand(info.brand || "");
        setModel(s.model || info.model || "");
      }
    } catch {
      // Lookup failed → offer the recovery paths (retry / pick manually / skip)
      // instead of dead-ending on the input screen.
      setErr("Couldn't reach the server — check your connection.");
      setBusy(false);
      setIdFailed(true);
      return;
    }
    // Reveal each REAL result one at a time (no fake "everything passed" timer).
    for (let i = 1; i <= 4; i++) {
      setValSteps(i);
      await wait(420);
    }
    setBusy(false);
  }

  // Real, per-step verdicts computed from the actual lookup — no fabrication.
  function idSteps() {
    const modelKnown = !!identity?.brand && !!(model || identity?.model) && !/unknown/i.test(model || identity?.model || "");
    const live = isLiveImeiSource(identity?.source) && identity?.blacklist && identity.blacklist !== "unknown";
    return [
      {
        label: "IMEI format (Luhn checksum)",
        state: identity?.valid ? "ok" : "bad",
        detail: identity?.valid ? "Valid" : "Invalid checksum",
      },
      {
        label: "TAC lookup (GSMA)",
        state: modelKnown ? "ok" : "warn",
        detail: modelKnown ? "Matched in database" : "Not in the local database",
      },
      {
        label: "Device details",
        state: modelKnown ? "ok" : "warn",
        detail: modelKnown ? [brand, model].filter(Boolean).join(" ") : "Model not identified",
      },
      {
        label: "Blacklist / lost-stolen",
        state: live ? (identity.blacklist === "clean" ? "ok" : "bad") : "na",
        detail: live
          ? identity.blacklist === "clean"
            ? "Clean"
            : "Reported blacklisted"
          : identity?.skipped
            ? "Not checked — this IMEI is unverified"
            : "Not checked — needs a live network lookup",
      },
    ];
  }

  // IMEI upload: OCR a *#06# / Settings screenshot to fill the IMEI (no typing).
  async function onImeiFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setOcrBusy(true);
    setErr("");
    try {
      const dataUrl: string = await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result));
        fr.onerror = rej;
        fr.readAsDataURL(file);
      });
      const r = await fetch(withBase("/api/imei/ocr"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ photo: dataUrl }),
      });
      const { imei, error } = await r.json();
      const digits = String(imei || "").replace(/\D/g, "");
      if (digits.length === 15) setImeiInput(digits);
      else {
        // Distinguish OUR problem from the seller's photo — an over-quota key
        // should send them to the barcode scanner, not make them retake a
        // perfectly good screenshot.
        const msg: Record<string, string> = {
          ai_quota: "Our photo reader is temporarily over its limit — scan the barcode instead, or type the IMEI.",
          ai_key: "Our photo reader isn't available right now — scan the barcode instead, or type the IMEI.",
          ai_not_configured: "Photo reading isn't enabled — scan the barcode instead, or type the IMEI.",
          not_found: "Couldn't find an IMEI in that image — try a clearer *#06# screenshot, or scan the barcode.",
          bad_image: "That file wasn't a readable image — try again.",
        };
        setErr(msg[String(error)] ?? "Couldn't read that image — scan the barcode or type the IMEI.");
      }
    } catch {
      setErr("Couldn't read the image. Try again, scan the barcode, or type the IMEI.");
    } finally {
      setOcrBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  // Battery-health screenshot → OCR the % off the Battery Health screen. A single
  // device can't film its own Settings, so we read an uploaded screenshot instead
  // (reuses the same Settings-OCR route the 2-device flow feeds).
  /**
   * Leave the battery step NOW.
   *
   * The step is optional, so the only correct response to "skip" is to stop —
   * including stopping the screenshot read that may still be in flight. Reading
   * the shot is a Gemini vision call taking seconds; without the abort it keeps
   * running after the seller has moved on, then lands `setBatteryPct` on a step
   * they already left (and bills a call nobody will look at).
   */
  function leaveBattery() {
    batteryAbortRef.current?.abort();
    batteryAbortRef.current = null;
    setBatteryBusy(false);
    setErr("");
    setPhase("functional");
  }

  async function onBatteryFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !sessionId) return;
    const ac = new AbortController();
    batteryAbortRef.current = ac;
    setBatteryBusy(true);
    setErr("");
    try {
      const dataUrl: string = await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result));
        fr.onerror = rej;
        fr.readAsDataURL(file);
      });
      const r = await fetch(withBase(`/api/sessions/${sessionId}/ocr`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ frames: [dataUrl] }),
        signal: ac.signal,
      });
      const d = await r.json().catch(() => ({} as any));
      const pct = d?.ocr?.batteryHealth ?? d?.session?.ocr?.batteryHealth ?? d?.batteryHealth ?? null;
      // >0 → show the read %. -1 → accepted but no number parsed (still feeds the passport).
      setBatteryPct(typeof pct === "number" && pct > 0 ? Math.round(pct) : -1);
    } catch (e: any) {
      // An abort is the seller skipping, not a failure — saying "couldn't read
      // that screenshot" would blame them for leaving.
      if (e?.name !== "AbortError") {
        setErr("Couldn't read that screenshot — try a clearer shot of the Battery Health screen.");
      }
    } finally {
      if (batteryAbortRef.current === ac) {
        batteryAbortRef.current = null;
        setBatteryBusy(false);
      }
      if (batteryFileRef.current) batteryFileRef.current.value = "";
    }
  }


  // ── Step 4: Offer ──
  async function loadOffer() {
    setPhase("offer");
    try {
      // Trust and bands are grading evidence and stay. The VALUE is fetched
      // only where GradeIQ is the one quoting — not fetching it at all is the
      // difference between hiding a number and never holding it.
      const d = await fetch(withBase(`/api/sessions/${sessionId}/value`)).then((r) => r.json());
      if (channel !== "retail") setValue(d.value);
      setTrust(d.trust);
    } catch {
      /* leave null */
    }
  }

  // ── render ──
  // Per-client theme: the swapmore tenant renders LIGHT + SwapMore-branded (it's
  // embedded in swapmore.com/buyback); the default GradeIQ client stays dark.
  // themeVars() mounts the --t-* custom properties every v2 component paints from.
  const theme = themeFor(clientId);
  const wrap = "min-h-[100dvh] w-full";
  const bg = themeVars(theme);
  const grad = theme.ctaBg;

  const rail = (
    <StepRail phase={phase} />
  );

  // ── Global gates: connection loss + "Welcome back" resume (Pandas-style) ──
  if (resume) {
    return (
      <div className={wrap} style={bg}>
        <OfflineBanner />
        <SessionResume
          progress={resume}
          onResume={() => {
            setSessionId(resume.sessionId);
            setPhase(resume.phase as Phase);
            setResume(null);
          }}
          onStartOver={() => {
            clearProgress(clientId);
            setResume(null);
          }}
        />
      </div>
    );
  }

  if (phase === "intro") {
    return (
      <div className={wrap} style={bg}>
        <OfflineBanner />
        <StepShell
          title={jcfg?.copy?.introTitle || "Trade in your device"}
          sub={jcfg?.copy?.tagline || theme.tagline}
          illustration={
            <div className="flex flex-col items-center gap-5">
              {theme.logoUrl ? (
                // The SwapMore wordmark is white-on-transparent (built for its dark
                // navbar), so on a LIGHT theme it needs its brand pill behind it —
                // the same pill-adaptive treatment swapmore.com uses.
                <span
                  className="inline-flex items-center rounded-full px-5 py-2.5"
                  style={{ background: theme.mode === "light" ? theme.accent : "transparent" }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={theme.logoUrl} alt={theme.brandName} className="h-7 w-auto" />
                </span>
              ) : (
                <div
                  className="grid h-14 w-14 place-items-center rounded-2xl text-xl font-black"
                  style={{ background: grad, color: theme.ctaText }}
                >
                  IQ
                </div>
              )}
              <PhoneIdIllustration />
            </div>
          }
          cta={{ label: "Let's start", enabled: true, onClick: () => setPhase("identify") }}
        >
          {/* Set expectations up front — the two things that most often cost a
              seller their grade are a case left on and a smeared screen. */}
          <div
            className="mx-auto mb-4 max-w-xs rounded-2xl px-4 py-3 text-left text-[12px]"
            style={{ background: "var(--t-soft, rgba(127,127,127,0.10))", color: "var(--t-muted)" }}
          >
            <span className="block font-bold" style={{ color: "var(--t-text)" }}>
              Have your phone ready
            </span>
            <span className="mt-1 block">
              Take off the case and any screen protector, and give the screen and back a quick wipe.
              A cover hides the real condition, so it can&apos;t be graded through one.
            </span>
          </div>
          <div
            className="flex items-center justify-center gap-2 text-[12px]"
            style={{ color: "var(--t-muted)" }}
          >
            <span>Identify</span><span>›</span><span>Scan</span><span>›</span><span>Test</span><span>›</span><span>Result</span>
          </div>
        </StepShell>
      </div>
    );
  }

  // ── Identification fallbacks: pick the device by hand, or recover from a failed
  //    IMEI lookup (Pandas offers exactly these two escapes). ──
  if (showManual) {
    return (
      <div className={wrap} style={bg}>
        <OfflineBanner />
        <ManualDevicePicker
          clientId={clientId}
          onCancel={() => setShowManual(false)}
          onPick={(v: ManualPick) => {
            setBrand(v.brand);
            setModel(v.model);
            /**
             * Keep the storage and colour the seller just told us.
             *
             * The picker asks four questions — brand, model, storage, colour —
             * and this handler used only the first two, so two of the four
             * answers were collected and dropped on the floor. They are not
             * recoverable from the IMEI (a TAC identifies make/model, never
             * capacity or finish), so the seller's own answer is the ONLY
             * source we have, and pricing and the sessions monitor both want it.
             */
            if (sessionId && (v.storage || v.color)) {
              fetch(withBase(`/api/sessions/${sessionId}/device`), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  device: { storageText: v.storage || "", color: v.color || "", source: "seller-picked" },
                  model: v.model,
                }),
              }).catch(() => {});
            }
            setShowManual(false);
            setIdFailed(false);
            setPhase("await2nd");
          }}
        />
      </div>
    );
  }
  if (idFailed) {
    return (
      <div className={wrap} style={bg}>
        <OfflineBanner />
        <DeviceIdFailed
          onRetry={() => {
            setIdFailed(false);
            setErr("");
            setPhase("identify");
          }}
          onManual={() => {
            setIdFailed(false);
            setShowManual(true);
          }}
          onSkip={() => {
            setIdFailed(false);
            setPhase("await2nd");
          }}
        />
      </div>
    );
  }

  // Barcode scan — pure client-side ZXing, so it keeps working when the AI photo
  // reader is unavailable (over quota / not configured).
  if (scanning) {
    return (
      <ImeiScanner
        onResult={(imei) => {
          setImeiInput(imei);
          setErr("");
          setScanning(false);
        }}
        onClose={() => setScanning(false)}
      />
    );
  }

  if (phase === "identify") {
    return (
      <div className={`${wrap} flex flex-col px-6`} style={bg}>
        {rail}
        <div className="mt-4">
          <h1 className="text-2xl font-extrabold">Device identification</h1>
          <p className="mt-1 text-[14px] text-[color:var(--t-muted)]">Enter the 15-digit IMEI — dial <span className="mono">*#06#</span> or find it in Settings ▸ General ▸ About.</p>
        </div>
        <input
          inputMode="numeric"
          value={imeiInput}
          onChange={(e) => setImeiInput(e.target.value.replace(/[^\d ]/g, "").slice(0, 19))}
          placeholder="IMEI"
          className="mono mt-6 w-full rounded-2xl bg-[var(--t-card)] px-4 py-4 text-center text-[20px] tracking-widest text-[color:var(--t-text)] placeholder-[color:var(--t-muted)] outline-none"
        />
        <div className="mt-2 text-center text-[12px] text-[color:var(--t-muted)]">{imeiInput.replace(/\D/g, "").length}/15 digits{imeiValid ? " ✓" : ""}</div>

        <div className="my-4 flex items-center gap-3 text-[12px] text-[color:var(--t-muted)]">
          <div className="h-px flex-1 bg-[var(--t-card)]" /> or <div className="h-px flex-1 bg-[var(--t-card)]" />
        </div>
        <input ref={fileRef} type="file" accept="image/*" onChange={onImeiFile} className="hidden" />
        <button onClick={() => fileRef.current?.click()} disabled={ocrBusy} className="w-full rounded-2xl border border-[color:var(--t-border)] bg-[var(--t-card)] p-4 text-left disabled:opacity-50">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-xl" style={{ background: "rgba(18,176,160,0.15)" }}>📷</span>
            <div>
              <div className="text-[15px] font-bold">{ocrBusy ? "Reading screenshot…" : "Dial *#06# & upload"}</div>
              <div className="text-[12px] text-[color:var(--t-muted)]">Screenshot the IMEI screen — we read it for you</div>
            </div>
          </div>
        </button>
        <button
          onClick={() => setScanning(true)}
          className="mt-3 w-full rounded-2xl border border-[color:var(--t-border)] bg-[var(--t-card)] p-4 text-left"
        >
          <div className="flex items-center gap-3">
            <span
              className="grid h-10 w-10 place-items-center rounded-xl"
              style={{ background: "var(--t-accent-soft)" }}
            >
              🔎
            </span>
            <div>
              <div className="text-[15px] font-bold">Scan the barcode</div>
              <div className="text-[12px] text-[color:var(--t-muted)]">
                Point at the IMEI barcode on the box or under the battery
              </div>
            </div>
          </div>
        </button>
        <button
          onClick={() => setShowManual(true)}
          className="mt-3 w-full text-center text-[13px] font-semibold underline"
          style={{ color: "var(--t-muted)" }}
        >
          Don&apos;t have the IMEI? Choose your device manually
        </button>
        {err && <p className="mt-3 text-center text-sm" style={{ color: "var(--t-bad)" }}>{err}</p>}
        {/* A DISABLED BUTTON MUST SAY WHAT IS MISSING.
            The only signal that this was blocked was a "14/15 digits" counter
            three hundred pixels up the screen — which the on-screen keyboard
            covers the moment anyone starts typing. So the seller saw a dimmed
            button, no reason, and nothing to act on. The label now carries the
            blocker, because that is where they are already looking. */}
        <button
          onClick={identify}
          disabled={!imeiValid || busy}
          className="mt-auto mb-8 w-full rounded-full py-4 text-[16px] font-bold disabled:opacity-40"
          style={{ background: grad }}
        >
          {busy
            ? "Checking…"
            : imeiValid
              ? "Validate & continue →"
              : (() => {
                  const n = imeiInput.replace(/\D/g, "").length;
                  if (n === 0) return "Enter the 15-digit IMEI";
                  const left = 15 - n;
                  return left > 0
                    ? `${left} more digit${left === 1 ? "" : "s"}`
                    : `${n - 15} digit${n - 15 === 1 ? "" : "s"} too many`;
                })()}
        </button>
      </div>
    );
  }

  if (phase === "identifying") {
    const steps = idSteps();
    const done = valSteps >= steps.length && !busy;
    const modelKnown = !!brand && !!model && !/unknown/i.test(model);
    const badge = (state: string, detail: string) => {
      const map: Record<string, { c: string; bg: string; t: string }> = {
        ok: { c: "var(--t-ok)", bg: "var(--t-accent-soft)", t: detail || "Passed" },
        bad: { c: "var(--t-bad)", bg: "rgba(248,113,113,0.14)", t: detail || "Failed" },
        warn: { c: "var(--t-warn)", bg: "rgba(251,191,36,0.14)", t: detail || "Unknown" },
        na: { c: "var(--t-muted)", bg: "rgba(148,163,184,0.12)", t: "Not available" },
      };
      const m = map[state] || map.na;
      return <span className="rounded-full px-2.5 py-1 text-[12px] font-bold" style={{ color: m.c, background: m.bg }}>{m.t}</span>;
    };
    return (
      <div className={`${wrap} flex flex-col px-6`} style={bg}>
        {rail}
        <div className="mt-6 space-y-2">
          {steps.map((v, i) => (
            <div key={i} className="rounded-2xl border border-[color:var(--t-border)] bg-[var(--t-card)] px-4 py-3">
              <div className="flex items-center justify-between">
                <span className="text-[14px] text-[color:var(--t-text)]">{v.label}</span>
                {i < valSteps ? badge(v.state, v.state === "ok" ? "Passed" : "") : <span className="text-[12px] text-[color:var(--t-muted)]">Checking…</span>}
              </div>
              {i < valSteps && v.detail && (
                <div className="mt-0.5 text-[12px]" style={{ color: v.state === "na" || v.state === "warn" ? "var(--t-muted)" : "var(--t-muted)" }}>{v.detail}</div>
              )}
            </div>
          ))}
        </div>
        <p className="mt-3 text-[11px] text-[color:var(--t-muted)]">
          Format &amp; model come from the IMEI + GSMA. Live blacklist / lost-stolen status needs a paid network lookup — not run here.
        </p>
        {done && (
          <div className="mt-5 rounded-2xl border border-[color:var(--t-border)] bg-[var(--t-card)] p-5 text-center">
            <div className="text-[12px] uppercase tracking-widest text-[color:var(--t-muted)]">{modelKnown ? "Device detected" : "Device not identified"}</div>
            <div className="mt-1 text-xl font-extrabold">{modelKnown ? [brand, model].filter(Boolean).join(" ") : "Unknown device"}</div>
            <div className="mono mt-1 text-[12px] text-[color:var(--t-muted)]">{imeiInput.replace(/\D/g, "")}</div>
          </div>
        )}
        {done && (
          <button onClick={() => { setConnected2nd(false); setPhase("await2nd"); }} className="mt-auto mb-8 w-full rounded-full py-4 text-[16px] font-bold" style={{ background: grad, color: theme.ctaText }}>Next: scan with a second device →</button>
        )}
        {done && err && <p className="mb-4 text-center text-sm text-[color:var(--t-bad)]">{err}</p>}
      </div>
    );
  }


  if (phase === "await2nd") {
    // While the camera phone drives the display test, THIS screen shows the pattern.
    // Always caption it so the flip to white/stripes isn't a silent blank screen.
    const fill = FILLS[primaryPattern];
    if (connected2nd && (primaryPattern === "stripes" || fill)) {
      const bg = primaryPattern === "stripes" ? "repeating-linear-gradient(90deg,#000 0 6px,#fff 6px 12px)" : fill;
      return (
        <div className="fixed inset-0" style={{ background: bg }}>
          <div className="absolute inset-x-0 bottom-8 flex justify-center px-6">
            <div className="rounded-full bg-black/75 px-4 py-2 text-center text-[13px] font-semibold text-white backdrop-blur">
              📷 Screen dead-pixel test · showing <b>{primaryPattern}</b> — hold this screen toward the camera
            </div>
          </div>
        </div>
      );
    }
    const camUrl = origin && sessionId ? `${origin}${withBase(`/v2/cam/${sessionId}`)}` : "";
    return (
      <div className={`${wrap} flex flex-col items-center px-6`} style={bg}>
        <OfflineBanner />
        <div className="w-full">{rail}</div>
        <h1 className="mt-4 text-center text-2xl font-extrabold">Use a second device</h1>
        <p className="mt-2 max-w-xs text-center text-[14px]" style={{ color: "var(--t-muted)" }}>
          Scan this with another phone. It becomes the camera and captures this device&apos;s exterior, screen &amp; Settings.
        </p>
        {!connected2nd && <TwoDeviceIllustration className="mt-3 h-36 w-auto" />}
        {/* QR stays on white regardless of theme — scanners need the contrast. */}
        <div className="mt-4 rounded-3xl bg-white p-4">{camUrl && <QR text={camUrl} size={200} />}</div>
        {/* Typeable fallback, the way Pandas offers "Can't scan the QR code?" */}
        {camUrl && (
          <div className="mono mt-2 max-w-full break-all px-2 text-center text-[11px] leading-relaxed" style={{ color: "var(--t-muted)" }}>
            Can&apos;t scan? Open <b style={{ color: "var(--t-text)" }}>{camUrl.replace(/^https?:\/\//, "")}</b>
          </div>
        )}
        <div
          className="mt-4 inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium"
          style={
            connected2nd
              ? { color: theme.ok, background: "var(--t-accent-soft)" }
              : { color: "var(--t-muted)", background: "var(--t-bg-soft)" }
          }
        >
          <span className="h-2 w-2 rounded-full" style={{ background: connected2nd ? theme.ok : "var(--t-muted)" }} />
          {connected2nd ? "Connected — keep this screen facing the camera" : "Waiting for the second device…"}
        </div>
        <button onClick={() => setPhase("identifying")} className="mt-4 text-[12px] underline" style={{ color: "var(--t-muted)" }}>← Back</button>
      </div>
    );
  }

  if (phase === "battery") {
    const g = batteryGuide(brand, model);
    const read = batteryPct != null;
    return (
      <div className={`${wrap} flex flex-col px-6`} style={bg}>
        {rail}
        <div className="mt-4 flex items-start gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-extrabold">Battery health 🔋</h1>
            <p className="mt-1 text-[14px]" style={{ color: "var(--t-muted)" }}>
              Optional — a screenshot of your Battery Health screen sharpens your offer. Steps for your{" "}
              {model || "device"}:
            </p>
          </div>
          {/* A second way out, at the TOP. The instructions run longer than one
              phone screen, so a seller who has decided to skip should not have
              to read past all of them to find the exit. */}
          <button
            onClick={leaveBattery}
            className="shrink-0 rounded-full border px-3 py-1.5 text-[12px] font-semibold"
            style={{ borderColor: "var(--t-border)", color: "var(--t-muted)" }}
          >
            Skip →
          </button>
        </div>
        {/* Show the exact screen we need — sellers often send battery USAGE instead. */}
        <div className="mt-3 flex justify-center">
          <BatteryExampleShot platform={g.platform} className="h-52 w-auto" />
        </div>
        {/* The dial code, where the platform actually has one. */}
        {g.command ? (
          <div
            className="mt-3 rounded-2xl border p-3 text-center"
            style={{ borderColor: "var(--t-accent)", background: "var(--t-accent-soft)" }}
          >
            <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--t-muted)" }}>
              Dial this on the {brand || "device"}
            </div>
            <button
              onClick={() => navigator.clipboard?.writeText(g.command as string).catch(() => {})}
              className="mono mt-1 text-[22px] font-black tracking-wider"
              style={{ color: "var(--t-accent-ink)" }}
              title="Tap to copy"
            >
              {g.command}
            </button>
            <div className="text-[11px]" style={{ color: "var(--t-muted)" }}>
              {g.commandNote} · tap to copy
            </div>
          </div>
        ) : (
          <p className="mt-3 text-center text-[12px]" style={{ color: "var(--t-muted)" }}>
            {g.commandNote}
          </p>
        )}
        <div className="mt-4 rounded-2xl border border-[color:var(--t-border)] bg-[var(--t-card)] p-4">
          <div className="text-[13px] font-bold" style={{ color: "var(--t-accent)" }}>{g.title}</div>
          <ol className="mt-2 space-y-1.5">
            {g.steps.map((st, i) => (
              <li key={i} className="flex gap-2 text-[14px] text-[color:var(--t-text)]">
                <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-bold" style={{ background: "var(--t-accent-soft)", color: "var(--t-accent)" }}>{i + 1}</span>
                {st}
              </li>
            ))}
          </ol>
          <p className="mt-2 text-[12px] text-[color:var(--t-muted)]">{g.note}</p>
        </div>
        <input ref={batteryFileRef} type="file" accept="image/*" onChange={onBatteryFile} className="hidden" />
        <button onClick={() => batteryFileRef.current?.click()} disabled={batteryBusy} className="mt-4 w-full rounded-2xl border border-[color:var(--t-border)] bg-[var(--t-card)] p-4 text-left disabled:opacity-50">
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-xl" style={{ background: "rgba(18,176,160,0.15)" }}>📷</span>
            <div>
              <div className="text-[15px] font-bold">{batteryBusy ? "Reading screenshot…" : read ? "Upload a different screenshot" : "Upload battery screenshot"}</div>
              <div className="text-[12px] text-[color:var(--t-muted)]">We read the capacity % for you</div>
            </div>
          </div>
        </button>
        {read && (
          <div className="mt-3 flex items-center gap-2 rounded-2xl border p-4" style={{ borderColor: "rgba(52,211,153,0.4)", background: "rgba(52,211,153,0.08)" }}>
            <span className="text-lg">✓</span>
            <span className="text-[14px] font-bold text-[color:var(--t-text)]">
              {(batteryPct ?? 0) > 0 ? `Battery health read: ${batteryPct}%` : "Screenshot received — we'll include it"}
            </span>
          </div>
        )}
        {err && <p className="mt-3 text-center text-sm text-[color:var(--t-bad)]">{err}</p>}
        {/* STICKY, not `mt-auto`. `mt-auto` only bottom-aligns when the column
            has slack; this page is taller than a phone screen, so it pushed the
            only way forward BELOW the fold and the step read as a dead end.
            Sticky keeps it on screen wherever the seller has scrolled to. */}
        <div
          className="sticky bottom-0 z-10 mt-6 -mx-6 px-6 pb-8 pt-3"
          style={{
            background: "linear-gradient(to top, var(--t-bg) 72%, transparent)",
          }}
        >
          <button
            onClick={leaveBattery}
            className="w-full rounded-full py-4 text-[16px] font-bold"
            style={{ background: grad }}
          >
            {read ? "Continue to tests →" : "Skip for now →"}
          </button>
        </div>
      </div>
    );
  }

  if (phase === "functional") {
    // The device tests itself; when done, we load the offer.
    return <DeviceTest sessionId={sessionId} onComplete={loadOffer} />;
  }

  // offer
  const retail = channel === "retail";
  const grade = trust?.grade || trust?.overall || "";
  const score = trust ? trust.score : null;
  const scoreColor = score == null ? "var(--t-muted)" : score >= 85 ? "var(--t-ok)" : score >= 60 ? "var(--t-warn)" : "var(--t-bad)";
  return (
    <div className={`${wrap} flex flex-col px-6`} style={bg}>
      {rail}
      <div className="mt-4 text-center text-[11px] uppercase tracking-[0.2em] text-[color:var(--t-muted)]">
        {model || "Device"} · {retail ? "assessment complete" : "your offer"}
      </div>

      {retail ? (
        /* AT A COUNTER, THE GRADE IS THE RESULT.
           The desk quotes from the store's own book — including fault
           deductions GradeIQ knows nothing about — so a number here would be a
           second, contradictory price. The customer is told where the phone
           landed and sent back to the counter for the money. */
        <div className="mt-4 rounded-3xl border border-[color:var(--t-border)] bg-[var(--t-card)] p-7 text-center">
          <div className="text-[12px] uppercase tracking-widest text-[color:var(--t-muted)]">Condition grade</div>
          <div className="mt-1 text-[52px] font-black leading-none">{grade || "—"}</div>
          <div className="text-[13px] text-[color:var(--t-muted)]">
            {grade ? "Checks complete — the counter will confirm your price." : "Finishing the assessment…"}
          </div>
        </div>
      ) : (
        <div className="mt-4 rounded-3xl border border-[color:var(--t-border)] bg-[var(--t-card)] p-7 text-center">
          <div className="text-[12px] uppercase tracking-widest text-[color:var(--t-muted)]">Estimated trade value</div>
          <div className="mt-1 text-[52px] font-black leading-none">
            {value ? `${({ USD: "$", INR: "₹", EUR: "€" } as Record<string, string>)[value.currency] ?? "$"}${value.currency === "INR" ? Number(value.value).toLocaleString("en-IN") : value.value}` : "—"}
          </div>
          <div className="text-[13px] text-[color:var(--t-muted)]">{value ? value.note : "Calculating…"}</div>
        </div>
      )}

      <div className="mt-3 flex items-center justify-between rounded-2xl border border-[color:var(--t-border)] bg-[var(--t-card)] px-5 py-4">
        <span className="text-[14px] text-[color:var(--t-muted)]">Trust Score</span>
        <span className="text-[18px] font-black" style={{ color: scoreColor }}>{score != null ? `${score}/100` : "…"}</span>
      </div>

      {trust && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          {trust.bands.map((b: any, i: number) => (
            <div key={i} className="flex items-center justify-between rounded-2xl border border-[color:var(--t-border)] bg-[var(--t-card)] px-3.5 py-2.5">
              <span className="text-[12px] text-[color:var(--t-muted)]">{b.label}</span>
              <span className="text-[12px] font-semibold" style={{ color: b.state === "ok" ? "var(--t-ok)" : b.state === "bad" ? "var(--t-bad)" : b.state === "warn" ? "var(--t-warn)" : "var(--t-muted)" }}>{b.value}</span>
            </div>
          ))}
        </div>
      )}

      <a href={withBase(`/report/${sessionId}`)} className="mt-5 block w-full rounded-full py-4 text-center text-[16px] font-bold" style={{ background: grad }}>View full passport →</a>
      <p className="mb-8 mt-3 text-center text-[11px] text-[color:var(--t-muted)]">
        {retail ? "Assessment" : "Estimated value"} · session #{sessionId}
      </p>
    </div>
  );
}

function StepRail({ phase }: { phase: string }) {
  const activeIdx = STEPS.findIndex((s) => s.phases.includes(phase));
  return (
    <div className="flex items-center gap-1 pt-4">
      {STEPS.map((s, i) => {
        const done = i < activeIdx;
        const active = i === activeIdx;
        return (
          <div key={s.key} className="flex flex-1 flex-col items-center gap-1.5">
            {/* paints from the tenant accent, not a hardcoded GradeIQ teal */}
            <div
              className="h-1 w-full rounded-full"
              style={{ background: done || active ? "var(--t-accent)" : "var(--t-border)" }}
            />
            <span
              className="text-[10px] font-semibold uppercase tracking-wide"
              style={{ color: active ? "var(--t-accent-ink)" : "var(--t-muted)", opacity: done || active ? 1 : 0.55 }}
            >
              {s.label}
            </span>
          </div>
        );
      })}
    </div>
  );
}


function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
