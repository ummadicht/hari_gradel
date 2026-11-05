import type { Session } from "./db";
import type { ClientId } from "./clients";

/**
 * NAMED JOURNEYS — the Pandas "employee journey" model.
 *
 * Pandas exposes a journey as /j/<journey>/s/<session>: a fixed, ordered set of
 * STATIONS an operator walks a device through (identify → diagnostics → photos →
 * review → complete), with a progress rail and a clear "current step". That is a
 * thin ORCHESTRATION layer — the capture, the grading and the offer already
 * exist here; a journey just sequences them, tracks which station is done, and
 * hands the operator the right action at each one.
 *
 * This registry is PURE (no sqlite) so both the runner (client) and the API
 * (server) import it. A journey names the CLIENT it books against and whether it
 * is an employee (staff-run) or self-serve (consumer) flow.
 */

export type JourneyStepId = "identify" | "diagnostics" | "cosmetics" | "review" | "complete";

export type JourneyStep = {
  id: JourneyStepId;
  label: string;
  /** One line shown under the step title in the runner. */
  blurb: string;
};

export type Journey = {
  id: string;
  clientId: ClientId;
  label: string;
  /** "employee" = a store associate runs it; requires staff auth to launch. */
  mode: "employee" | "self";
  /** The device-program segment a launched session is stamped with. */
  segment: string;
  steps: JourneyStep[];
};

const TRADEIN_STEPS: JourneyStep[] = [
  { id: "identify", label: "Identify", blurb: "Scan the IMEI and confirm the device." },
  { id: "diagnostics", label: "Diagnostics", blurb: "Run the on-device functional tests." },
  { id: "cosmetics", label: "Photos & grade", blurb: "Capture every side; grade the condition." },
  { id: "review", label: "Review & offer", blurb: "Confirm the grade and the trade-in price." },
  { id: "complete", label: "Complete", blurb: "Record the trade-in and hand back the device." },
];

export const JOURNEYS: Record<string, Journey> = {
  // The DeNovo employee trade-in journey — the analogue of Pandas'
  // `nw-tradein-employee`. A DeNovo associate at a desk walks a customer's
  // device through the five stations and books it against DeNovo pricing.
  "denovo-tradein-employee": {
    id: "denovo-tradein-employee",
    clientId: "denovo",
    label: "DeNovo Trade-In · Employee",
    mode: "employee",
    segment: "enterprise",
    steps: TRADEIN_STEPS,
  },
};

export function getJourney(id: string): Journey | null {
  return Object.prototype.hasOwnProperty.call(JOURNEYS, id) ? JOURNEYS[id] : null;
}

export type StepStatus = "done" | "current" | "todo";

/**
 * Where a session stands in a journey, derived from the session's OWN state —
 * never a separate counter that could drift from what actually happened.
 *
 *   identify    ← a real model is resolved
 *   diagnostics ← at least one functional test has a result
 *   cosmetics   ← a cosmetic grade exists
 *   review      ← an offer has been computed (blocked counts — it was reviewed)
 *   complete    ← the session was accepted/recorded
 *
 * The "current" step is the first one not yet done; everything before it is
 * done, everything after is todo.
 */
export function stepCompletion(s: Session): Record<JourneyStepId, boolean> {
  const model = (s.model || "").trim();
  const identify = !!model && !/^unknown/i.test(model);
  const diagnostics = Object.keys(s.functional || {}).length > 0 || !!s.functional_grade;
  const cosmetics = !!s.cosmetic_grade;
  const offer = s.offer as { offer?: number; blocked?: boolean; needsModel?: boolean };
  const review = typeof offer?.offer === "number" || offer?.blocked === true;
  const complete = Number(s.accepted) === 1;
  return { identify, diagnostics, cosmetics, review, complete };
}

export function journeyProgress(
  journey: Journey,
  s: Session,
): { steps: { step: JourneyStep; status: StepStatus }[]; currentId: JourneyStepId; doneCount: number } {
  const done = stepCompletion(s);
  const firstTodo = journey.steps.find((st) => !done[st.id]);
  const currentId = (firstTodo?.id ?? "complete") as JourneyStepId;
  let hitCurrent = false;
  const steps = journey.steps.map((step) => {
    let status: StepStatus;
    if (done[step.id]) status = "done";
    else if (!hitCurrent) {
      status = "current";
      hitCurrent = true;
    } else status = "todo";
    return { step, status };
  });
  return { steps, currentId, doneCount: journey.steps.filter((st) => done[st.id]).length };
}
