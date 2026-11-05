import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { PORTAL_COOKIE } from "@/lib/portalAuth";
import { ENT_COOKIE } from "@/lib/entAuth";
import { SESSION_COOKIE } from "@/lib/oidc-session";
import { endLogin } from "@/lib/oidc";
import { publicOrigin } from "@/lib/authUrls";
import { withBase } from "@/lib/basePath";

// POST → sign out of whatever this browser is signed in with.
//
// The console's "Sign out" button calls this. It used to clear only the legacy
// portal cookie, so a Keycloak sign-in survived it (the API still answered 200
// for "me" afterwards). Now a Keycloak session is revoked here too, and the
// response carries `redirect` — Keycloak's end-session URL — for the page to
// follow so the single-sign-on session ends as well.
export async function POST(req: NextRequest) {
  let redirect: string | undefined;
  if ((await cookies()).get(SESSION_COOKIE)?.value) {
    redirect = await endLogin(`${publicOrigin(req)}${withBase("/login")}`);
  }
  const res = NextResponse.json({ ok: true, ...(redirect ? { redirect } : {}) });
  res.cookies.set(PORTAL_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  res.cookies.set(ENT_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
