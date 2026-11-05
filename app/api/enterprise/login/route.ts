import { NextRequest, NextResponse } from "next/server";
import { validCreds, makeSession, ENT_COOKIE } from "@/lib/entAuth";
import { effectiveAuthMode } from "@/lib/auth-mode";
import { withBase } from "@/lib/basePath";

// POST { user, pass } → sets the enterprise session cookie on success.
// LEGACY MODE ONLY — with GIQ_AUTH_MODE=oidc it is a 404 and checks nothing, so
// it cannot be used to confirm the denovo/denovo default (see /api/portal/login).
export async function POST(req: NextRequest) {
  if (effectiveAuthMode() !== "legacy") {
    return NextResponse.json(
      { error: "Password sign-in is off — GradeIQ uses single sign-on.", signIn: withBase("/auth/login") },
      { status: 404 },
    );
  }
  const body = await req.json().catch(() => ({}));
  const user = String(body.user ?? "");
  const pass = String(body.pass ?? "");
  if (!validCreds(user, pass))
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });

  const res = NextResponse.json({ ok: true });
  res.cookies.set(ENT_COOKIE, makeSession(), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 12, // 12h shift
  });
  return res;
}
