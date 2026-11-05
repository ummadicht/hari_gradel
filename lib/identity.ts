import type { Session } from "./db";
import {
  defectSignature,
  scoreBindings,
  type Bindings,
  type BindingVerdict,
  type DeviceSignature,
} from "./deviceBinding";

// Anti-fraud identity coupling. The IMEI is scanned into a session; a device
// then scans that session's QR and runs the diagnostics; the inspector
// photographs a device for the cosmetic grade. A compromised collector — or a
// consumer self-trading — could swap devices between those steps (test/scan a
// good phone, photograph a broken one, or vice-versa).
//
// A browser CANNOT read a phone's IMEI (no API — by design), so we can't
// cryptographically prove "this exact handset". What we CAN do is cross-check
// three independent signals that must all describe the SAME device:
//   1. IMEI/TAC        → make + model + OS family        (scanned)
//   2. Connected device→ OS + model from its own browser (QR handoff)
//   3. Photos          → make identified by the Vision AI (cosmetics)
// A conflict (IMEI = Apple iPhone but the connected device is Android, or the
// photos show a Samsung) is a strong swap signal and is flagged loudly.
//
// Honest limit: two handsets of the SAME model can't be told apart this way —
// only a live IMEI/serial attestation (Phonecheck) could, and that isn't wired.

export type IdentityVerdict = "match" | "mismatch" | "unverified";

export type IdentityCheck = {
  verdict: IdentityVerdict;
  flags: string[]; // conflicts found (what looks wrong)
  confirms: string[]; // signals that agreed
  imei: { brand: string; model: string; os: string; modelKnown: boolean; tier: DeviceTier };
  connected: { os: string; model: string; resolved: string; tier: DeviceTier } | null;
  photo: { brand: string } | null;
  /** True only when identity was checked at MODEL/TIER level, not merely brand. */
  modelLevel: boolean;
  /**
   * The wear-pattern fingerprint of this handset. Independent of the IMEI, so it
   * still identifies a device whose IMEI was reflashed — and it behaves the same
   * on iOS as on Android, which model matching does not.
   */
  signature: DeviceSignature;
  /** The four-binding chain. `proven` is the only state worth paying against. */
  bindings: Bindings;
  binding: BindingVerdict;
  note: string; // the honest caveat about same-model swaps
};

const ANDROID_BRANDS =
  /samsung|galaxy|google|pixel|oneplus|xiaomi|redmi|poco|motorola|moto|oppo|vivo|realme|huawei|honor|nokia|sony|xperia|\blg\b|asus|nothing|tcl|infinix|tecno/i;

function osFromBrandModel(brand: string, model: string): string {
  const s = `${brand} ${model}`.trim();
  if (/apple|iphone|ipad|ipod/i.test(s)) return "ios";
  if (ANDROID_BRANDS.test(s)) return "android";
  return "";
}

function osFromUA(ua: string): string {
  const u = ua || "";
  if (/iphone|ipad|ipod/i.test(u)) return "ios";
  if (/android/i.test(u)) return "android";
  return "";
}

// Canonicalise a platform hint (userAgentData.platform / navigator.platform) to
// ONLY ios | android | "". Never trust raw values like "MacIntel" or
// "Linux armv8l" — those come from a desktop test, NOT a phone, and must resolve
// to "" (unknown) so they don't fire a false swap flag against a phone IMEI.
function osFromPlatform(p: string): string {
  const s = (p || "").toLowerCase();
  if (/android/.test(s)) return "android";
  if (/iphone|ipad|ios/.test(s)) return "ios";
  return "";
}

// The device model code out of an Android UA string, e.g.
// "…Android 14; SM-G991B Build/…" → "SM-G991B". iOS UAs carry no model.
function modelFromUA(ua: string): string {
  const m = /android[\s\d.]*;\s*([^;)]+?)(?:\s+build|\)|;)/i.exec(ua || "");
  return m ? m[1].trim() : "";
}

