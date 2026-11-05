import { COSMETIC_TIERS } from "./grading";
import { getSetting } from "./settings";

export type CosmeticResult = {
  grade: string; // best single call (conservative when unsure)
  confidence: number; // 0..1
  defects: string[];
  notes: string;
  // Agentic, like a good operator would triage a set of photos:
  needMoreAngles: string[]; // coverage gaps → capture these angles
  photoIssues: string[]; // quality problems (blur/glare) → retake these
  question: string; // one human-like clarifying question
  conclusive: boolean; // can we finalize a single grade?
  gradeRange?: { best: string; worst: string }; // when NOT conclusive
  source: "gemini" | "stub";
};

const MODEL = "gemini-2.5-flash";

function rubric(model: string): string {
  return `You are GradeIQ's senior buyback cosmetic inspector grading a USED ${
    model || "smartphone"
  }. Inspect ONLY physical condition: screen glass, rear glass/housing, frame/
edges, camera lenses. Know this model's usual wear points and check them.

Grade ladder: Premium (like new) · A (faint micro-scratches) · B (light visible
scratches, no cracks) · C (heavy scratches/dents) · D (cracked glass, deep
dents, bent frame, missing parts).

Behave like a careful human operator, not a guesser:
- If a photo is unusable (blur, glare, too dark, cut off), name it in
  "photoIssues" and ask for a RETAKE — don't grade off a bad photo.
- If an angle needed to judge is missing, list it in "needMoreAngles".
- If you see a POSSIBLE defect you can't confirm (e.g. hairline crack vs
  reflection), ask one specific "question" and request a close-up.
- Only set "conclusive": true when you can commit to ONE grade confidently.
- If you've seen enough but genuinely can't pin a single grade, set
  "conclusive": false and give a "gradeRange" {best, worst} spanning the
  plausible outcomes (e.g. best "B", worst "C"). "grade" = the conservative
  (worst) call.

Return STRICT JSON:
{"grade": one of ["Premium","A","B","C","D"],
 "confidence": 0..1,
 "defects": ["short phrases"],
 "photoIssues": ["short phrases"],
 "needMoreAngles": ["short phrases"],
 "question": "one sentence or empty",
 "conclusive": true|false,
 "gradeRange": {"best": grade, "worst": grade} or null,
 "notes": "one sentence"}`;
}

function toInlineData(dataUrl: string) {
  const m = /^data:(image\/[a-z]+);base64,(.*)$/i.exec(dataUrl);
  if (!m) return null;
  // REST v1beta expects snake_case inside inline_data.
  return { mime_type: m[1], data: m[2] };
}

// Tier helpers for the stub's range logic.
function tierUp(g: string): string {
  const i = COSMETIC_TIERS.indexOf(g as any);
  return COSMETIC_TIERS[Math.max(0, i - 1)];
}

function stubResult(photos: string[]): CosmeticResult {
  const n = photos.length;
  const seed = photos.join("").length + n * 7;
  const grade = COSMETIC_TIERS[seed % COSMETIC_TIERS.length];

  // 0–1 photos: still gathering coverage.
  if (n < 2) {
    return {
      grade,
      confidence: 0.4,
      defects: [],
      photoIssues: n === 0 ? [] : ["front photo has glare — retake"],
      needMoreAngles: ["rear glass under angled light", "bottom edge"],
      question: "",
      conclusive: false,
      notes: `Stub grade (no Gemini key). Need more photos (${n}).`,
      source: "stub",
    };
  }
  // 2–3 photos: borderline — return a range like a cautious operator.
  if (n <= 3) {
    const worst = grade === "Premium" ? "A" : grade;
    const best = tierUp(worst);
    return {
      grade: worst,
      confidence: 0.62,
      defects: ["possible hairline mark near top-left corner"],
      photoIssues: [],
      needMoreAngles: [],
      question:
        "Is the top-left corner a hairline crack or just a reflection? A close-up would settle it.",
      conclusive: false,
      gradeRange: { best, worst },
      notes: `Stub grade (no Gemini key). Borderline ${best}–${worst}.`,
      source: "stub",
    };
  }
  // 4+ photos: confident.
  return {
    grade,
    confidence: 0.85,
    defects: grade === "Premium" ? [] : ["light scuffs on frame"],
    photoIssues: [],
    needMoreAngles: [],
    question: "",
    conclusive: true,
    notes: `Stub grade (no Gemini key). Assessed ${n} photos.`,
    source: "stub",
  };
}

