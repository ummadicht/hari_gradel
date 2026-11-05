import { createHash, timingSafeEqual } from "node:crypto";

/**
 * WHO MAY SPEND A PAID LOOKUP.
 *
 * `/api/imei/[imei]` spends Phonecheck calls (station GetDeviceInfo, then GSMA
 * CheckEsn) and `/api/imei/ocr` spends a Gemini call. Both were anonymous, with
 * no cache: anyone who found the URL could run up the bill one GET at a time.
 *
 * Three callers are legitimate:
 *   • server — a sibling service (SwapUp) on the same VM, proving itself with
 *     the shared `GRADEIQ_SERVER_KEY` in the `x-gradeiq-server-key` header;
 *   • staff  — a signed-in portal / Keycloak user (desk, enterprise, superadmin);
 *   • seller — GradeIQ's OWN consumer pages (/v2, /inspect, /j/…), which read a
 *     *#06# photo before any session exists. OCR only; never the paid lookup.
 *
 * With no key configured, server-key auth is OFF — the header is ignored and
 * only sessions get in — so shipping this before the env is set breaks nothing
 * but anonymous use.
 */
export const SERVER_KEY_HEADER = "x-gradeiq-server-key";

/**
 * CounterIQ's retail desks, server to server (SUP-72).
 *
 * CounterIQ creates every retail session from its own server, so all the desks
 * on one deployment reach GradeIQ from ONE address — the per-IP limit for
 * anonymous callers would cut the blacklist check off after a handful of
 * phones a day. With `GRADEIQ_RETAIL_KEY` in `x-gradeiq-retail-key`, its
 * session creates get the paid lookup with no daily limit.
 *
 * Narrower than the server key on purpose: it buys IMEI lookups and nothing
 * else. It is NOT trusted to clear a recorded fault on /functional, and it does
 * not open /api/imei — so a copy on a counter VM can cost lookups if it leaks,
 * never grades. Unset = the header is ignored.
 */
export const RETAIL_KEY_HEADER = "x-gradeiq-retail-key";

/** Does `header` carry the secret in env `name`? False when either is empty. */
function carriesSecret(req: Request, header: string, name: string): boolean {
  const want = (process.env[name] || "").trim();
  const got = (req.headers.get(header) || "").trim();
  if (!want || !got) return false;
  // Compare digests, not the strings: equal length always, so timingSafeEqual
  // neither throws on a short guess nor leaks the key's length.
  const a = createHash("sha256").update(got).digest();
  const b = createHash("sha256").update(want).digest();
  return timingSafeEqual(a, b);
}

/** True only when GRADEIQ_SERVER_KEY is set AND this request carries it. */
export function hasServerKey(req: Request): boolean {
  return carriesSecret(req, SERVER_KEY_HEADER, "GRADEIQ_SERVER_KEY");
}

/** True only when GRADEIQ_RETAIL_KEY is set AND this request carries it. */
export function hasRetailKey(req: Request): boolean {
  return carriesSecret(req, RETAIL_KEY_HEADER, "GRADEIQ_RETAIL_KEY");
}

/**
 * A fetch from one of GradeIQ's own pages.
 *
 * `Sec-Fetch-Site` is set by the browser and cannot be changed by page script,
 * so another website cannot borrow a seller's browser to spend our calls.
 * Browsers without it (iOS before 16.4) still send `Origin` on every POST, and
 * that must name this host. A script can forge both headers, and then gets
 * what a seller gets — one OCR call per request — which is why this gate never
 * opens the paid Phonecheck lookup.
 */
export function sameOriginBrowser(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site) return site === "same-origin";
  const origin = req.headers.get("origin");
  if (!origin) return false;
  // Behind Caddy the forwarded host is the one the browser typed.
  const host = (req.headers.get("x-forwarded-host") || req.headers.get("host") || "").split(",")[0].trim();
  try {
    return !!host && new URL(origin).host === host;
  } catch {
    return false;
  }
}

export type PaidCaller = "server" | "staff" | "seller";

/** Who is calling, or null — the route answers 401. */
export async function paidCaller(req: Request, opts: { seller?: boolean } = {}): Promise<PaidCaller | null> {
  if (hasServerKey(req)) return "server";
  try {
    const { portalUser } = await import("./portalAuth");
    if (await portalUser()) return "staff";
  } catch {
    /* no request scope, or the auth store is unreadable — not staff */
  }
  if (opts.seller && sameOriginBrowser(req)) return "seller";
  return null;
}
