import { NextRequest, NextResponse } from "next/server";
import { checkLogin, PORTAL_COOKIE } from "@/lib/portalAuth";
import { effectiveAuthMode } from "@/lib/auth-mode";
import { withBase } from "@/lib/basePath";

// POST { username, password } → sets the portal cookie. LEGACY MODE ONLY.
//
// With GIQ_AUTH_MODE=oidc this route does not exist (404) — it must not even
// check the password. It used to: the cookie it handed out granted nothing, but
// "200 for admin/admin, 401 for anything else" still told anyone on the
// internet that the built-in default passwords were live.
export async function POST(req: NextRequest) {
  if (effectiveAuthMode() !== "legacy") {
    return NextResponse.json(
      { error: "Password sign-in is off — GradeIQ uses single sign-on.", signIn: withBase("/auth/login") },
      { status: 404 },
    );
  }
  const body = await req.json().catch(() => ({}));
  const hit = checkLogin(String(body.username || ""), String(body.password || ""));
  if (!hit) return NextResponse.json({ error: "invalid credentials" }, { status: 401 });
  const res = NextResponse.json({ ok: true, user: hit.user });
  res.cookies.set(PORTAL_COOKIE, hit.token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 14, // 2 weeks
  });
  return res;
}
