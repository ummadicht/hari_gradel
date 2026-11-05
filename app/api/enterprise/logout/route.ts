import { NextResponse } from "next/server";
import { ENT_COOKIE } from "@/lib/entAuth";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ENT_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}
