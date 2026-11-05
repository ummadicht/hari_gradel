// The Suggester — turns a cosmetic + functional grade into a refurb decision:
// resell as-is, repair then resell, recycle, or reject — with repair ROI and a
// price band. Business logic on top of the grade (per the Device Inspector
// skill §8), so pricing/repair rules can change without touching the graders.

import type { Session } from "./db";
import { gradeFunctional } from "./grading";

export type RepairItem = { type: string; label: string; cost: number };

export type RefurbPlan = {
  ready: boolean;
  action: "resell_as_is" | "repair_then_resell" | "recycle" | "reject";
  actionLabel: string;
  currentGrade: string;
  targetGrade: string | null;
  asIs: number; // resale value as-is
  afterRepair: number | null; // resale value after the repairs
  repairs: RepairItem[];
  repairCost: number;
  netGain: number | null; // afterRepair − asIs − repairCost
  rationale: string;
};

// Repair catalogue (USD) — aligned with the offer engine's REPAIR_COST.
const REPAIR: Record<string, { label: string; cost: number }> = {
  touch: { label: "Digitizer / touch", cost: 90 },
  display: { label: "Display panel", cost: 90 },
  multitouch: { label: "Digitizer / touch", cost: 90 },
  camera: { label: "Camera module", cost: 60 },
  mic: { label: "Microphone", cost: 40 },
  speaker: { label: "Speaker", cost: 40 },
  motion: { label: "Sensor board", cost: 35 },
  vibration: { label: "Vibration motor", cost: 25 },
  buttons: { label: "Button flex", cost: 45 },
  screen_glass: { label: "Screen glass swap", cost: 75 },
  back_glass: { label: "Rear glass swap", cost: 55 },
};

// Resale multiplier off the grade-A market base (mirrors offer.ts GRADE_FACTOR).
const FACTOR: Record<string, number> = {
  Premium: 1.05,
  A: 1.0,
  B: 0.82,
  C: 0.6,
  D: 0.35,
};

function cosmeticOf(grade: string): string {
  // overall_grade looks like "B · Working"; take the cosmetic tier.
  return (grade || "").split("·")[0].trim();
}

export function buildPlan(s: Session): RefurbPlan {
  const offer = s.offer as any;
  const cos = s.cosmetic as any;
  const verdict = gradeFunctional(s.functional);
  const marketBase: number | undefined = offer?.marketBase;
  const cosmetic = s.cosmetic_grade || cosmeticOf(s.overall_grade);

  const notReady: RefurbPlan = {
    ready: false,
    action: "resell_as_is",
    actionLabel: "Grade first",
    currentGrade: s.overall_grade || cosmetic || "—",
    targetGrade: null,
    asIs: 0,
    afterRepair: null,
    repairs: [],
    repairCost: 0,
    netGain: null,
    rationale:
      "Complete the cosmetic and functional grading to generate a refurb plan.",
  };
  if (!marketBase || !cosmetic) return notReady;

  const factor = (g: string) => FACTOR[g] ?? 0.6;
  const asIs = Math.round(marketBase * factor(cosmetic));

  // Assemble repairs: every critical functional failure + cracked glass.
  const repairs: RepairItem[] = [];
  for (const t of verdictFailIds(s)) {
    const r = REPAIR[t];
    if (r) repairs.push({ type: t, label: r.label, cost: r.cost });
  }
  // Cosmetic: a cracked/severe front implies a glass swap.
  const findings: any[] = Array.isArray(cos?.findings) ? cos.findings : [];
  const cracked =
    cosmetic === "D" ||
    findings.some((f) => /crack|chip/.test(String(f.type)) && f.severity === "severe");
  if (cracked) {
    const r = REPAIR.screen_glass;
    repairs.push({ type: "screen_glass", label: r.label, cost: r.cost });
  }

  const repairCost = repairs.reduce((a, r) => a + r.cost, 0);

  // Target grade after repairs: functional → Working; a glass swap lifts a
  // cracked cosmetic up to B.
  let targetCosmetic = cosmetic;
  if (cracked && (cosmetic === "D" || cosmetic === "C")) targetCosmetic = "B";
  const afterRepair =
    repairs.length > 0 ? Math.round(marketBase * factor(targetCosmetic)) : null;
  const targetGrade =
    repairs.length > 0 ? `${targetCosmetic} · Working` : null;
  const netGain =
    afterRepair != null ? afterRepair - asIs - repairCost : null;

  // Decide.
  let action: RefurbPlan["action"];
  let rationale: string;
  const salvageOnly = asIs < repairCost * 0.5 && (netGain == null || netGain <= 0);

  if (verdict.grade === "Faulty" && repairs.length === 0) {
    // Faulty with no economical fix path.
    action = "recycle";
    rationale = "Functional fault with no cost-effective repair — harvest parts / recycle.";
  } else if (salvageOnly) {
    action = "recycle";
    rationale = `As-is resale ($${asIs}) is below repair cost ($${repairCost}) with no positive ROI — recycle for parts.`;
  } else if (netGain != null && netGain > 15) {
    action = "repair_then_resell";
    rationale = `${repairs
      .map((r) => r.label)
      .join(" + ")} ≈ $${repairCost} lifts ${cosmetic} → ${targetCosmetic}; resale $${asIs} → $${afterRepair}, net +$${netGain}.`;
  } else if (repairs.length > 0) {
    action = "resell_as_is";
    rationale = `Repairs (≈ $${repairCost}) don't pay for themselves (net ${
      netGain != null ? (netGain >= 0 ? "+" : "") + "$" + netGain : "—"
    }) — resell as-is.`;
  } else {
    action = "resell_as_is";
    rationale = `Fully functional, ${cosmetic} cosmetic — resell as-is at ≈ $${asIs}.`;
  }

  const LABEL: Record<RefurbPlan["action"], string> = {
    resell_as_is: "Resell as-is",
    repair_then_resell: "Repair, then resell",
    recycle: "Recycle / harvest",
    reject: "Reject",
  };

  return {
    ready: true,
    action,
    actionLabel: LABEL[action],
    currentGrade: s.overall_grade || cosmetic,
    targetGrade,
    asIs,
    afterRepair,
    repairs,
    repairCost,
    netGain,
    rationale,
  };
}

// Critical functional failures → repairable component ids.
function verdictFailIds(s: Session): string[] {
  return Object.entries(s.functional)
    .filter(([, r]) => r === "fail")
    .map(([id]) => id);
}
