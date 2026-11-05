// Model → camera hardware spec. Drives model-aware criteria: how many photo
// angles of the camera bump to require, which lens covers the cosmetic
// specialist should inspect, and which lenses the functional test must trigger
// (focus / non-focus) — a base iPhone has 2 rear lenses, a Pro has 3, a Galaxy
// Ultra has 4. Unknown models fall back to a sensible family default.

export type LensKind =
  | "wide"
  | "ultrawide"
  | "telephoto"
  | "periscope"
  | "front";

export type Lens = { id: string; name: string; kind: LensKind; facing: "rear" | "front" };
export type CameraSpec = { rear: Lens[]; front: Lens[] };

const L = (id: string, name: string, kind: LensKind, facing: "rear" | "front"): Lens => ({
  id,
  name,
  kind,
  facing,
});

const WIDE = L("wide", "Main (wide)", "wide", "rear");
const ULTRA = L("ultrawide", "Ultra-wide", "ultrawide", "rear");
const TELE = L("telephoto", "Telephoto", "telephoto", "rear");
const PERI = L("periscope", "Periscope zoom", "periscope", "rear");
const FRONT = L("front", "Front (selfie)", "front", "front");

function spec(rear: Lens[]): CameraSpec {
  return { rear, front: [FRONT] };
}

// Pattern-match the marketing model string to a lens layout. Order matters for
// the tester checklist (main first).
export function cameraSpec(model: string): CameraSpec {
  const m = (model || "").toLowerCase();

  // ---- Apple ----
  if (/iphone/.test(m)) {
    if (/se\b/.test(m)) return spec([WIDE]); // single rear
    if (/pro/.test(m)) return spec([WIDE, ULTRA, TELE]); // Pro / Pro Max: 3
    return spec([WIDE, ULTRA]); // 12–16 non-Pro, mini, plus: 2
  }

  // ---- Google Pixel ----
  if (/pixel/.test(m)) {
    if (/pro|xl/.test(m)) return spec([WIDE, ULTRA, TELE]);
    if (/\ba\b|[5-9]a/.test(m)) return spec([WIDE, ULTRA]); // a-series
    return spec([WIDE, ULTRA]);
  }

  // ---- Samsung Galaxy ----
  if (/galaxy|samsung/.test(m)) {
    if (/ultra/.test(m)) return spec([WIDE, ULTRA, TELE, PERI]); // 4 rear
    if (/s2\d|s1\d|note/.test(m)) return spec([WIDE, ULTRA, TELE]); // flagship S/Note: 3
    if (/\ba\d/.test(m)) return spec([WIDE, ULTRA]); // A-series budget
    return spec([WIDE, ULTRA, TELE]);
  }

  // ---- OnePlus / Xiaomi / others flagship-ish ----
  if (/oneplus|xiaomi|redmi|oppo|vivo|nothing/.test(m)) {
    if (/pro|ultra/.test(m)) return spec([WIDE, ULTRA, TELE]);
    return spec([WIDE, ULTRA]);
  }

  // Unknown → assume a modern dual-camera phone (most common).
  return spec([WIDE, ULTRA]);
}

// Flat, ordered lens list (rear then front) — the "trigger all lenses" checklist.
export function lensesFor(model: string): Lens[] {
  const s = cameraSpec(model);
  return [...s.rear, ...s.front];
}

// Human summary, e.g. "3 rear (Main, Ultra-wide, Telephoto) + front".
export function cameraSummary(model: string): string {
  const s = cameraSpec(model);
  return `${s.rear.length} rear (${s.rear
    .map((l) => l.name.replace(/ \(.*\)/, ""))
    .join(", ")}) + front`;
}
