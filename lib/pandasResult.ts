// Pandas-compatible result payload. Maps a GradeIQ session onto the exact shape
// documented at hub.pandas.io/.../api-docs so GradeIQ is a drop-in for the
// Pandas `GET /api/customers/sessions/<id>` contract.

import type { Session } from "./db";
import { gradeFunctional } from "./grading";
import { FUNCTIONAL_TESTS } from "./tests";

// GradeIQ component ids → Pandas-style component names.
const COSMETIC_COMPONENT: Record<string, string> = {
  front: "front_glass",
  back: "back_glass",
  frame: "frame_bezel",
  cameras: "camera_lens",
  display: "display",
};
const FUNCTIONAL_COMPONENT: Record<string, string> = {
  touch: "digitizer",
  multitouch: "multitouch",
  display: "display",
  motion: "sensors",
  mic: "microphone",
  speaker: "speaker",
  camera: "camera",
  vibration: "vibration",
  buttons: "buttons",
};

function iso(dt: string): string {
  // SQLite "YYYY-MM-DD HH:MM:SS" (UTC) → ISO-8601.
  if (!dt) return "";
  return dt.includes("T") ? dt : dt.replace(" ", "T") + "Z";
}

type Assessment =
  | { category: "cosmetic"; component: string; grade: string }
  | { category: "functional"; component: string; status: string; detail?: string };

export type PandasResult = {
  session_id: string;
  external_id: string | null;
  status: "completed" | "cancelled" | "errored" | "in_progress";
  started_at: string;
  completed_at: string | null;
  device: {
    imei: string | null;
    brand: string;
    model: string;
    capacity_gb: number | null;
    color: string | null;
    source: "preset" | "identified";
  };
  assessments: Assessment[];
  residual_value?: { amount: number; currency: string; overall_grade: string };
  metadata: { photos: { id: string; component: string; url: string }[] };
  schema_version: 1;
};

export function toPandasResult(s: Session, host = ""): PandasResult {
  const cos = s.cosmetic as any;
  const imei = s.imei_info as any;
  const device = s.device as any;
  const pc = s.phonecheck as any;
  const offer = s.offer as any;
  const verdict = gradeFunctional(s.functional);

  const status: PandasResult["status"] =
    s.cosmetic_grade && s.functional_grade
      ? "completed"
      : s.cosmetic_grade || s.functional_grade
        ? "in_progress"
        : "in_progress";

  const assessments: Assessment[] = [];
  if (Array.isArray(cos?.specialists))
    for (const sp of cos.specialists)
      if (sp.weight > 0)
        assessments.push({
          category: "cosmetic",
          component: COSMETIC_COMPONENT[sp.id] ?? sp.id,
          grade: String(sp.grade),
        });
  for (const t of FUNCTIONAL_TESTS) {
    const r = s.functional[t.id];
    if (r === "pass" || r === "fail")
      assessments.push({
        category: "functional",
        component: FUNCTIONAL_COMPONENT[t.id] ?? t.id,
        status: r === "pass" ? "working" : "faulty",
      });
  }

  const capacity =
    typeof device?.storageGB === "number" ? device.storageGB : null;

  const result: PandasResult = {
    session_id: s.id,
    external_id: (s as any).external_id || null,
    status,
    started_at: iso(s.created_at),
    completed_at: status === "completed" ? iso(s.updated_at) : null,
    device: {
      imei: s.imei || null,
      brand: imei?.brand || device?.brand || s.model?.split(" ")[0] || "",
      model: s.model || imei?.model || "",
      capacity_gb: capacity,
      color: device?.color || pc?.color || null,
      source: s.imei ? "identified" : "preset",
    },
    assessments,
    metadata: {
      photos: (s.photos || []).map((_, i) => ({
        id: `p${i + 1}`,
        component: assessments.find((a) => a.category === "cosmetic")?.component ?? "device",
        url: `${host}/api/customers/sessions/${s.id}/photos/p${i + 1}`,
      })),
    },
    schema_version: 1,
  };

  if (typeof offer?.offer === "number" && !offer?.blocked)
    result.residual_value = {
      amount: offer.offer,
      currency: "USD",
      overall_grade: s.overall_grade || s.cosmetic_grade || "",
    };

  return result;
}
