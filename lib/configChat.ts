import type { ProgramConfig } from "./programConfig";
import { getSetting } from "./settings";

const SEG: Record<string, string> = {
  retail: "retail",
  scout: "scout",
  wholesale: "wholesale",
  c2b: "c2b",
  consumer: "c2b",
  enterprise: "enterprise",
};

function titleModel(s: string) {
  return s
    .replace(/\biphone\b/gi, "iPhone")
    .replace(/\bgalaxy\b/gi, "Galaxy")
    .replace(/\bpixel\b/gi, "Pixel")
    .replace(/\bpro\b/gi, "Pro")
    .replace(/\bmax\b/gi, "Max")
    .trim();
}

type Result = { reply: string; config: ProgramConfig; changed: boolean };

// Natural-language → config change. Deterministic parser handles the common
// commands; falls back to Gemini for freeform when a key is set.
export async function applyConfigCommand(
  message: string,
  cfg: ProgramConfig
): Promise<Result> {
  const c: ProgramConfig = JSON.parse(JSON.stringify(cfg));
  const m = message.trim();
  const lc = m.toLowerCase();
  const ok = (reply: string): Result => ({ reply, config: c, changed: true });
  let x: RegExpMatchArray | null;

  if (/(remove|clear|stop|end|cancel)\s+(the\s+)?(promo|bonus)/.test(lc)) {
    c.pricing.promoBonus = 0;
    return ok("Removed the promo bonus.");
  }
  if (
    (x = lc.match(
      /(?:add|set|give)?\s*(?:a\s*)?\$?(\d+)\s*(?:dollar\s*)?(?:trade-?in\s*)?(?:bonus|promo|top-?up)/
    ))
  ) {
    c.pricing.promoBonus = +x[1];
    return ok(`Set a $${x[1]} promo bonus — every live offer now gets +$${x[1]}.`);
  }
  if ((x = lc.match(/margin\s*(?:to|=|:|of|at)?\s*(\d+(?:\.\d+)?)\s*%?/))) {
    const r = +x[1] > 1 ? +x[1] / 100 : +x[1];
    c.pricing.marginRate = r;
    return ok(`Dealer margin set to ${Math.round(r * 100)}%.`);
  }
  if (
    (x = lc.match(
      /grade\s+(premium|[a-d])\s+(?:factor|multiplier)\s*(?:to|=)?\s*([\d.]+)/
    ))
  ) {
    const g = x[1] === "premium" ? "Premium" : x[1].toUpperCase();
    c.pricing.gradeFactors[g] = +x[2];
    return ok(`Grade ${g} resale multiplier set to ×${x[2]}.`);
  }
  if (
    (x = lc.match(
      /(touch|display|multitouch|camera|mic|speaker|motion|vibration|buttons)\s+repair\s*(?:cost)?\s*(?:to|=)?\s*\$?(\d+)/
    ))
  ) {
    c.pricing.repairCosts[x[1]] = +x[2];
    return ok(`${x[1]} repair cost set to $${x[2]}.`);
  }
  if (
    (x = lc.match(
      /(retail|scout|wholesale|c2b|consumer|enterprise)\D*?(\d+)\s*photos?/
    )) ||
    (x = lc.match(
      /(retail|scout|wholesale|c2b|consumer|enterprise).*?photos?\s*(?:to|=)?\s*(\d+)/
    ))
  ) {
    const seg = SEG[x[1]];
    c.segments[seg] = { ...(c.segments[seg] || {}), photoTarget: +x[2] };
    return ok(`${seg} now captures ${x[2]} photos.`);
  }
  if (
    (x = lc.match(
      /(retail|scout|wholesale|c2b|consumer|enterprise).*(blitz|gauntlet)/
    ))
  ) {
    const seg = SEG[x[1]];
    c.segments[seg] = { ...(c.segments[seg] || {}), mode: x[2] as any };
    return ok(`${seg} now uses ${x[2]} mode.`);
  }
  if (
    (x = lc.match(
      /(?:disable|skip|remove|drop)\s+(?:the\s+)?(\w+)\s*(?:test)?\s*(?:on|for|in|from)\s+(retail|scout|wholesale|c2b|consumer|enterprise)/
    ))
  ) {
    const seg = SEG[x[2]];
    const s = c.segments[seg] || {};
    s.disabledTests = [...new Set([...(s.disabledTests || []), x[1]])];
    c.segments[seg] = s;
    return ok(`${seg} will skip the ${x[1]} test.`);
  }
  // generic model price — must contain the word "price"
  if (
    (x = m.match(
      /(?:set|change|make|update)?\s*(.+?)\s+(?:base\s*)?price\s*(?:to|=|:|is|at)?\s*\$?(\d+)/i
    )) &&
    !/margin|grade|promo|bonus|repair/i.test(x[1])
  ) {
    const model = titleModel(x[1]);
    c.pricing.marketBase[model] = +x[2];
    return ok(`Set ${model} Grade-A base price to $${x[2]}.`);
  }

  // Freeform → Gemini patch.
  const g = await geminiPatch(m, cfg);
  if (g) {
    mergePatch(c, g.patch);
    return ok(g.reply);
  }

  return {
    reply:
      "I didn't catch that. Try: “set iPhone 14 price to 520”, “add a $25 bonus”, “set margin to 12%”, “wholesale 3 photos”, or “skip mic test for wholesale”.",
    config: cfg,
    changed: false,
  };
}

function mergePatch(c: ProgramConfig, p: any) {
  if (!p) return;
  if (p.pricing) {
    Object.assign(c.pricing.marketBase, p.pricing.marketBase ?? {});
    Object.assign(c.pricing.gradeFactors, p.pricing.gradeFactors ?? {});
    Object.assign(c.pricing.repairCosts, p.pricing.repairCosts ?? {});
    if (typeof p.pricing.marginRate === "number")
      c.pricing.marginRate = p.pricing.marginRate;
    if (typeof p.pricing.promoBonus === "number")
      c.pricing.promoBonus = p.pricing.promoBonus;
  }
  if (p.segments)
    for (const [k, v] of Object.entries(p.segments))
      c.segments[k] = { ...(c.segments[k] || {}), ...(v as any) };
}

async function geminiPatch(
  message: string,
  cfg: ProgramConfig
): Promise<{ patch: any; reply: string } | null> {
  const key = getSetting("gemini_key", "GEMINI_API_KEY");
  if (!key) return null;
  const prompt = `You configure a phone trade-in program. Current config JSON:
${JSON.stringify(cfg)}
The operator says: "${message}"
Return STRICT JSON {"patch": <partial ProgramConfig to merge>, "reply": "<one short confirmation>"}.
ProgramConfig shape: {pricing:{marketBase:{model:$},gradeFactors:{grade:x},repairCosts:{testId:$},marginRate:0..1,promoBonus:$}, segments:{seg:{photoTarget,mode,coverage,disabledTests:[]}}}. seg ∈ retail|scout|wholesale|c2b|enterprise. If nothing to change, return {"patch":{},"reply":"..."}.`;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json" },
        }),
      }
    );
    if (!res.ok) return null;
    const j = await res.json();
    const t = j?.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
    const parsed = JSON.parse(t);
    return { patch: parsed.patch ?? {}, reply: parsed.reply ?? "Updated." };
  } catch {
    return null;
  }
}
