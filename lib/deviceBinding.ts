// Proving that the phone that ran the tests is the phone on the record —
// for EVERY platform, including iPhones whose browser reports no model at all.
//
// The problem: a browser cannot read an IMEI (no API, by design). So a session's
// IMEI is asserted at intake and the diagnostics run on whatever device scans the
// QR. Nothing physically ties the two together, which is how a Galaxy Z Fold 6
// came to be graded against an IMEI that resolved only to the word "Samsung".
//
// Model/tier matching (lib/identity.ts) catches gross swaps but has two hard
// limits: iOS user-agents carry no model at all, and two handsets of the SAME
// model are indistinguishable by it.
//
// THE INSIGHT: every used phone already carries a unique physical signature —
// its wear pattern. Scratches, chips and dents in specific places. The cosmetic
// vision pass already maps each one with a normalized bounding box, a type and a
// severity, and then discards it after grading. That map is:
//
//   • unique per HANDSET, not per model — two same-colour iPhone 13s differ
//   • identical in behaviour on iOS and Android — it never touches the OS
//   • already computed, so it costs nothing new
//   • INDEPENDENT OF THE IMEI — which means it still identifies a device whose
//     IMEI has been reflashed, a real grey-market fraud that nothing else here
//     would catch
//
// Used as a continuity check ("are these photos all the same physical phone?")
// it closes the chain that model matching cannot.
//
// Honest limits, stated up front: a PRISTINE device has no wear and therefore no
// signature — it returns `insufficient`, never a match (an absence of evidence is
// never evidence). And a signature is a strong *continuity* claim, not a
// cryptographic identity: it says "these frames show one handset", and combined
// with a nonce or an IMEI photo it says which one.

export type Finding = {
  type?: string;
  severity?: string;
  confidence?: number;
  photoIndex?: number;
  /** [ymin, xmin, ymax, xmax], normalized 0..1 */
  box?: number[];
};

/** Defect families, ordered by how identifying and how STABLE across photos. */
type Family = "structural" | "display" | "surface";

const FAMILY: Record<string, Family> = {
  crack: "structural",
  chip: "structural",
  bend: "structural",
  dent: "structural",
  deadpixel: "display",
  discoloration: "display",
  scratch: "surface",
  scuff: "surface",
  wear: "surface",
};

// A crack is in the same place in every photo and is unmistakable. "Light wear"
// moves with the lighting. Weight accordingly.
const FAMILY_WEIGHT: Record<Family, number> = {
  structural: 3,
  display: 2,
  surface: 1,
};

/**
 * Grid resolution for quantising a defect's position.
 *
 * This is the whole robustness tradeoff. Too fine and a 10° change of angle
 * moves a scratch into the next cell and the same phone stops matching itself.
 * Too coarse and every phone matches every other. 6×6 tolerates ordinary
 * hand-held reframing while still distinguishing 36 regions per face.
 */
const GRID = 6;

export type DefectMark = {
  family: Family;
  /** grid cell index, 0..GRID*GRID-1 */
  cell: number;
  severe: boolean;
  /** which photo it was seen in — faces differ, so this is part of the identity */
  face: number;
};

export type DeviceSignature = {
  marks: DefectMark[];
  /** Total identifying weight. Below MIN_WEIGHT the signature is unusable. */
  weight: number;
  /** Stable short hash, for storing against an IMEI in the hold registry. */
  hash: string;
  sufficient: boolean;
  reason: string;
};

/** Below this, the device is too clean to identify by wear. */
const MIN_WEIGHT = 4;

function centroidCell(box: number[] | undefined): number | null {
  if (!Array.isArray(box) || box.length < 4) return null;
  const [ymin, xmin, ymax, xmax] = box.map((n) => Math.max(0, Math.min(1, Number(n) || 0)));
  const cy = (ymin + ymax) / 2;
  const cx = (xmin + xmax) / 2;
  const row = Math.min(GRID - 1, Math.floor(cy * GRID));
  const col = Math.min(GRID - 1, Math.floor(cx * GRID));
  return row * GRID + col;
}

