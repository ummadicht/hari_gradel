import { NextRequest, NextResponse } from "next/server";
import { effectiveAuthMode, OIDC_COOKIE, LEGACY_COOKIES } from "@/lib/auth-mode";
// The public origin, NOT the internal one: behind Caddy `req.url` is localhost.
import { publicOrigin } from "@/lib/authUrls";

// GradeIQ had no middleware — every gate was inline. This adds ONE redirect
// choke point for the STAFF areas only. The entire consumer inspection surface
// (/, /inspect, /v2, /staff, /s, /screen, /report, /j, all /api/sessions/*, …)
// is intentionally NOT matched here and stays fully anonymous.
// /configurator rewrites the GLOBAL program config, so it is staff too (SUP-88);
// its API additionally requires a super admin.
const STAFF_PREFIXES = ["/superadmin", "/console", "/enterprise", "/settings", "/channel", "/configurator"];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const isStaff = STAFF_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));
  if (!isStaff) return NextResponse.next();

  const mode = effectiveAuthMode();

  // In legacy mode the working cookie schemes (portal + enterprise) are what
  // count. An OIDC cookie is still honoured, so flipping modes never signs
  // anyone out mid-session.
  const signedIn =
    !!req.cookies.get(OIDC_COOKIE)?.value ||
    (mode === "legacy" && LEGACY_COOKIES.some((c) => !!req.cookies.get(c)?.value));

  if (signedIn) return NextResponse.next();

  // Send unauthenticated staff to a page that can actually sign them in:
  // /auth/login starts the OIDC dance, /login renders the username+password
  // form. Sending them to an OIDC start with no IdP is the lockout.
  const url = new URL(mode === "oidc" ? "/auth/login" : "/login", publicOrigin(req));
  // basePath is applied by Next to router navigations but NOT to a URL we build
  // ourselves here, so it has to be added explicitly.
  const base = process.env.NEXT_PUBLIC_BASE_PATH || "";
  url.pathname = `${base}${url.pathname}`;
  url.searchParams.set("returnTo", pathname.startsWith(base) ? pathname.slice(base.length) || "/" : pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    "/superadmin/:path*",
    "/console/:path*",
    "/enterprise/:path*",
    "/settings/:path*",
    "/channel/:path*",
    "/configurator/:path*",
  ],
};
