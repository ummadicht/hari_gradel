// Model → brand + build-material profile. Powers the Gemini cosmetic prompt's
// per-model "CLAIMED DEVICE PROFILE" block: what frame metal, back material,
// and front-glass type THIS specific claimed model actually ships with — so
// the SPECULAR SCRATCH RULE's read is calibrated to a real surface (brushed
// titanium hides a shallow mark better than polished stainless; a scratch
// through a Pixel's matte soft-touch back coating looks like a GLOSSY streak,
// not the bright line the rule describes for a plain glossy panel; Ceramic
// Shield resists scratches Gorilla Glass doesn't) instead of a generic "glass"
// or "metal" guess.
//
// Regex-classified from the free-text model string — same lightweight
// approach as lib/deviceSpecs.ts's camera layout classifier, deliberately not
// a big per-SKU database. Unknown models fail open to a generic profile
// rather than asserting a specific material that might be wrong.

export type Brand = "apple" | "samsung" | "pixel" | "other";

export function brandOf(model: string): Brand {
  const m = (model || "").toLowerCase();
  if (/iphone/.test(m)) return "apple";
  if (/galaxy|samsung/.test(m)) return "samsung";
  if (/pixel/.test(m)) return "pixel";
  return "other";
}

export type MaterialProfile = {
  frame: string;
  back: string;
  frontGlass: string;
};

export function materialProfile(model: string): MaterialProfile {
  const m = (model || "").toLowerCase();

  if (/iphone/.test(m)) {
    const frame = /15 pro|16 pro/.test(m)
      ? "brushed titanium — a fine grain finish that hides very shallow marks better than polished metal, so a scratch that IS visible has cut through the grain and is real, not a trick of the light"
      : /11 pro|12 pro|13 pro|14 pro/.test(m)
        ? "polished/glossy surgical stainless steel — shows fingerprints, swirl haze and fine scratches very readily; normal handling swirl is common and expected, but still report it at minor severity"
        : "anodized aluminum — a scratch through the color coat exposes bare silvery metal underneath, a clear and unambiguous tell";
    const back = /se\b/.test(m)
      ? "aluminum back (SE line), not glass — judge scratches the same way as the frame"
      : "glass back (Ceramic Shield on 15/16, standard glass on 12–14 and earlier) — glossy, so a scratch reads as a bright specular line per the SPECULAR SCRATCH RULE above";
    const frontGlass = /iphone (1[2-6])/.test(m)
      ? "Ceramic Shield — notably scratch-resistant, so a genuine scratch through it is a real, meaningful defect rather than everyday haze; it still cracks/chips normally on impact"
      : "standard cover glass (pre-Ceramic Shield) — scratches more readily than newer models";
    return { frame, back, frontGlass };
  }

  if (/galaxy|samsung/.test(m)) {
    const frame = "Armor Aluminum (recent Ultra) or standard aluminum — a scratch through the anodized color coat exposes bare metal, a clear tell";
    const back = /fe\b|\ba\d\d/.test(m)
      ? "plastic or glass back depending on this tier — a matte-vs-gloss mismatch versus the claimed SKU's real finish is itself an aftermarket tell"
      : "Gorilla Glass Victus (or Victus 2) back — glossy, so a scratch reads as a bright specular line per the SPECULAR SCRATCH RULE above";
    const frontGlass = "Gorilla Glass Victus/Victus 2 — scratches more readily than Apple's Ceramic Shield, so light swirl haze on a used unit is common and not automatically a major defect";
    return { frame, back, frontGlass };
  }

  if (/pixel/.test(m)) {
    const frame = "aluminum frame, usually matte-coated — a scratch through the coating exposes bare metal";
    const back = "glass back — matte soft-touch coating on most Pro models, glossy on base models. On the MATTE finish specifically, a scratch through the coating shows as a GLOSSY streak against the surrounding matte texture, not a bright line on a dark panel — that texture change, not brightness alone, is the tell to look for here";
    const frontGlass = "Gorilla Glass — scratches readily; light swirl haze on a used unit is common";
    return { frame, back, frontGlass };
  }

  return {
    frame: "metal or plastic frame (exact finish unknown for this model) — judge a scratch by whether it exposes a different-colored material underneath, and apply the general rule above",
    back: "glass or plastic back (exact finish unknown for this model) — apply the general SPECULAR SCRATCH RULE above",
    frontGlass: "standard cover glass (scratch resistance unknown for this model)",
  };
}
