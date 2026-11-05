import { NextResponse } from "next/server";
import { portalUser } from "@/lib/portalAuth";
import { CLIENTS, CLIENT_IDS } from "@/lib/clients";
import { effectiveAuthMode } from "@/lib/auth-mode";
import { withBase } from "@/lib/basePath";

// Who am I + which clients can I see (drives the portal's client selector).
// Signed out: 401, plus `signIn` when sign-in is Keycloak, so a page holding a
// dead session cookie goes to single sign-on instead of drawing a password form
// that no longer works.
export async function GET() {
  const user = await portalUser();
  if (!user) {
    return NextResponse.json(
      { user: null, ...(effectiveAuthMode() === "oidc" ? { signIn: withBase("/auth/login") } : {}) },
      { status: 401 },
    );
  }
  const visible = user.role === "super" ? CLIENT_IDS : user.clientId ? [user.clientId] : [];
  return NextResponse.json({
    user,
    clients: visible.map((id) => ({ id, name: CLIENTS[id].name, currency: CLIENTS[id].currency })),
  });
}
