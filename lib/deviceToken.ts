/**
 * A STABLE PER-BROWSER TOKEN — so two identical handsets stop looking identical.
 *
 * THE GAP THIS CLOSES. The device-swap check compares model, OS, screen and
 * browser build. On the reported session all three records read
 * "iPhone / iOS 18 / Safari 26", so the console could only say:
 *
 *   "Started and tested on the same phone — but the camera device looks like
 *    that same phone too."
 *
 * It could not tell one iPhone from another iPhone on the same build, and said
 * so honestly rather than guessing. That is the limit of anything derivable
 * from a user agent: those strings describe a MODEL, not a HANDSET.
 *
 * A random token minted once per browser and echoed back on every request is a
 * different kind of evidence. Two identical phones get two different tokens, so
 * "started here, tested there" becomes answerable instead of unknowable.
 *
 * WHAT IT PROVES, EXACTLY. That two requests came from the same BROWSER
 * PROFILE. That is not the same claim as "the same physical phone", and the
 * difference matters in both directions:
 *
 *   • Same token → same browser → same device. Safe to assert.
 *   • DIFFERENT token → a different browser profile. That is usually a
 *     different phone, but it is also what you get from private browsing, a
 *     cleared website data, or the seller opening the QR in Chrome when the
 *     session began in Safari. So a differing token ALONE is not proof of a
 *     swap, and lib/deviceMatch weighs it against the hardware signals rather
 *     than treating it as a verdict.
 *
 * Stored in BOTH a cookie and localStorage on purpose. The cookie is what the
 * server reads automatically on every request, so no call site has to remember
 * to attach it. localStorage is the backstop for the cookie being dropped
 * mid-session — a cross-site navigation, an in-app browser handoff, or a
 * privacy setting that clears cookies but not storage — and it carries the
 * expiry, since localStorage has none of its own.
 *
 * It is SHORT-LIVED and does not renew. See TOKEN_TTL_MS.
 */

export const DEVICE_TOKEN_COOKIE = "giq_dev";
const STORE_KEY = "giq_dev_token";

/**
 * SHORT-LIVED ON PURPOSE — 12 hours.
 *
 * This token exists to answer one question inside ONE inspection: is the phone
 * being tested the phone the session started on? A real session runs minutes
 * (the reported one spanned nine), so twelve hours covers a counter shift with
 * interruptions and retakes, and nothing beyond that.
 *
 * It started at a year, which was wrong. A year-long identifier that every
 * consumer's phone carries across every visit is a tracking cookie, and it
 * collects linkage the product has no use for — the same customer returning in
 * six months is not a question this check asks.
 *
 * Expiring it costs nothing: a token that lapses mid-session produces a
 * DIFFERENT token with identical hardware, which lib/deviceMatch deliberately
 * reports as "unknown" rather than as a swap. The failure mode of too-short is
 * a shrug; the failure mode of too-long is surveillance.
 */
export const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

/** What we persist: the token plus when it stops being reusable. */
type Stored = { t: string; exp: number };

/**
 * Decide what to reuse from storage.
 *
 * Pure so the expiry rule is testable without a browser — and it needs to be,
 * because the TTL is enforced HERE rather than by the cookie. localStorage has
 * no expiry of its own, so a short cookie alone would be theatre: the mirror
 * would hand the same token back forever and reseed the cookie every visit.
 */
export function reuseFromStore(raw: string | null, now: number): { token: string; exp: number } | null {
  if (!raw) return null;
  // Legacy plain-string tokens (written before the TTL) are treated as expired
  // rather than migrated — they are the unbounded values this change removes.
  if (!raw.startsWith("{")) return null;
  try {
    const v = JSON.parse(raw) as Partial<Stored>;
    if (typeof v?.t !== "string" || !v.t) return null;
    if (typeof v?.exp !== "number" || !Number.isFinite(v.exp)) return null;
    // The expiry is carried through UNCHANGED, never extended — see below.
    return v.exp > now ? { token: v.t, exp: v.exp } : null;
  } catch {
    return null;
  }
}

function mint(): string {
  try {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  } catch {
    // No crypto (ancient webview) — still better than nothing, and the token is
    // an identifier, never a secret.
    return `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  }
}

function readCookie(name: string): string {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(document.cookie || "");
  return m ? decodeURIComponent(m[1]) : "";
}

/**
 * Get this browser's token, creating it on first visit. Client-only.
 *
 * Never throws: a browser with cookies and storage both blocked simply has no
 * token, and the swap check falls back to the hardware signals it used before.
 * A privacy-hardened browser should degrade to the old behaviour, not break the
 * inspection.
 */
export function ensureDeviceToken(): string {
  if (typeof window === "undefined") return "";
  try {
    const now = Date.now();
    let t = "";
    /* THE EXPIRY DOES NOT SLIDE.
     *
     * Refreshing `exp` on every page load would make the token immortal for
     * anyone who uses the app regularly — a rolling window is a permanent
     * identifier wearing a short-TTL costume. So the deadline is set once, when
     * the token is minted, and carried through untouched until it lapses and a
     * new token is created. */
    let exp = 0;
    try {
      const kept = reuseFromStore(window.localStorage.getItem(STORE_KEY), now);
      if (kept) {
        t = kept.token;
        exp = kept.exp;
      }
    } catch {
      /* storage blocked — fall through to the cookie */
    }
    // A readable cookie is by definition unexpired, but its remaining life is
    // not knowable from JS, so it is treated as a fresh window.
    if (!t) {
      t = readCookie(DEVICE_TOKEN_COOKIE);
      if (t) exp = now + TOKEN_TTL_MS;
    }
    if (!t) {
      t = mint();
      exp = now + TOKEN_TTL_MS;
    }

    try {
      const rec: Stored = { t, exp };
      window.localStorage.setItem(STORE_KEY, JSON.stringify(rec));
    } catch {
      /* storage blocked — the cookie alone will have to carry it */
    }
    // Cookie max-age tracks the REMAINING life, so it dies with the token
    // rather than being renewed to a full window on every visit.
    const remaining = Math.max(1, Math.floor((exp - now) / 1000));
    document.cookie = `${DEVICE_TOKEN_COOKIE}=${encodeURIComponent(t)}; path=/; max-age=${remaining}; SameSite=Lax`;
    return t;
  } catch {
    return "";
  }
}

/** Server side: the token this request's browser is carrying, if any. */
export function deviceTokenFromCookie(cookieHeader?: string | null): string {
  if (!cookieHeader) return "";
  const m = new RegExp(`(?:^|;\\s*)${DEVICE_TOKEN_COOKIE}=([^;]*)`).exec(cookieHeader);
  if (!m) return "";
  try {
    return decodeURIComponent(m[1]).slice(0, 64);
  } catch {
    return m[1].slice(0, 64);
  }
}
