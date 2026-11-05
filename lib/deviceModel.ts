/**
 * Device model from a browser fingerprint — because the user agent doesn't carry it.
 *
 * Neither platform will tell you the model in the UA any more:
 *   • iOS has NEVER exposed it. "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7…)"
 *     says "iPhone" and nothing else, on every iPhone ever made.
 *   • Android Chrome REDACTED it. Since User-Agent Reduction the model token is
 *     the literal placeholder "K" — which is why parseUa() deliberately throws
 *     it away rather than reporting a phone called K.
 *
 * What survives is the CSS viewport size, which we already capture as
 * `verification.deviceFp.screen`. Apple ships a small, fixed set of logical
 * resolutions, so on iOS that size identifies the model to within a short list
 * — enough to cross-check the model the seller claimed, which is the point:
 * a session claiming an iPhone 16 Pro Max whose viewport says 375x667 is an
 * iPhone 8, and that contradiction is worth surfacing.
 *
 * DELIBERATE LIMITS:
 *   • Several models share a viewport (a 390x844 is a 12, 12 Pro, 13, 13 Pro or
 *     14). We return the whole candidate list rather than inventing precision
 *     we don't have.
 *   • Android viewports are not standardised — thousands of devices, arbitrary
 *     sizes — so this does NOT guess Android models. There the honest source is
 *     the User-Agent Client Hint `model`, requested on the device itself.
 *   • Models newer than this table are reported as unknown, never as the
 *     closest match. A wrong model is worse than no model.
 */

export type ModelFromScreen = {
  /** Human label, e.g. "iPhone 14 Pro / 15 / 15 Pro / 16". "" when unknown. */
  label: string;
  /** Every model consistent with this viewport. */
  candidates: string[];
  /** How the answer was reached, for the report's provenance line. */
  basis: "ios-viewport" | "ua-client-hint" | "unknown";
};

/**
 * Apple logical (CSS px) viewports → the models that ship them. Portrait
 * orientation; callers normalise before lookup.
 */
const IOS_VIEWPORTS: Record<string, string[]> = {
  "320x568": ["iPhone SE (1st gen)", "iPhone 5s"],
  "375x667": ["iPhone 6", "iPhone 7", "iPhone 8", "iPhone SE (2nd gen)", "iPhone SE (3rd gen)"],
  "414x736": ["iPhone 6 Plus", "iPhone 7 Plus", "iPhone 8 Plus"],
  "375x812": ["iPhone X", "iPhone XS", "iPhone 11 Pro", "iPhone 12 mini", "iPhone 13 mini"],
  "414x896": ["iPhone XR", "iPhone XS Max", "iPhone 11", "iPhone 11 Pro Max"],
  "390x844": ["iPhone 12", "iPhone 12 Pro", "iPhone 13", "iPhone 13 Pro", "iPhone 14"],
  "428x926": ["iPhone 12 Pro Max", "iPhone 13 Pro Max", "iPhone 14 Plus"],
  "393x852": ["iPhone 14 Pro", "iPhone 15", "iPhone 15 Pro", "iPhone 16"],
  "430x932": ["iPhone 14 Pro Max", "iPhone 15 Plus", "iPhone 15 Pro Max", "iPhone 16 Plus"],
  "402x874": ["iPhone 16 Pro"],
  "440x956": ["iPhone 16 Pro Max"],
  // iPads — coarse, and only the common ones.
  "768x1024": ['iPad / iPad Air 9.7"'],
  "810x1080": ["iPad (10.2-inch)"],
  "820x1180": ["iPad Air (10.9-inch)"],
  "834x1194": ['iPad Pro 11"'],
  "1024x1366": ['iPad Pro 12.9"'],
};

/** Parse "440x956" / "440 x 956" into a normalised portrait key. */
function viewportKey(screen: string): string | null {
  const m = /(\d{2,5})\s*[x×]\s*(\d{2,5})/.exec(String(screen || ""));
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (!a || !b) return null;
  return `${Math.min(a, b)}x${Math.max(a, b)}`;
}

/**
 * Resolve a model from what we actually stored about the device.
 *
 * `hintModel` is a User-Agent Client Hint (Android Chrome's real model string)
 * and always wins when present — it is reported by the device, not inferred.
 */
export function modelFromFingerprint(
  screen: string | undefined,
  ua: string | undefined,
  hintModel?: string,
): ModelFromScreen {
  const hint = String(hintModel || "").trim();
  if (hint && !/^(K|Linux|Android|unknown)$/i.test(hint)) {
    return { label: hint, candidates: [hint], basis: "ua-client-hint" };
  }

  // Viewport inference is Apple-only on purpose (see the header note).
  const isApple = /iPhone|iPad|iPod/i.test(String(ua || ""));
  const key = viewportKey(screen || "");
  if (isApple && key) {
    const candidates = IOS_VIEWPORTS[key];
    if (candidates) {
      return {
        label: candidates.length > 2 ? `${candidates[0]} / ${candidates[1]} / …` : candidates.join(" / "),
        candidates,
        basis: "ios-viewport",
      };
    }
  }
  return { label: "", candidates: [], basis: "unknown" };
}

/**
 * Does the claimed model agree with what the fingerprint says?
 *
 * "unknown" is NOT a mismatch — an unrecognised viewport (a phone newer than
 * this table) must never be reported as the seller lying. Only a viewport we
 * DO recognise, whose candidate list excludes the claim, is a contradiction.
 */
export function modelAgrees(
  claimed: string | undefined,
  fp: ModelFromScreen,
  observedScreen?: string,
): "match" | "mismatch" | "unknown" {
  if (fp.basis === "unknown" || !fp.candidates.length) return "unknown";
  const claim = normModel(claimed);
  if (!claim) return "unknown";

  // EXACT membership, never substring.
  //
  // "iPhone 16 Pro".includes() logic called a 440x956 viewport — which is the
  // 16 Pro MAX — a match for a claimed 16 Pro. They are different phones with
  // materially different trade-in values, so the one comparison that must not
  // be fuzzy is exactly the one that was.
  if (fp.candidates.some((m) => normModel(m) === claim)) return "match";

  // NOT in the candidate list is only a contradiction if we independently know
  // what viewport the claimed model SHOULD have. A phone newer than this table
  // (an iPhone 17, say) may legitimately share a viewport with a model we do
  // know, and reporting that as the seller lying is a false accusation — the
  // same standard the OEM rule holds itself to. Unknown claim → unknown.
  const expected = VIEWPORT_BY_MODEL.get(claim);
  if (!expected) return "unknown";
  const seen = viewportKey(observedScreen || "");
  return seen && expected !== seen ? "mismatch" : "unknown";
}

function normModel(s: string | undefined): string {
  return String(s || "")
    .toLowerCase()
    .replace(/\(.*?\)/g, "")
    .replace(/^(apple|samsung|google)\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Reverse index: a model we know → the viewport it ships. Built once. */
const VIEWPORT_BY_MODEL: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const [key, models] of Object.entries(IOS_VIEWPORTS)) {
    for (const name of models) m.set(normModel(name), key);
  }
  return m;
})();
