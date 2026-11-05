// URL helpers for the sign-in redirects. Edge-safe (the middleware uses them):
// no node imports.

/**
 * The public origin, NOT the internal one.
 *
 * Behind Caddy, `req.url` is the internal address — and Next 16 rebuilds it as
 * `https://localhost:3700/...` when Caddy says X-Forwarded-Proto: https (it
 * takes the protocol from the header and keeps its own host). Any redirect
 * built from it sends the browser to localhost: that is how a successful
 * Keycloak login landed on `https://localhost:3700/apps/gradeiq/superadmin`, and
 * how logout offered Keycloak a post-logout URI it rightly refused. The
 * forwarded headers carry the origin the user actually typed.
 *
 * PUBLIC_ORIGIN (e.g. https://swapmore.com) pins it when a proxy can't be
 * trusted to send them.
 */
export function publicOrigin(req: Request): string {
  const pinned = String(process.env.PUBLIC_ORIGIN || "").trim().replace(/\/+$/, "");
  if (/^https?:\/\/[^/]+$/.test(pinned)) return pinned;
  const first = (v: string | null) => (v || "").split(",")[0].trim();
  const own = new URL(req.url);
  const host = first(req.headers.get("x-forwarded-host")) || first(req.headers.get("host"));
  const proto = first(req.headers.get("x-forwarded-proto")) || own.protocol.replace(/:$/, "");
  // A host header is only trusted if it is a plain host[:port]; anything else
  // (paths, userinfo, spaces) falls back to the request's own origin.
  if (/^https?$/.test(proto) && /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(:\d{1,5})?$/.test(host)) {
    return `${proto}://${host}`;
  }
  return own.origin;
}

/**
 * A same-app path to return to after sign-in, or the fallback.
 *
 * Must start with ONE "/" — "//evil.example" and "/\evil.example" are
 * protocol-relative to a browser, so without a basePath in front they are an
 * open redirect.
 */
export function safeReturnTo(raw: string | null | undefined, fallback = "/superadmin"): string {
  const v = String(raw || "");
  if (!v.startsWith("/") || v.startsWith("//") || v.startsWith("/\\")) return fallback;
  return v;
}
