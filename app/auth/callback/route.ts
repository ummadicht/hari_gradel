import { NextRequest, NextResponse } from "next/server";
import { finishLogin, IdpError, authLog } from "@/lib/oidc";
import { publicOrigin } from "@/lib/authUrls";
import { withBase } from "@/lib/basePath";

export const dynamic = "force-dynamic";

// Every redirect is built on the PUBLIC origin: behind Caddy `req.url` is
// https://localhost:3700/…, which sent a successful login to localhost.
export async function GET(req: NextRequest) {
  const origin = publicOrigin(req);
  const toLogin = (err: string) => NextResponse.redirect(new URL(withBase(`/login?error=${encodeURIComponent(err)}`), origin));
  let result;
  try {
    result = await finishLogin(new URL(req.url));
  } catch (e) {
    authLog(`sign-in callback failed: ${e instanceof Error ? e.message : String(e)}`);
    return toLogin(e instanceof IdpError ? e.code : "callback_failed");
  }
  if (result.ok) return NextResponse.redirect(new URL(withBase(result.returnTo), origin));
  return toLogin(result.error);
}
