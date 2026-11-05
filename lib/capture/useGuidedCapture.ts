"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  analyzeFrame,
  deriveInstruction,
  type CaptureProfile,
  type FrameMeasurements,
  type Instruction,
} from "./frameAnalyzer";
import {
  newEventId,
  MEASUREMENT_PROFILE,
  type ActualVerdict,
  type CaptureOutcome,
} from "./captureEvents";
import { withBase } from "../basePath";

/**
 * The shared capture engine both surfaces will run on.
 *
 * `V2Cam` and `CosmeticCapture` each grew their own sampling loop, their own
 * `assess()`, and their own thresholds. Building AR guidance into either one
 * would produce a second, incompatible AR system — so the hook lands FIRST and
 * the overlays get built on top of it once, not twice.
 *
 * OBSERVATION ONLY. The hook measures continuously, derives what guidance WOULD
 * say, and records it. It does not display instructions and it does not gate
 * capture. Crucially it also does not *decide* anything: the caller reports the
 * verdict its own existing code reached, and that is what gets stored as the
 * actual outcome. Guidance thresholds are guesses until store telemetry says
 * otherwise, and shipping guesses as instructions would train operators to
 * ignore the overlay before it ever works.
 *
 * The measurement region does NOT currently match V2Cam's guide rectangle
 * (0.6 x 0.6 of the raw frame here, GUIDE_W x GUIDE_H of its own crop there),
 * which is exactly why the two verdicts are recorded separately rather than
 * one being presented as a reproduction of the other. Aligning them is Phase 2.
 */

export type GuidedCaptureState = {
  /** Latest measurements, or null before the first frame resolves. */
  measurements: FrameMeasurements | null;
  /** What guidance would say. Recorded, not shown. */
  instruction: Instruction | null;
  /** Distinct instructions seen during this step, in order of first appearance. */
  instructionsShown: Instruction[];
  /** ms since this step started. */
  elapsedMs: number;
};

export type RecordArgs = {
  outcome: CaptureOutcome;
  /** What the CALLER's own acceptance code decided. Never inferred here. */
  actualVerdict: ActualVerdict;
  photoIndex?: number;
};

export function useGuidedCapture(opts: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  sessionId: string;
  surface: "v2cam" | "cosmetic";
  /**
   * STABLE identifier for the current step, from the active journey — not a
   * display label. Tenant journeys reorder and rename steps, so grouping
   * telemetry by label merges steps that share a name and splits one that got
   * reworded.
   */
  stepId: string;
  /** What the operator actually saw, for reading the data back. */
  stepLabel: string;
  profile: CaptureProfile;
  intervalMs?: number;
  active?: boolean;
}) {
  const {
    videoRef,
    sessionId,
    surface,
    stepId,
    stepLabel,
    profile,
    intervalMs = 250,
    active = true,
  } = opts;

  const [state, setState] = useState<GuidedCaptureState>({
    measurements: null,
    instruction: null,
    instructionsShown: [],
    elapsedMs: 0,
  });

  // Refs, not state: read inside the sampling loop and by record(), and putting
  // them in state would re-render the camera several times a second.
  const prevRef = useRef<{ luma: Float32Array; width: number; height: number } | null>(null);
  const latestRef = useRef<FrameMeasurements | null>(null);
  const instructionRef = useRef<Instruction | null>(null);
  const shownRef = useRef<Instruction[]>([]);
  const startedRef = useRef<number>(Date.now());
  /** Attempts within the CURRENT step — incremented by every attempt, not just
   *  accepted ones, which is what makes retakeCount mean anything. */
  const attemptRef = useRef<number>(1);
  /** Whether this step has produced an accepted frame yet — drives abandonment. */
  const capturedRef = useRef<boolean>(false);
  const stepRef = useRef<{ id: string; label: string }>({ id: stepId, label: stepLabel });
  stepRef.current = { id: stepId, label: stepLabel };

  const post = useCallback(
    (payload: Record<string, unknown>) => {
      try {
        const url = withBase(`/api/sessions/${sessionId}/capture-telemetry`);
        const body = JSON.stringify(payload);
        // sendBeacon survives the page navigating away mid-flow, which is
        // exactly when an abandoned step would otherwise go unrecorded — and
        // abandoned steps are the ones guidance is meant to eliminate.
        if (navigator.sendBeacon) {
          navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
        } else {
          void fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
            keepalive: true,
          });
        }
      } catch {
        /* never block a capture on telemetry */
      }
    },
    [sessionId]
  );

  /** Record one capture ATTEMPT — accepted, refused, replaced or abandoned. */
  const record = useCallback(
    ({ outcome, actualVerdict, photoIndex = -1 }: RecordArgs) => {
      const step = stepRef.current;
      post({
        eventId: newEventId(),
        surface,
        stepId: step.id,
        stepLabel: step.label,
        photoIndex,
        attempt: attemptRef.current,
        outcome,
        measurements: latestRef.current ?? {},
        actualVerdict,
        experimentalInstruction: instructionRef.current ?? "",
        guidance: {
          durationMs: Date.now() - startedRef.current,
          instructionsShown: shownRef.current,
        },
        measurementProfile: MEASUREMENT_PROFILE,
      });
      attemptRef.current += 1;
      if (outcome === "captured" || outcome === "replaced") capturedRef.current = true;
    },
    [post, surface]
  );

  /**
   * A new step is a new observation window. The PREVIOUS step is closed out
   * first: if it never produced a frame, that is an abandonment, and it is the
   * single most informative event this hook can emit — a step the operator gave
   * up on is precisely the one guidance exists to rescue.
   */
  useEffect(() => {
    return () => {
      if (!capturedRef.current && latestRef.current) {
        const step = stepRef.current;
        post({
          eventId: newEventId(),
          surface,
          stepId: step.id,
          stepLabel: step.label,
          photoIndex: -1,
          attempt: attemptRef.current,
          outcome: "abandoned" as CaptureOutcome,
          measurements: latestRef.current,
          actualVerdict: { accepted: false, reason: "step left without capture" },
          experimentalInstruction: instructionRef.current ?? "",
          guidance: {
            durationMs: Date.now() - startedRef.current,
            instructionsShown: shownRef.current,
          },
          measurementProfile: MEASUREMENT_PROFILE,
        });
      }
      prevRef.current = null;
      latestRef.current = null;
      instructionRef.current = null;
      shownRef.current = [];
      startedRef.current = Date.now();
      attemptRef.current = 1;
      capturedRef.current = false;
    };
  }, [stepId, post, surface]);

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    const tick = () => {
      if (stopped) return;
      const v = videoRef.current;
      if (v && v.readyState >= 2) {
        const res = analyzeFrame(v, prevRef.current);
        if (res) {
          prevRef.current = { luma: res.luma, width: res.width, height: res.height };
          const m = res.measurements;
          const instruction = deriveInstruction(m, profile);
          latestRef.current = m;
          instructionRef.current = instruction;
          if (!shownRef.current.includes(instruction)) shownRef.current.push(instruction);
          setState({
            measurements: m,
            instruction,
            instructionsShown: [...shownRef.current],
            elapsedMs: Date.now() - startedRef.current,
          });
        }
      }
    };
    const iv = setInterval(tick, intervalMs);
    return () => {
      stopped = true;
      clearInterval(iv);
    };
  }, [active, intervalMs, profile, videoRef]);

  return { ...state, record };
}