// OCR the IMEI off a phone's *#06# screen (or box label) via Gemini vision.
// Returns the 15-digit IMEI, or "" if none is legible.
/**
 * Read the IMEI off a *#06# / Settings screenshot.
 *
 * Returns a REASON on failure instead of a bare "" — a quota-exhausted key and a
 * blurry photo are completely different problems for the seller (one means "scan
 * the barcode instead", the other means "retake it"), and collapsing both into an
 * empty string made the upload look broken when the AI was simply over quota.
 */
export type ImeiOcrResult = { imei: string; error: string | null };

export async function extractImei(dataUrl: string): Promise<ImeiOcrResult> {
  const key =
    getSetting("gemini_key", "GEMINI_API_KEY") || getSetting("", "GOOGLE_API_KEY");
  const inline = toInlineData(dataUrl);
  if (!key) return { imei: "", error: "ai_not_configured" };
  if (!inline) return { imei: "", error: "bad_image" };
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: `This is a phone screen showing device info (the *#06# dialog, Settings ▸ About, or a box/barcode label). Find the device's IMEI: a 15-digit number, usually labelled IMEI, IMEI1, "IMEI (MEID)", or IMEI/SV. On dual-SIM phones two are shown (IMEI1 and IMEI2) — return the FIRST one (IMEI1). Numbers may contain spaces or a trailing "/NN" check digit — ignore those, return only the 15 digits. Do NOT return MEID, EID, serial number, or SV. Return STRICT JSON {"imei":"<15 digits or empty>"}.`,
                },
                { inline_data: inline },
              ],
            },
          ],
          generationConfig: { responseMimeType: "application/json", temperature: 0 },
        }),
      }
    );
    if (!res.ok) {
      // 429 = the key is out of quota; 403 = key rejected. Both are OPERATOR
      // problems, not "your photo was bad" — say so, so the UI can route the
      // seller to the barcode scanner / manual entry instead of blaming them.
      const reason =
        res.status === 429 ? "ai_quota" : res.status === 403 || res.status === 401 ? "ai_key" : "ai_error";
      return { imei: "", error: reason };
    }
    const json = await res.json();
    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
    const digits = String(JSON.parse(text).imei ?? "").replace(/\D/g, "");
    return digits.length === 15
      ? { imei: digits, error: null }
      : { imei: "", error: "not_found" };
  } catch {
    return { imei: "", error: "ai_error" };
  }
}

export async function gradeCosmetic(
  photos: string[],
  model = ""
): Promise<CosmeticResult> {
  const key =
    getSetting("gemini_key", "GEMINI_API_KEY") || getSetting("", "GOOGLE_API_KEY");
  if (!key || photos.length === 0) return stubResult(photos);

  const parts: any[] = [{ text: rubric(model) }];
  for (const p of photos) {
    const inline = toInlineData(p);
    if (inline) parts.push({ inline_data: inline });
  }

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig: { responseMimeType: "application/json" },
        }),
      }
    );
    if (!res.ok) throw new Error(`Gemini ${res.status}`);
    const json = await res.json();
    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
    const p = JSON.parse(text);
    const grade = COSMETIC_TIERS.includes(p.grade) ? p.grade : "C";
    const range =
      p.gradeRange &&
      COSMETIC_TIERS.includes(p.gradeRange.best) &&
      COSMETIC_TIERS.includes(p.gradeRange.worst)
        ? { best: p.gradeRange.best, worst: p.gradeRange.worst }
        : undefined;
    const confidence = typeof p.confidence === "number" ? p.confidence : 0.8;
    const photoIssues = Array.isArray(p.photoIssues) ? p.photoIssues : [];
    const needMoreAngles = Array.isArray(p.needMoreAngles)
      ? p.needMoreAngles
      : [];
    // Never finalize a shaky read: low confidence, an unusable photo, or an
    // unseen surface (e.g. glare hiding the screen) means "not conclusive" —
    // regardless of what the model claimed. That routes it to a retake / range
    // / manual pick instead of a bogus firm grade.
    const conclusive =
      p.conclusive !== false &&
      !range &&
      confidence >= 0.6 &&
      photoIssues.length === 0 &&
      needMoreAngles.length === 0;
    return {
      grade,
      confidence,
      defects: Array.isArray(p.defects) ? p.defects : [],
      photoIssues,
      needMoreAngles,
      question: typeof p.question === "string" ? p.question : "",
      conclusive,
      gradeRange: range,
      notes: typeof p.notes === "string" ? p.notes : "",
      source: "gemini",
    };
  } catch (e) {
    const fallback = stubResult(photos);
    fallback.notes = `Gemini call failed (${
      e instanceof Error ? e.message : "unknown"
    }); used stub.`;
    return fallback;
  }
}
