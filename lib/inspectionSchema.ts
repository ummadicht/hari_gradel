// The response contract, expressed as a schema the model is CONSTRAINED by
// rather than merely asked for in prose.
//
// Until now the call set `responseMimeType: "application/json"` and described
// the shape in the prompt's last line. That guarantees valid JSON and nothing
// about its shape, which is why the parser is full of defensive coercions
// (`String(f.type ?? "scratch")`, `["minor","moderate","severe"].includes(...)
// ? f.severity : "minor"`). Every one of those is a silent correction: a
// finding the model labelled "cracked" degrades to "scratch", and a severity it
// spelled "high" degrades to "minor" — quietly downgrading real damage.
//
// A schema turns those into shapes the model cannot emit in the first place.
//
// DELIBERATELY PERMISSIVE ON `required`. Almost nothing is required, because
// forcing a field is forcing an answer: mark `grade` required and an unseen
// back glass gets invented a grade instead of being left empty, which is
// exactly the "never assume an unassessable region is clean" failure. Strict on
// shape and vocabulary, loose on presence.

const FINDING = {
  type: "OBJECT",
  properties: {
    // The taxonomy the grading rules switch on. `isStructuralFinding()` reads
    // these exact strings, so a synonym here is a mis-grade downstream.
    type: {
      type: "STRING",
      enum: [
        "scratch",
        "crack",
        "chip",
        "dent",
        "scuff",
        "wear",
        "discoloration",
        "deadpixel",
      ],
    },
    label: { type: "STRING" },
    severity: { type: "STRING", enum: ["minor", "moderate", "severe"] },
    confidence: { type: "NUMBER" },
    photoIndex: { type: "INTEGER" },
    // [ymin, xmin, ymax, xmax], normalised 0..1.
    box: { type: "ARRAY", items: { type: "NUMBER" } },
    location: { type: "STRING" },
    length_mm_est: { type: "NUMBER" },
  },
  // A finding with no type and no severity cannot be graded at all, so these
  // two are the only things worth insisting on.
  required: ["type", "severity"],
} as const;

const COMPONENT = {
  type: "OBJECT",
  properties: {
    // "Not assessable" is a legitimate, load-bearing outcome — a screen-off
    // photo leaves the display unassessed, and that is NOT the same as clean.
    // The prompt spells that as "" today, but the API rejects an empty string
    // inside an enum ("enum[5]: cannot be empty"), so the schema names it
    // explicitly instead. That is the better contract anyway: the model must
    // now DECLARE non-assessment, where an empty string is indistinguishable
    // from a formatting slip. runVisionPass maps it back to "".
    grade: {
      type: "STRING",
      enum: ["Premium", "A", "B", "C", "D", "UNASSESSED"],
    },
    confidence: { type: "NUMBER" },
    notes: { type: "STRING" },
    findings: { type: "ARRAY", items: FINDING },
  },
} as const;

export const INSPECTION_SCHEMA = {
  type: "OBJECT",
  properties: {
    device: {
      type: "OBJECT",
      properties: {
        make: { type: "STRING" },
        model: { type: "STRING" },
        match: { type: "STRING", enum: ["match", "mismatch", "uncertain"] },
        reason: { type: "STRING" },
        /* The body colour as PHOTOGRAPHED. A TAC never carries finish, so the
           only two sources that know it are the seller and the pictures — and
           colour is the most-varying attribute between units of one model,
           which makes it the cheapest same-model swap check available. */
        colour: { type: "STRING" },
      },
    },
    obstruction: {
      type: "OBJECT",
      properties: {
        present: { type: "BOOLEAN" },
        type: {
          type: "STRING",
          enum: [
            "case",
            "bumper",
            "folio",
            "skin",
            "wrap",
            "screen protector",
            "aftermarket back",
            "none",
          ],
        },
        note: { type: "STRING" },
      },
    },
    oem: {
      type: "OBJECT",
      properties: {
        verdict: {
          type: "STRING",
          enum: ["likely_oem", "suspect_aftermarket", "inconclusive"],
        },
        confidence: { type: "NUMBER" },
        evidence: { type: "ARRAY", items: { type: "STRING" } },
      },
    },
    intake: {
      type: "OBJECT",
      properties: {
        passed: { type: "BOOLEAN" },
        confidence: { type: "NUMBER" },
        issues: { type: "ARRAY", items: { type: "STRING" } },
        missingAngles: { type: "ARRAY", items: { type: "STRING" } },
      },
    },
    components: {
      type: "OBJECT",
      properties: {
        front: COMPONENT,
        back: COMPONENT,
        frame: COMPONENT,
        cameras: COMPONENT,
        display: COMPONENT,
      },
    },
    /* WHERE THE PHONE ACTUALLY IS in each photo.
       Not a grading output — a framing one. Sellers photograph a phone that
       fills a third of the frame, and the grader downsamples the whole picture,
       so fine damage is gone before it is ever looked at. Knowing the device's
       extent lets the second pass grade a crop instead of a room.
       Localisation is something this model does reliably and a gradient
       heuristic does not: one measured against the stored capture corpus
       tightened 0 of 24 real photos, because a real photograph has edge energy
       everywhere. */
    deviceBoxes: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          photoIndex: { type: "INTEGER" },
          // [ymin, xmin, ymax, xmax], normalised 0..1 — same convention as findings.
          box: { type: "ARRAY", items: { type: "NUMBER" } },
        },
      },
    },
  },
  // `components` is the only thing whose absence makes the response useless —
  // runVisionPass already treats a missing `components` as a failed call.
  required: ["components"],
} as const;
