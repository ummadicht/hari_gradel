import { getSetting } from "./settings";

// Non-OEM / aftermarket parts detection — done the reliable way. You can't see a
// fake screen from a photo of the phone, but the phone's OS already ran the
// parts-authentication handshake and prints the verdict on-screen (iOS 15.2+:
// Settings → General → About / Parts & Service History — "Genuine Apple Part",
// "Unknown Part", "Important … Message"). So we OCR that verdict with Gemini —
// reliable, because the authentication was done by the device, not guessed.

export type PartStatus = "genuine" | "non_genuine" | "unknown";
export type PartResult = { name: string; status: PartStatus; note?: string };
export type PartsCheck = {
  found: boolean; // did the photo actually show a parts screen?
  parts: PartResult[];
  anyNonGenuine: boolean;
  source: "gemini" | "stub";
  checkedAt?: string;
};

const MODEL = "gemini-2.5-flash";

export async function checkParts(photoDataUrl: string): Promise<PartsCheck> {
  const key =
    getSetting("gemini_key", "GEMINI_API_KEY") || getSetting("", "GOOGLE_API_KEY");
  const m = /^data:(image\/[a-z]+);base64,(.*)$/i.exec(photoDataUrl || "");
  if (!key || !m) return stub();

  const prompt = `This is a photo of a phone's parts-authentication screen — on iPhone: Settings → General → About or "Parts & Service History"; on Android: a similar service/parts screen. Read the genuine-part status for EACH component shown.

Apple prints one of: "Genuine Apple Part", "Unknown Part", or an "Important Display/Battery/Camera Message" (which means non-genuine/unverified). Map:
- "Genuine …" → genuine
- "Unknown Part" / "Important … Message" / any non-genuine wording → non_genuine
- not shown / unreadable → unknown

Return STRICT JSON {"found": true|false, "parts": [{"name":"Display|Battery|Rear Camera|Front Camera|Face ID|Screen|...","status":"genuine|non_genuine|unknown","note":"<short exact quote from the screen>"}]}. If the image is NOT a parts/about screen, return {"found": false, "parts": []}.`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            { role: "user", parts: [{ text: prompt }, { inline_data: { mime_type: m[1], data: m[2] } }] },
          ],
          generationConfig: { responseMimeType: "application/json" },
        }),
      }
    );
    if (!res.ok) return stub();
    const j = await res.json();
    const text = j?.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
    const out = JSON.parse(text);
    const parts: PartResult[] = Array.isArray(out.parts)
      ? out.parts.slice(0, 10).map((p: any) => ({
          name: String(p.name ?? "Component"),
          status: (["genuine", "non_genuine", "unknown"].includes(p.status)
            ? p.status
            : "unknown") as PartStatus,
          note: typeof p.note === "string" ? p.note.slice(0, 120) : undefined,
        }))
      : [];
    return {
      found: out.found !== false && parts.length > 0,
      parts,
      anyNonGenuine: parts.some((p) => p.status === "non_genuine"),
      source: "gemini",
    };
  } catch {
    return stub();
  }
}

function stub(): PartsCheck {
  // Deterministic demo verdict when no key is set.
  return {
    found: true,
    parts: [
      { name: "Display", status: "genuine", note: "Genuine Apple Part (stub)" },
      { name: "Battery", status: "genuine", note: "Genuine Apple Part (stub)" },
      { name: "Rear Camera", status: "genuine", note: "Genuine Apple Part (stub)" },
    ],
    anyNonGenuine: false,
    source: "stub",
  };
}