// Map a device model code (from UA or userAgentData) to a brand. Only CONFIDENT
// prefixes map — anything ambiguous returns "" so it never fires a false flag.
function brandFromCode(code: string): string {
  const c = (code || "").toLowerCase();
  if (!c) return "";
  if (/^sm-|^gt-|^sgh|galaxy/.test(c)) return "samsung";
  if (/^pixel/.test(c)) return "google";
  if (/^moto|^xt\d/.test(c)) return "motorola";
  if (/^rmx/.test(c)) return "realme";
  if (/^cph/.test(c)) return "oppo";
  if (/redmi|poco|xiaomi|^m2\d{3}|^23\d{3}|^22\d{3}|^21\d{3}/.test(c)) return "xiaomi";
  if (/oneplus|^kb2|^le2|^in2|^be2|^gm1|^hd1|^cph25/.test(c)) return "oneplus";
  if (/^vivo|^v2\d{3}/.test(c)) return "vivo";
  if (/nokia|^ta-/.test(c)) return "nokia";
  if (/^lm-|^lg-/.test(c)) return "lg";
  if (/zenfone|^asus|^rog/.test(c)) return "asus";
  if (/huawei|^ana-|^ela-|^vog-|^lya-/.test(c)) return "huawei";
  if (/honor|^btv|^bkl|^col-/.test(c)) return "honor";
  return "";
}

function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/* ── Model-level identity ──────────────────────────────────────────────────────
 *
 * Brand agreement is nearly worthless as an anti-swap control. Samsung sells
 * devices from ₹8,000 to ₹1,60,000, so "the IMEI is a Samsung and the connected
 * device is a Samsung" permits precisely the swap that is worth doing: scan a
 * cheap handset's IMEI, run the tests on an expensive one, attach the good grade
 * to the cheap IMEI, and get paid for a device nobody graded.
 *
 * A browser still cannot read an IMEI. But an Android browser DOES report its
 * own model code (SM-F956U1), and that code carries the device's TIER. Comparing
 * tiers catches the swap that costs money even when we can't name the exact
 * model on both sides. */
export type DeviceTier = "fold" | "flagship" | "mid" | "budget" | "";

const TIER_RANK: Record<Exclude<DeviceTier, "">, number> = {
  fold: 4,
  flagship: 3,
  mid: 2,
  budget: 1,
};

/** Samsung model code → marketing name + tier. Prefix-matched, longest first. */
const SAMSUNG_CODES: [RegExp, string, DeviceTier][] = [
  [/^sm-f95/, "Galaxy Z Fold 6", "fold"],
  [/^sm-f94/, "Galaxy Z Fold 5", "fold"],
  [/^sm-f93/, "Galaxy Z Fold 4", "fold"],
  [/^sm-f92/, "Galaxy Z Fold 3", "fold"],
  [/^sm-f9/, "Galaxy Z Fold", "fold"],
  [/^sm-f74/, "Galaxy Z Flip 6", "fold"],
  [/^sm-f73/, "Galaxy Z Flip 5", "fold"],
  [/^sm-f72/, "Galaxy Z Flip 4", "fold"],
  [/^sm-f7/, "Galaxy Z Flip", "fold"],
  [/^sm-s93/, "Galaxy S25", "flagship"],
  [/^sm-s928/, "Galaxy S24 Ultra", "flagship"],
  [/^sm-s92/, "Galaxy S24", "flagship"],
  [/^sm-s918/, "Galaxy S23 Ultra", "flagship"],
  [/^sm-s91/, "Galaxy S23", "flagship"],
  [/^sm-s90/, "Galaxy S22", "flagship"],
  [/^sm-g99/, "Galaxy S21", "flagship"],
  [/^sm-g9/, "Galaxy S", "flagship"],
  [/^sm-n9/, "Galaxy Note", "flagship"],
  [/^sm-a[5-7]/, "Galaxy A-series (mid)", "mid"],
  [/^sm-a[0-4]/, "Galaxy A-series (entry)", "budget"],
  [/^sm-m/, "Galaxy M-series", "budget"],
  [/^sm-e/, "Galaxy F/E-series", "budget"],
];

