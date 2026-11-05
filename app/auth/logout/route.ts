import { NextRequest, NextResponse } from "next/server";
import { endLogin, authLog } from "@/lib/oidc";
import { PORTAL_COOKIE } from "@/lib/portalAuth";
import { ENT_COOKIE } from "@/lib/entAuth";
import { publicOrigin } from "@/lib/authUrls";
import { withBase } from "@/lib/basePath";

export const dynamic = "force-dynamic";

// Sign out of GradeIQ (always, even with Keycloak down), then of Keycloak.
// post_logout_redirect_uri is the PUBLIC /login — the realm only allows
// https://swapmore.com/apps/gradeiq/*, so an internal localhost URI was refused
// and the Keycloak session survived the logout.
async function handle(req: NextRequest) {
  const login = `${publicOrigin(req)}${withBase("/login")}`;
  let to = login;
  try {
    to = await endLogin(login);
  } catch (e) {
    authLog(`logout: ${e instanceof Error ? e.message : String(e)}`);
  }
  const res = NextResponse.redirect(to);
  res.cookies.set(PORTAL_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  res.cookies.set(ENT_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
export const GET = handle;
export const POST = handle;
