import { getSetting } from "./settings";

// AI display validation. The inspector's camera photographs the device's LIT
// screen while it cycles solid test colours (white/red/green/blue/black) plus a
// stripe pattern. Gemini inspects those captures for PANEL defects a lit screen
// reveals — dead/stuck pixels, driver-IC lines, discoloration, burn-in,
// backlight bleed — the things a human normally has to eyeball. Keyless →
// honest stub (no fabricated verdict).

const MODEL = "gemini-2.5-flash";

export type DisplayFinding = {
  pattern: string; // which colour it was most visible on
  type: string; // deadpixel | line | blob | discoloration | burn-in | bleed
  label: string;
  severity: "minor" | "moderate" | "severe";
  box?: [number, number, number, number];
};

export type DisplayCheck = {
  verdict: "pass" | "fail" | "unknown";
  confidence: number;
  findings: DisplayFinding[];
  note: string;
  source: "gemini" | "stub";
  patterns: string[]; // patterns actually captured
};

function toInlineData(dataUrl: string) {
  const m = /^data:(image\/[a-z]+);base64,(.*)$/i.exec(dataUrl);
  if (!m) return null;
  return { mime_type: m[1], data: m[2] };
}

function normBox(b: any): [number, number, number, number] | undefined {
  if (!Array.isArray(b) || b.length !== 4) return undefined;
  let v = b.map((n) => Number(n));
  if (v.some((n) => Number.isNaN(n))) return undefined;
  if (v.some((n) => n > 1)) v = v.map((n) => n / 1000);
  return [v[0], v[1], v[2], v[3]];
}

// A WHOLE-PANEL COLOUR CAST IS THE CAMERA, NOT THE PANEL. Session 8c55b4fb
// failed its display on "Uneven blueish tint" boxed [0.05,0.05,0.9,0.95] — the
// entire screen — and a working phone went to "Needs repair". A panel defect is
// local (a spot, a band, a corner); one even tint over the whole lit screen is
// the photographing camera's white balance. So a discoloration/tint finding
// covering ≥ 70% of the frame becomes this advisory note and never fails the
// display. Localised discoloration, spots, lines and dead pixels fail as before.
const CAST_MIN_AREA = 0.7;
export const CAST_NOTE = "Overall colour cast — likely the camera, not the panel";

export function isWholePanelCast(f: DisplayFinding): boolean {
  if (!/discolou?r|tint/i.test(f.type) || !f.box) return false;
  const [y0, x0, y1, x1] = f.box.map((n) => Math.min(1, Math.max(0, n)));
  return Math.abs(y1 - y0) * Math.abs(x1 - x0) >= CAST_MIN_AREA;
}

export async function validateDisplay(
  captures: { pattern: string; dataUrl: string }[],
  model = ""
): Promise<DisplayCheck> {
  const patterns = captures.map((c) => c.pattern);
  const key =
    getSetting("gemini_key", "GEMINI_API_KEY") ||
    getSetting("", "GOOGLE_API_KEY") ||
    "";

  if (!key || captures.length === 0) {
    return {
      verdict: "unknown",
      confidence: 0,
      findings: [],
      note: key
        ? "No screen captures to validate."
        : "Add a Gemini key on Settings to auto-validate the display.",
      source: "stub",
      patterns,
    };
  }

  const parts: any[] = [
    {
      text: `You are GradeIQ's DISPLAY panel inspector for a used ${
        model || "smartphone"
      }. Each photo shows this phone's screen while it displays a solid test colour or a stripe pattern (labelled). Judge ONLY defects of the LIT panel itself:
- dead / stuck pixels (a dot that stays wrong on every colour)
- driver-IC lines (a vertical/horizontal coloured line across the panel — often green or pink; look hardest on the WHITE and GRAY frames)
- bright or dark blobs / pressure marks under the glass
- discoloration, yellowing, uneven tint / non-uniformity / gray-scale mura (most visible on the GRAY frame)
- burn-in / image retention
- backlight bleed (light leaking at edges — judge on the BLACK frame)
IGNORE anything that is NOT the panel: glass scratches/cracks, reflections, glare, dust, fingerprints, the room, the phone's body. Do not invent defects — a clean uniform colour is a PASS.
For each real defect add a finding with the pattern it shows best on and a normalized box [ymin,xmin,ymax,xmax] in 0..1.
If the display is not clearly visible and LIT in the photos, you MUST return verdict "unknown" — never "pass". Return STRICT JSON {"verdict":"pass|fail|unknown","confidence":0..1,"note":"one short sentence","findings":[{"pattern":"white|gray|red|green|blue|black|stripes","type":"deadpixel|line|blob|discoloration|burn-in|bleed","label":"short","severity":"minor|moderate|severe","box":[ymin,xmin,ymax,xmax]}]}.`,
    },
  ];
  for (const c of captures) {
    const inline = toInlineData(c.dataUrl);
    if (inline) {
      parts.push({ text: `Pattern shown: ${c.pattern}` });
      parts.push({ inline_data: inline });
    }
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
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0,
            topP: 1,
            topK: 1,
          },
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

  if (!out) {
    return {
      verdict: "unknown",
      confidence: 0,
      findings: [],
      note: "Display validation unavailable (AI call failed) — check the screen manually.",
      source: "stub",
      patterns,
    };
  }

  const all: DisplayFinding[] = Array.isArray(out.findings)
    ? out.findings.slice(0, 12).map((f: any) => ({
        pattern: String(f.pattern ?? "").slice(0, 12),
        type: String(f.type ?? "defect").slice(0, 20),
        label: String(f.label ?? f.type ?? "defect").slice(0, 60),
        severity: (["minor", "moderate", "severe"].includes(f.severity)
          ? f.severity
          : "minor") as DisplayFinding["severity"],
        box: normBox(f.box),
      }))
    : [];
  const findings = all.filter((f) => !isWholePanelCast(f));
  const cast = findings.length < all.length;

  // "pass" must be EARNED: the model has to actually say pass AND be reasonably
  // confident it saw a lit screen. Previously anything that wasn't "fail" became
  // "pass", so a screen that was never visible (confidence 0, note "display is
  // not visible") was recorded as a passing display test — which then inflated
  // the functional grade and the offer. A "fail" whose only findings are a
  // whole-panel cast rests on the cast alone, so it is judged like a "pass": the
  // model did see the lit screen, or it could not have seen its tint.
  const conf = typeof out.confidence === "number" ? out.confidence : 0.7;
  const said = cast && findings.length === 0 && out.verdict === "fail" ? "pass" : out.verdict;
  const verdict: DisplayCheck["verdict"] =
    said === "fail" || findings.length > 0
      ? "fail"
      : said === "pass" && conf >= 0.5
        ? "pass"
        : "unknown";

  const plain =
    verdict === "pass"
      ? "No panel defects detected across the test patterns."
      : verdict === "unknown"
        ? "The screen wasn't clearly visible in the captures — display not verified."
        : `${findings.length} display defect${findings.length > 1 ? "s" : ""} detected.`;
  return {
    verdict,
    confidence: conf,
    findings,
    // The model's own note would describe the cast as a defect; with one dropped,
    // say what is left plus the advisory.
    note: cast ? `${plain} ${CAST_NOTE}.` : typeof out.note === "string" && out.note ? out.note : plain,
    source: "gemini",
    patterns,
  };
}