/** Marketing model string → tier. Used on the IMEI/TAC side, which gives names. */
function tierFromName(name: string): DeviceTier {
  const s = (name || "").toLowerCase();
  if (!s) return "";
  if (/fold|flip/.test(s)) return "fold";
  if (/ultra|pro max|\bpro\b|note\b|galaxy s\d|\bs\d{2}\b|pixel \d+ pro/.test(s)) return "flagship";
  if (/iphone 1[2-9]|iphone se|galaxy a[5-7]|pixel \d+a?\b/.test(s)) return "mid";
  if (/galaxy a[0-4]|galaxy m|redmi|poco|\bgo\b|lite\b/.test(s)) return "budget";
  return "";
}

/** Resolve an Android model code to a marketing name + tier. "" when unknown. */
export function modelFromCode(code: string): { model: string; tier: DeviceTier } {
  const c = (code || "").toLowerCase().trim();
  if (!c) return { model: "", tier: "" };
  for (const [re, model, tier] of SAMSUNG_CODES) {
    if (re.test(c)) return { model, tier };
  }
  if (/^pixel/.test(c)) {
    return { model: cap(c), tier: /pro|xl/.test(c) ? "flagship" : "mid" };
  }
  return { model: "", tier: "" };
}

/**
 * Is this "model" actually just the brand wearing a model's clothes?
 *
 * The TAC lookup returns `model: "Samsung"` when it can resolve the manufacturer
 * but not the device. Treating that as a model is what let a Galaxy Z Fold 6 be
 * graded against it: every Samsung on earth "matches" the string "Samsung".
 */
function isBrandOnly(model: string, brand: string): boolean {
  const m = (model || "").trim().toLowerCase();
  if (!m) return true;
  const b = (brand || "").trim().toLowerCase();
  if (b && m === b) return true;
  // A bare manufacturer name with nothing after it is not a model.
  return /^(samsung|apple|google|oneplus|xiaomi|redmi|poco|motorola|oppo|vivo|realme|huawei|honor|nokia|sony|lg|asus|nothing)$/.test(m);
}

// Coarse brand from a make string, for a brand-vs-brand comparison.
function brandKey(s: string): string {
  const b = (s || "").toLowerCase();
  if (/apple|iphone|ipad/.test(b)) return "apple";
  if (/samsung|galaxy/.test(b)) return "samsung";
  if (/google|pixel/.test(b)) return "google";
  if (/oneplus/.test(b)) return "oneplus";
  if (/xiaomi|redmi|poco/.test(b)) return "xiaomi";
  if (/motorola|moto/.test(b)) return "motorola";
  if (/oppo/.test(b)) return "oppo";
  if (/vivo/.test(b)) return "vivo";
  if (/realme/.test(b)) return "realme";
  if (/huawei/.test(b)) return "huawei";
  if (/honor/.test(b)) return "honor";
  if (/nokia/.test(b)) return "nokia";
  if (/sony|xperia/.test(b)) return "sony";
  return b.split(/\s+/)[0] || "";
}

