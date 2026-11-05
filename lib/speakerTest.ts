"use client";
// Shared acoustic loopback speaker test — the same objective technique the
// established diagnostics platforms use (see e.g. Blancco's speaker-test
// patents US11212628B2 / US10979835B2): play a known reference tone through
// the speaker, record it via the phone's OWN microphone, and decide pass/fail
// from measured energy against a just-taken ambient baseline — never from a
// human self-report as the primary signal. Those platforms run as native
// apps or dedicated robotic stations with deeper OS audio access; this is the
// browser-only equivalent, built on nothing but getUserMedia + Web Audio.
//
// This used to exist ONLY inside DeviceTest.tsx's automatic flow. The
// gamified Gauntlet flow's SpeakerGame instead asked the seller to *guess*
// a tone's pitch (high vs low) — which tests nothing: a broken (silent)
// speaker still gets guessed right half the time, and a working one can
// "fail" on a mis-click. Both flows now call this one implementation so
// they can't silently diverge in reliability again.
//
// Two-stage detection, escalating BEFORE ever asking a human:
//  1. Quick check — a single quiet 1 kHz tone. Confirms the vast majority of
//     working speakers fast, with minimal noise.
//  2. Only if that's inconclusive — a louder multi-frequency sweep (a speaker
//     with a resonance dip or partial cone damage at exactly 1 kHz can still
//     be very much alive at other frequencies; matches the frequency-sweep
//     technique the reference patents use rather than trusting one tone).
// Only if BOTH stages come back empty does this report "inconclusive" and
// leave it to the caller whether to ask the seller directly — a rare last
// resort, not a routine step.
//
// Echo cancellation / noise suppression / AGC are explicitly disabled on the
// mic stream: those exist specifically to REMOVE the phone's own speaker
// output from a mic recording (so a voice call doesn't hear itself), which is
// exactly the signal this test needs to detect — with them on, a perfectly
// good speaker reads as silent.

export type SpeakerLoopbackResult = {
  mic: "pass" | "fail";
  /** "pass"/"fail" are confident objective verdicts on the SPEAKER, reached
   *  without any human involvement. "inconclusive" means BOTH the quick check
   *  and the louder sweep genuinely couldn't tell (OS-forced echo
   *  cancellation, an unusually loud room, or a weak mic→speaker acoustic
   *  path) — the caller should fall back to asking the seller directly, never
   *  silently fail. */
  speaker: "pass" | "fail" | "inconclusive";
  /** Reusable for a manual "did you hear it?" pulse-tone fallback (see
   *  pulseTone() below) — null only if getUserMedia itself failed, in which
   *  case there is no audio path to test at all. The CALLER owns its
   *  lifecycle from here: close it once fully done with the speaker test. */
  ac: AudioContext | null;
  /** Measured response at each swept frequency — the recording, kept rather
   *  than thrown away. `delta` is peak-above-its-own-baseline in the band. */
  profile: SpeakerBand[];
  /** Frequencies that stayed silent while OTHER frequencies came through.
   *  Only meaningful when at least one band was heard: that proves the
   *  mic→speaker path works, so a dead band is the speaker, not the room. */
  weakBands: number[];
};

export type SpeakerBand = {
  hz: number;
  /** Band energy measured just before the tone — this frequency's own room noise. */
  base: number;
  /** Peak band energy while the tone played. */
  peak: number;
  delta: number;
  heard: boolean;
};

const QUICK_HZ = 1000;
const QUICK_GAIN = 0.25;
const QUICK_THRESHOLD = 18; // energy-above-baseline required to call the quick tone "heard"
const SWEEP_HZ = [400, 1000, 2500, 5000]; // low/mid/high — a null at one frequency doesn't hide a working speaker
const SWEEP_GAIN = 0.7; // louder than the quick check: this is the "make sure, before ever asking a human" pass
const SWEEP_THRESHOLD = 14; // slightly more forgiving — each frequency gets its own freshly-measured baseline
const BASELINE_MS = 180;
const TONE_WARMUP_MS = 120;
const MEASURE_MS = 380;
const SWEEP_BASELINE_MS = 90;
const SWEEP_MEASURE_MS = 220;
// A live capsule's idle noise floor, and how much it must wander to prove it is
// a real microphone rather than a muted stream of constant samples.
const MIC_FLOOR_MIN = 0.9;
const MIC_VARIATION_MIN = 0.35;