/** Cheap, dependency-free, stable hash (FNV-1a). Not a security primitive. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function defectSignature(findings: Finding[] | undefined): DeviceSignature {
  const marks: DefectMark[] = [];
  for (const f of findings || []) {
    const family = FAMILY[String(f.type || "").toLowerCase()];
    const cell = centroidCell(f.box);
    if (!family || cell === null) continue;
    // A low-confidence finding is noise and would make the same phone fail to
    // match itself on a second pass.
    if (typeof f.confidence === "number" && f.confidence < 0.4) continue;
    marks.push({
      family,
      cell,
      severe: /severe|moderate/i.test(String(f.severity || "")),
      face: Number(f.photoIndex ?? 0),
    });
  }

  marks.sort((a, b) => a.face - b.face || a.cell - b.cell || a.family.localeCompare(b.family));
  const weight = marks.reduce((sum, m) => sum + FAMILY_WEIGHT[m.family] * (m.severe ? 2 : 1), 0);
  const hash = fnv1a(marks.map((m) => `${m.face}:${m.cell}:${m.family}:${m.severe ? 1 : 0}`).join("|"));

  return {
    marks,
    weight,
    hash,
    sufficient: weight >= MIN_WEIGHT,
    reason: !marks.length
      ? "No cosmetic defects mapped — the device is too clean to identify by wear."
      : weight >= MIN_WEIGHT
        ? `${marks.length} mapped defect${marks.length > 1 ? "s" : ""} (weight ${weight}).`
        : `Only ${marks.length} faint defect${marks.length > 1 ? "s" : ""} (weight ${weight}) — not enough to identify this handset.`,
  };
}

export type SignatureComparison = {
  /** 0..1 — share of identifying weight present in BOTH signatures. */
  score: number;
  verdict: "same" | "different" | "insufficient";
  shared: number;
  note: string;
};

/**
 * Do two signatures describe the same physical handset?
 *
 * Matching is deliberately tolerant in position (a defect may land in an
 * adjacent cell when the phone is held differently) and strict in family (a
 * crack never becomes a scratch). Both signatures must be individually
 * sufficient — comparing two clean phones would otherwise "match" them, which is
 * exactly the failure this module exists to prevent.
 */
export function compareSignatures(a: DeviceSignature, b: DeviceSignature): SignatureComparison {
  if (!a.sufficient || !b.sufficient) {
    return {
      score: 0,
      verdict: "insufficient",
      shared: 0,
      note: !a.sufficient ? a.reason : b.reason,
    };
  }

  const neighbours = (cell: number): Set<number> => {
    const row = Math.floor(cell / GRID);
    const col = cell % GRID;
    const out = new Set<number>();
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const r = row + dr;
        const c = col + dc;
        if (r >= 0 && r < GRID && c >= 0 && c < GRID) out.add(r * GRID + c);
      }
    }
    return out;
  };

  const unused = [...b.marks];
  let sharedWeight = 0;
  let shared = 0;
  for (const m of a.marks) {
    const near = neighbours(m.cell);
    const i = unused.findIndex((n) => n.family === m.family && near.has(n.cell));
    if (i >= 0) {
      sharedWeight += FAMILY_WEIGHT[m.family] * (m.severe && unused[i].severe ? 2 : 1);
      unused.splice(i, 1);
      shared++;
    }
  }

  const score = sharedWeight / Math.max(a.weight, b.weight);
  // A used phone photographed twice will not produce identical maps — the model
  // sees slightly different things each pass. 0.6 accepts that; 0.35–0.6 is
  // genuinely ambiguous and must not be called either way.
  const verdict = score >= 0.6 ? "same" : score <= 0.35 ? "different" : "insufficient";
  return {
    score: Number(score.toFixed(2)),
    verdict,
    shared,
    note:
      verdict === "same"
        ? `${shared} defect${shared > 1 ? "s" : ""} in common — same handset.`
        : verdict === "different"
          ? `Wear patterns do not correspond (${shared} in common) — these are different handsets.`
          : `Wear patterns partly overlap (score ${score.toFixed(2)}) — inconclusive.`,
  };
}