export function checkIdentity(s: Session): IdentityCheck {
  const imeiInfo = (s.imei_info as any) || {};
  const imeiModel = String(imeiInfo.model || s.model || "");
  const imeiBrand = String(imeiInfo.brand || "");
  // The TAC DB sometimes leaves brand empty and folds it into the model string
  // ("Samsung Galaxy S21"). Derive the brand from the model so the brand
  // cross-checks still work; keep a readable label for the flag text.
  const imeiBrandKey = brandKey(imeiBrand || imeiModel);
  const imeiBrandLabel = imeiBrand || cap(imeiBrandKey) || imeiModel || "the IMEI's device";
  const imeiOS = osFromBrandModel(imeiBrand, imeiModel);

  const fp = ((s.verification as any)?.deviceFp || null) as
    | { ua?: string; os?: string; model?: string }
    | null;
  // Canonical OS only (ios | android | ""). A desktop test resolves to "" and
  // is treated as UNVERIFIED, never a mismatch.
  const connected = fp
    ? { os: osFromUA(fp.ua || "") || osFromPlatform(fp.os || ""), model: String(fp.model || "") }
    : null;

  const photoMake = String(((s.cosmetic as any)?.device?.make) || "");
  const photo = photoMake ? { brand: photoMake } : null;

  const flags: string[] = [];
  const confirms: string[] = [];

  // 1) IMEI OS vs the device that scanned the QR.
  if (imeiOS && connected?.os) {
    if (imeiOS !== connected.os) {
      flags.push(
        `The device that scanned the QR is ${connected.os === "ios" ? "an iPhone/iPad (iOS)" : "an Android"}, but the scanned IMEI is ${imeiBrandLabel} (${imeiOS === "ios" ? "iOS" : "Android"}). Possible device swap.`
      );
    } else {
      confirms.push("Connected device OS matches the IMEI");
    }
  }

  // 2) IMEI brand vs the brand the Vision AI saw in the photos.
  if (imeiBrandKey && photo?.brand) {
    const b = brandKey(photo.brand);
    if (b && imeiBrandKey !== b) {
      flags.push(
        `The photos show a ${photo.brand}, but the scanned IMEI is ${imeiBrandLabel}. The photographed phone may not be the IMEI's phone.`
      );
    } else if (b && imeiBrandKey === b) {
      confirms.push("Photographed brand matches the IMEI");
    }
  }

  // 3) BRAND from the connected device's UA / model code vs the IMEI brand.
  //    Catches a same-OS swap the OS check misses (IMEI Samsung, but an Android
  //    Xiaomi scanned the QR). Only confident model-code→brand maps are used.
  const uaModelCode = (fp?.model && String(fp.model)) || modelFromUA(fp?.ua || "");
  const uaBrand = brandFromCode(uaModelCode);
  if (imeiBrandKey && uaBrand) {
    if (imeiBrandKey !== uaBrand) {
      flags.push(
        `The connected device reports as a ${cap(uaBrand)}${uaModelCode ? ` (${uaModelCode})` : ""}, but the scanned IMEI is ${imeiBrandLabel}. Possible device swap.`
      );
    } else {
      confirms.push(`Connected device model ${uaModelCode} matches ${imeiBrandLabel}`);
    }
  }

  /**
   * An IMEI that fails its own checksum cannot "match" anything.
   *
   * The TAC lookup happily resolves the first 8 digits of an invalid number, so
   * a mistyped IMEI still produced a brand and model — and when the photos
   * showed that same brand, the report announced "IMEI matches device ✓". The
   * cross-checks were comparing the phone against a number we already knew was
   * not a real IMEI. Brand agreement is still worth stating, so the confirms
   * survive; the VERDICT does not get to claim verification.
   */
  const imeiPresent = String(imeiInfo.imei || s.imei || "").length > 0;
  const imeiInvalid = imeiPresent && imeiInfo.valid === false;
  if (imeiInvalid) {
    flags.push(
      "The IMEI entered fails its checksum, so it isn't a valid IMEI — anything derived from it (brand, model, blacklist) is unverified.",
    );
  }

  /* The paid registry lookup was held back for this caller (lib/lookupBudget.ts:
   * the daily limit for their address or for all anonymous callers together, or
   * no right to one). The make and model
   * then come from the IMEI's first eight digits alone and nobody asked whether
   * it is blacklisted — a model-level agreement with that must not read as a
   * verified identity. */
  if (imeiPresent && (imeiInfo.skipped === "daily-cap" || imeiInfo.skipped === "total-cap" || imeiInfo.skipped === "no-channel")) {
    flags.push(
      "This IMEI was not checked against the device registry (" +
        (imeiInfo.skipped === "no-channel" ? "lookups are limited to known channels" : "the daily lookup limit was reached") +
        "), so its make and model come from the IMEI alone and its blacklist status is unknown. Identity is unverified until staff look it up.",
    );
  }

  /* 4) MODEL and TIER — the check that actually stops the swap worth doing.
   *
   * Brand agreement alone permits swapping a budget handset for a foldable. The
   * connected device reports its own model code, which resolves to a tier; the
   * TAC gives a model name, which also resolves to a tier. A tier jump between
   * them is a hard mismatch — that is a cheap phone's IMEI wearing an expensive
   * phone's grade. */
  const imeiModelKnown = !isBrandOnly(imeiModel, imeiBrand);
  const imeiTier = imeiModelKnown ? tierFromName(imeiModel) : "";
  const resolvedConn = modelFromCode(uaModelCode);
  let modelLevel = false;

  if (imeiModelKnown && resolvedConn.tier && imeiTier) {
    modelLevel = true;
    if (resolvedConn.tier !== imeiTier) {
      const jump = Math.abs(TIER_RANK[resolvedConn.tier] - TIER_RANK[imeiTier]);
      flags.push(
        `The device that ran the tests reports as ${uaModelCode} (${resolvedConn.model}), but the scanned IMEI resolves to ${imeiModel}. These are different classes of device${jump >= 2 ? " — a large value gap" : ""}. The grade cannot be attributed to the IMEI's phone.`
      );
    } else {
      confirms.push(`Connected device ${resolvedConn.model} is the same class as ${imeiModel}`);
    }
  }

  /* The case that produced this control: the TAC resolved only a BRAND, so
   * there was no model to compare and every Samsung on earth "matched". Absence
   * of information must never render as verification. */
  if (!imeiModelKnown && imeiPresent) {
    flags.push(
      `The IMEI resolves only to the brand${imeiBrand ? ` ${imeiBrand}` : ""} — no model. ` +
        (resolvedConn.model || uaModelCode
          ? `The device that ran the tests reports as ${uaModelCode}${resolvedConn.model ? ` (${resolvedConn.model})` : ""}. `
          : "") +
        `Identity cannot be confirmed below brand level, so this grade is NOT tied to a specific handset.`
    );
  }

  /* A mismatch is evidence of a swap. Everything else that falls short —
   * brand-only agreement, an unresolvable model, an invalid IMEI — is
   * UNVERIFIED, never "match". A check that cannot fail is not a check, and
   * brand-level agreement is a check that cannot fail. */
  const swapEvidence = flags.some((f) => /different classes of device|Possible device swap|may not be the IMEI/i.test(f));
  const verdict: IdentityVerdict = swapEvidence
    ? "mismatch"
    : modelLevel && !flags.length
      ? "match"
      : "unverified";

  /* Wear-pattern fingerprint — computed for EVERY graded device, whether or not
   * anything compares it today. Stored, it becomes the asset that lets the same
   * physical handset be recognised at another counter under a different IMEI. */
  const signature = defectSignature(((s.cosmetic as any)?.findings || []) as never[]);

  /* The binding chain. `nonce` and `imeiPhoto` are ABSENT until the capture flow
   * collects them — absent, deliberately, not "pass". Reporting a binding we did
   * not perform is precisely the defect this whole module exists to correct. */
  const bindings: Bindings = {
    nonce: (s.verification as any)?.nonce?.verified === true
      ? "pass"
      : (s.verification as any)?.nonce?.verified === false
        ? "fail"
        : "absent",
    imeiPhoto: (s.verification as any)?.imeiPhoto?.matched === true
      ? "pass"
      : (s.verification as any)?.imeiPhoto?.matched === false
        ? "fail"
        : "absent",
    continuity: ((s.verification as any)?.continuity?.verdict as Bindings["continuity"]) || "absent",
    deviceClass: verdict,
  };
  const binding = scoreBindings(bindings);

  return {
    verdict,
    flags,
    confirms,
    signature,
    bindings,
    binding,
    imei: { brand: imeiBrand, model: imeiModel, os: imeiOS, modelKnown: imeiModelKnown, tier: imeiTier },
    connected: connected
      ? { ...connected, resolved: resolvedConn.model, tier: resolvedConn.tier }
      : null,
    photo,
    modelLevel,
    note:
      "A browser can't read a phone's IMEI, so identity is cross-checked from OS, model code and photos — it can't distinguish two handsets of the SAME model. Brand agreement alone is never treated as verification.",
  };
}
