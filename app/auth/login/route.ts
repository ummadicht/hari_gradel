import { NextRequest, NextResponse } from "next/server";
import { startLogin, IdpError, authLog } from "@/lib/oidc";
import { effectiveAuthMode, oidcMissingEnv } from "@/lib/auth-mode";
import { publicOrigin, safeReturnTo } from "@/lib/authUrls";
import { withBase } from "@/lib/basePath";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const returnTo = safeReturnTo(req.nextUrl.searchParams.get("returnTo"));
  // Behind Caddy `req.url` is the internal origin — building a redirect from it
  // sends the BROWSER to localhost. Use the public origin instead.
  const origin = publicOrigin(req);
  const toLogin = (err?: string) =>
    NextResponse.redirect(
      new URL(withBase(`/login?returnTo=${encodeURIComponent(returnTo)}${err ? `&error=${err}` : ""}`), origin)
    );

  // Legacy: no IdP handshake — send the user to the password form that works.
  if (effectiveAuthMode() !== "oidc") return toLogin();

  // oidc but half-configured: say so (names only, never values) instead of
  // starting a handshake that can only fail after the password step.
  const missing = oidcMissingEnv();
  if (missing.length) {
    authLog(`GIQ_AUTH_MODE=oidc but ${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} not set — staff sign-in is unavailable until it is (or GIQ_AUTH_MODE=legacy + restart to roll back)`);
    return toLogin("sso_misconfigured");
  }
  try {
    return NextResponse.redirect(await startLogin(returnTo));
  } catch (e) {
    const code = e instanceof IdpError ? e.code : "idp_unavailable";
    authLog(`sign-in could not start: ${e instanceof Error ? e.message : String(e)}`);
    return toLogin(code);
  }
}