export async function runSpeakerLoopback(): Promise<SpeakerLoopbackResult> {
  let micStream: MediaStream;
  let ac: AudioContext;
  let analyser: AnalyserNode;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    ac = new (window.AudioContext || (window as any).webkitAudioContext)();
    await ac.resume();
    analyser = ac.createAnalyser();
    analyser.fftSize = 2048;
    ac.createMediaStreamSource(micStream).connect(analyser);
  } catch {
    // No mic permission / no mic at all — can't run the loopback, and there's
    // no AudioContext to hand back for a manual fallback either.
    return { mic: "fail", speaker: "inconclusive", ac: null, profile: [], weakBands: [] };
  }

  const rms = () => {
    const buf = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += (v - 128) * (v - 128);
    return Math.sqrt(sum / buf.length);
  };
  // Energy in a narrow band around one frequency — lets us detect OUR tone
  // specifically (immune to ambient noise, and immune to a silent room).
  const bandEnergy = (freqHz: number) => {
    const bins = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(bins);
    const binHz = ac.sampleRate / analyser.fftSize;
    const c = Math.round(freqHz / binHz);
    let e = 0;
    let n = 0;
    for (let i = c - 1; i <= c + 1; i++) {
      if (i >= 0 && i < bins.length) {
        e += bins[i];
        n++;
      }
    }
    return n ? e / n : 0;
  };
  const playTone = (freqHz: number, gain: number) => {
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.frequency.value = freqHz;
    g.gain.value = gain;
    osc.connect(g).connect(ac.destination);
    osc.start();
    return osc;
  };
  const measureMax = async (getVal: () => number, ms: number): Promise<number> => {
    let v = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      v = Math.max(v, getVal());
      await new Promise((r) => setTimeout(r, 20));
    }
    return v;
  };
  const measureMaxPair = async (getA: () => number, getB: () => number, ms: number): Promise<[number, number]> => {
    let a = 0;
    let b = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      a = Math.max(a, getA());
      b = Math.max(b, getB());
      await new Promise((r) => setTimeout(r, 20));
    }
    return [a, b];
  };

  /**
   * ── Stage 0: IS THE MIC ALIVE AT ALL? ──
   *
   * Measured in SILENCE, before we make any sound, because the old mic verdict
   * was circular: it was `broadMax > 2` sampled DURING our own 1 kHz tone, so
   * the speaker test's output is what made the mic test pass. It reported
   * "pass" on essentially every session — a threshold of 2 on a 0..255 signal
   * is below room noise, and we were deliberately filling the room with a tone.
   *
   * A live microphone always returns a moving noise floor: even a quiet room
   * varies sample to sample. A dead, muted, or permission-stubbed mic returns a
   * DC-flat stream — every sample pinned at 128, variance ~0. Movement, not
   * level, is what distinguishes a working capsule from a silent one, and it
   * needs no sound from us to establish.
   */
  let quietMin = Infinity;
  let quietMax = 0;
  {
    const t0 = performance.now();
    while (performance.now() - t0 < BASELINE_MS) {
      const v = rms();
      quietMin = Math.min(quietMin, v);
      quietMax = Math.max(quietMax, v);
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  // Any real capsule wanders; a flat line is silence generated by software.
  const micIsLive = quietMax > MIC_FLOOR_MIN || quietMax - quietMin > MIC_VARIATION_MIN;

  // ── Baseline (room, before we've made any sound) ──
  const [baseTone, baseBroad] = await measureMaxPair(() => bandEnergy(QUICK_HZ), rms, BASELINE_MS);

  // ── Stage 1: quick check — one quiet tone, the common case for a working speaker ──
  const quickOsc = playTone(QUICK_HZ, QUICK_GAIN);
  await new Promise((r) => setTimeout(r, TONE_WARMUP_MS));
  const [toneMax, broadMax] = await measureMaxPair(() => bandEnergy(QUICK_HZ), rms, MEASURE_MS);
  quickOsc.stop();

  let toneHeard = toneMax > baseTone + QUICK_THRESHOLD;

  /**
   * ── Stage 2: THE SWEEP — always run, and keep what it records ──
   *
   * This used to run only when stage 1 heard nothing, and it broke out of the
   * loop at the first frequency that responded. That answered "is the speaker
   * making ANY sound", which is a much weaker question than the one a buyer
   * cares about. A phone whose earpiece mesh is clogged with pocket lint, or
   * whose tweeter has been cooked, is perfectly loud at 1 kHz and silent at
   * 5 kHz — under the old logic stage 1 heard the 1 kHz tone, the sweep never
   * ran, and the report said "speaker: pass" with no evidence behind it.
   *
   * So the sweep is now unconditional and complete: emit each frequency, record
   * the response in its own band against its own freshly-measured baseline, and
   * keep every measurement. ~1.7s for a per-frequency response profile.
   *
   * Each band gets its OWN baseline rather than one global one because room
   * noise is not flat — traffic rumble sits under 400 Hz and would swamp a
   * shared threshold while telling you nothing about 5 kHz.
   */
  const profile: SpeakerBand[] = [];
  for (const freq of SWEEP_HZ) {
    const base = await measureMax(() => bandEnergy(freq), SWEEP_BASELINE_MS);
    const osc = playTone(freq, SWEEP_GAIN);
    await new Promise((r) => setTimeout(r, TONE_WARMUP_MS));
    const peak = await measureMax(() => bandEnergy(freq), SWEEP_MEASURE_MS);
    osc.stop();
    const delta = peak - base;
    profile.push({ hz: freq, base, peak, delta, heard: delta > SWEEP_THRESHOLD });
  }
  const bandsHeard = profile.filter((b) => b.heard).length;
  if (bandsHeard > 0) toneHeard = true;

  /**
   * A silent band only means something once ANOTHER band has come through.
   * One audible frequency proves the whole chain — speaker driver, air path,
   * mic capsule, and that the OS isn't cancelling our own output — so anything
   * still missing after that is the speaker's frequency response, not the test
   * conditions. With zero bands heard we know nothing and claim nothing.
   */
  const weakBands = bandsHeard > 0 ? profile.filter((b) => !b.heard).map((b) => b.hz) : [];

  // The mic itself isn't needed past this point (a manual fallback, if any,
  // only plays a tone — it doesn't listen), so free it now. `ac` stays open:
  // the caller may still need it for pulseTone() below.
  micStream.getTracks().forEach((t) => t.stop());

  /**
   * THE MIC VERDICT, in order of how much it actually proves:
   *
   *  1. It captured OUR tone in the 1 kHz band — the strongest evidence there
   *     is. Not "some energy arrived" but "the specific signal we emitted came
   *     back at the frequency we emitted it", which is the loopback check the
   *     speaker-test patents describe, and it proves real frequency response.
   *  2. No tone, but the capsule shows a live, moving noise floor — the mic
   *     works; something else (a dead speaker, a silenced ringer) broke the
   *     loop. Passing it here is what stops a broken SPEAKER from being
   *     reported as a broken mic.
   *  3. A flat, unmoving stream — nothing is listening. Fail.
   */
  const mic: "pass" | "fail" = toneHeard || micIsLive ? "pass" : "fail";

  return {
    mic,
    speaker: toneHeard ? "pass" : "inconclusive",
    ac,
    profile,
    weakBands,
  };
}

/**
 * Manual "did you hear that?" fallback — pulses a 1 kHz tone on/off every
 * 550ms on the given (already-open) AudioContext until the caller resolves
 * it via the returned `stop` function. Only reached when BOTH loopback stages
 * above come back empty — a rare last resort, never a dead end.
 */
export function pulseTone(ac: AudioContext): { stop: () => void } {
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.frequency.value = QUICK_HZ;
  g.gain.value = 0.0001;
  osc.connect(g).connect(ac.destination);
  try {
    osc.start();
  } catch {
    /* already running */
  }
  let on = false;
  const iv = setInterval(() => {
    on = !on;
    try {
      g.gain.setTargetAtTime(on ? 0.35 : 0.0001, ac.currentTime, 0.01);
    } catch {
      /* context may have closed underneath us */
    }
  }, 550);
  return {
    stop: () => {
      clearInterval(iv);
      try {
        osc.stop();
      } catch {
        /* already stopped */
      }
    },
  };
}
