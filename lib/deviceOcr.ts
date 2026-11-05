import { getSetting } from "./settings";

// Continuous Settings-scroll OCR. The inspector films the device's Settings
// screens as the seller scrolls; these frames are read by Gemini to pull the
// hard facts — model, storage, IMEI, battery health, parts history, OS, carrier.
// STRICT honesty: only report a field when its text is actually legible in a
// frame. Never infer or invent — a missing field stays missing.

const MODEL = "gemini-2.5-flash";

export type DeviceOcr = {
  model?: string;
  storage?: string;
  imei?: string;
  serial?: string;
  batteryHealth?: number; // % maximum capacity
  batteryCycles?: number;
  os?: string; // "iOS 17.5" / "Android 14"
  carrier?: string;
  findMy?: string; // "on" | "off" (Activation Lock / Find My)
  parts?: { name: string; status: string }[]; // genuine | unknown part | non-genuine
  warnings?: string[]; // e.g. "Unknown Part — Battery", "Important Battery Message"
  source: "gemini" | "stub";
  readCount: number; // how many frames actually contributed legible text
};

function inlineData(dataUrl: string) {
  const m = /^data:(image\/[a-z]+);base64,(.*)$/i.exec(dataUrl);
  if (!m) return null;
  return { mime_type: m[1], data: m[2] };
}

function digits(s: any): string {
  return String(s ?? "").replace(/\D/g, "");
}

export async function extractDeviceInfo(frames: string[], model = ""): Promise<DeviceOcr> {
  const key =
    getSetting("gemini_key", "GEMINI_API_KEY") ||
    getSetting("", "GOOGLE_API_KEY") ||
    "";
  if (!key || frames.length === 0) {
    return { source: "stub", readCount: 0 };
  }

  const parts: any[] = [
    {
      text: `You are GradeIQ's on-device OCR reader. These are photos of a ${
        model || "smartphone"
      }'s SETTINGS screens (General ▸ About, Battery ▸ Battery Health, Parts & Service, Storage, etc.), captured as the user scrolls. Read the text and return ONLY facts that are ACTUALLY LEGIBLE in the images.

RULES:
- Never guess or infer. If a field's text isn't clearly readable in any frame, OMIT that field entirely.
- IMEI is 15 digits. Serial is alphanumeric. Battery health is a "Maximum Capacity" percentage. Cycle count is an integer.
- For Parts & Service: list each component and whether it reads as a genuine Apple/OEM part, an "Unknown Part", or a non-genuine/aftermarket part. Copy any battery/parts warning text verbatim into "warnings".
- findMy: "on" if Find My / Activation Lock shows enabled, "off" if disabled — only if visible.

Return STRICT JSON:
{"model":"","storage":"","imei":"","serial":"","batteryHealth":0,"batteryCycles":0,"os":"","carrier":"","findMy":"","parts":[{"name":"Battery","status":"genuine|unknown part|non-genuine"}],"warnings":[""]}
Omit any key you cannot read. Do not include placeholder or example values.`,
    },
  ];
  for (const f of frames.slice(0, 8)) {
    const d = inlineData(f);
    if (d) parts.push({ inline_data: d });
  }

  let out: any = null;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig: { responseMimeType: "application/json", temperature: 0, topP: 1, topK: 1 },
        }),
      }
    );
    if (res.ok) {
      const j = await res.json();
      out = JSON.parse(j?.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}");
    }
  } catch {
    out = null;
  }
  if (!out) return { source: "stub", readCount: 0 };

  const imei = digits(out.imei);
  const bh = Number(out.batteryHealth);
  const cyc = Number(out.batteryCycles);
  const result: DeviceOcr = {
    source: "gemini",
    readCount: 0,
    model: typeof out.model === "string" && out.model ? out.model.slice(0, 60) : undefined,
    storage: typeof out.storage === "string" && out.storage ? out.storage.slice(0, 20) : undefined,
    imei: imei.length === 15 ? imei : undefined,
    serial: typeof out.serial === "string" && out.serial ? out.serial.slice(0, 24) : undefined,
    batteryHealth: bh > 0 && bh <= 100 ? Math.round(bh) : undefined,
    batteryCycles: cyc > 0 && cyc < 10000 ? Math.round(cyc) : undefined,
    os: typeof out.os === "string" && out.os ? out.os.slice(0, 30) : undefined,
    carrier: typeof out.carrier === "string" && out.carrier ? out.carrier.slice(0, 30) : undefined,
    findMy: out.findMy === "on" || out.findMy === "off" ? out.findMy : undefined,
    parts: Array.isArray(out.parts)
      ? out.parts
          .filter((p: any) => p && p.name)
          .slice(0, 8)
          .map((p: any) => ({ name: String(p.name).slice(0, 30), status: String(p.status || "unknown").slice(0, 30) }))
      : undefined,
    warnings: Array.isArray(out.warnings)
      ? out.warnings.filter((w: any) => typeof w === "string" && w).slice(0, 6).map((w: string) => w.slice(0, 120))
      : undefined,
  };
  // Count how many distinct fields we actually read (a real "coverage" signal).
  result.readCount = [
    result.model,
    result.storage,
    result.imei,
    result.serial,
    result.batteryHealth,
    result.os,
    result.carrier,
    result.parts?.length,
  ].filter(Boolean).length;
  return result;
}