/* ── The binding chain ────────────────────────────────────────────────────────
 *
 * Four independent bindings. Each answers a different question, and none of them
 * needs the OS to cooperate — so this works identically on an iPhone, an Android
 * and a feature phone.
 *
 *   B1 NONCE     server issues a code, the device under test renders it on its
 *                own screen, the counter camera photographs it
 *                → the photographed screen is running THIS session
 *   B2 IMEI      the *#06# screen is photographed and OCR'd
 *                → this IMEI is displayed by a device in front of this camera
 *   B3 CONTINUITY the defect map is the same across the nonce photo, the IMEI
 *                photo and the cosmetic set
 *                → all of those frames show ONE physical handset
 *   B4 CLASS     model/tier agreement (lib/identity.ts)
 *                → catches gross swaps; weak on iOS
 *
 * B3 is the link that makes B1 and B2 worth anything: on its own, an IMEI photo
 * proves only that SOME phone showed that IMEI. Chained through continuity it
 * proves the phone that showed the IMEI is the phone that was graded. */
export type Bindings = {
  nonce?: "pass" | "fail" | "absent";
  imeiPhoto?: "pass" | "fail" | "absent";
  continuity?: "same" | "different" | "insufficient" | "absent";
  deviceClass?: "match" | "mismatch" | "unverified";
};

export type BindingVerdict = {
  verdict: "proven" | "contradicted" | "unproven";
  /** 0..100 — how much of the chain actually closed. */
  strength: number;
  passed: string[];
  failed: string[];
  missing: string[];
  summary: string;
};

export function scoreBindings(b: Bindings): BindingVerdict {
  const passed: string[] = [];
  const failed: string[] = [];
  const missing: string[] = [];

  const note = (ok: boolean | null, label: string) => {
    if (ok === true) passed.push(label);
    else if (ok === false) failed.push(label);
    else missing.push(label);
  };

  note(b.nonce === "pass" ? true : b.nonce === "fail" ? false : null, "Session code shown on the device's own screen");
  note(b.imeiPhoto === "pass" ? true : b.imeiPhoto === "fail" ? false : null, "IMEI read from the device's screen");
  note(
    b.continuity === "same" ? true : b.continuity === "different" ? false : null,
    "Wear pattern continuous across all photos"
  );
  note(
    b.deviceClass === "match" ? true : b.deviceClass === "mismatch" ? false : null,
    "Device class matches the IMEI"
  );

  // Any contradiction is decisive — a failed binding is positive evidence of a
  // swap, and no number of passing bindings explains it away.
  if (failed.length) {
    return {
      verdict: "contradicted",
      strength: 0,
      passed,
      failed,
      missing,
      summary: `Device identity CONTRADICTED — ${failed[0]} failed. Do not pay against this grade.`,
    };
  }

  const W = { nonce: 30, imeiPhoto: 35, continuity: 30, deviceClass: 5 };
  const strength =
    (b.nonce === "pass" ? W.nonce : 0) +
    (b.imeiPhoto === "pass" ? W.imeiPhoto : 0) +
    (b.continuity === "same" ? W.continuity : 0) +
    (b.deviceClass === "match" ? W.deviceClass : 0);

  // "Proven" requires the CHAIN to close: something that ties the session or the
  // IMEI to a physical screen, AND continuity proving that screen belongs to the
  // graded handset. Class agreement alone can never prove identity — that was the
  // original defect and it is not repeated here.
  const anchored = b.nonce === "pass" || b.imeiPhoto === "pass";
  const proven = anchored && b.continuity === "same";

  return {
    verdict: proven ? "proven" : "unproven",
    strength,
    passed,
    failed,
    missing,
    summary: proven
      ? `Device identity PROVEN (${strength}/100) — the graded handset is the one on this record.`
      : `Device identity UNPROVEN (${strength}/100) — ${
          !anchored
            ? "nothing ties this session or IMEI to a physical screen."
            : "the graded photos could not be tied to that same handset."
        }`,
  };
}
