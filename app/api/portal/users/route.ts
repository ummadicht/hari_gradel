import { NextRequest, NextResponse } from "next/server";
import {
  portalUser, listStoredUsers, createStoredUser, resetStoredUserPassword,
  deleteStoredUser, isBuiltinUser, type PortalRole,
} from "@/lib/portalAuth";
import { CLIENTS, CLIENT_IDS, isClientId } from "@/lib/clients";
import { effectiveAuthMode } from "@/lib/auth-mode";

// Portal user management (the superadmin "Users & access" tab).
// SUPER manages everyone. A CLIENT admin may only see and mint client-role
// logins for their OWN tenant (store staff for /channel/retail) — never supers,
// never other tenants, never built-ins.

const BUILTINS = [
  { username: "admin", role: "super", clientId: null },
  { username: "altaf", role: "super", clientId: null },
  { username: "denovo", role: "client", clientId: "denovo" },
  { username: "swapmoreus", role: "client", clientId: "swapmore" },
  { username: "swapmoreind", role: "client", clientId: "swapmore-in" },
  { username: "inzman", role: "client", clientId: "inzman" },
] as const;

export async function GET() {
  const user = await portalUser();
  if (!user) return NextResponse.json({ error: "auth required" }, { status: 401 });
  const stored = listStoredUsers().map((u) => ({ ...u, builtin: false }));
  const builtins = BUILTINS.map((u) => ({ ...u, builtin: true, createdBy: "", createdAt: "" }));
  const all = [...builtins, ...stored];
  const visible =
    user.role === "super" ? all : all.filter((u) => u.role === "client" && u.clientId === user.clientId);
  return NextResponse.json({
    users: visible,
    clients: CLIENT_IDS.map((id) => ({ id, name: CLIENTS[id].name })),
    canManageAll: user.role === "super",
  });
}

export async function POST(req: NextRequest) {
  const user = await portalUser();
  if (!user) return NextResponse.json({ error: "auth required" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const op = String(body.op || "create");
  // With Keycloak live, people are managed in Keycloak. A password minted here
  // could not sign in now, and would quietly start working on a rollback.
  if (effectiveAuthMode() === "oidc" && (op === "create" || op === "reset")) {
    return NextResponse.json(
      { error: "Sign-in is managed in Keycloak now — add people and reset passwords in the Keycloak console." },
      { status: 409 },
    );
  }

  try {
    if (op === "create") {
      const role: PortalRole = body.role === "super" ? "super" : "client";
      let clientId: string | null = typeof body.clientId === "string" ? body.clientId : null;
      if (user.role !== "super") {
        // Client admins mint ONLY client-role logins for their own tenant.
        if (role === "super") return NextResponse.json({ error: "only a super admin can create super users" }, { status: 403 });
        clientId = user.clientId;
      }
      if (role === "client" && (!clientId || !isClientId(clientId))) {
        return NextResponse.json({ error: "a client user needs a valid client" }, { status: 400 });
      }
      createStoredUser({
        username: String(body.username || ""),
        password: String(body.password || ""),
        role,
        clientId,
        createdBy: user.username,
      });
      return NextResponse.json({ ok: true });
    }

    // reset / delete — target must be visible to the caller.
    const target = String(body.username || "").toLowerCase().trim();
    if (isBuiltinUser(target)) {
      return NextResponse.json({ error: "built-in accounts rotate via PORTAL_PW_* env, not here" }, { status: 400 });
    }
    if (user.role !== "super") {
      const mine = listStoredUsers().find((u) => u.username === target);
      if (!mine || mine.role !== "client" || mine.clientId !== user.clientId) {
        return NextResponse.json({ error: "forbidden" }, { status: 403 });
      }
    }
    if (op === "reset") {
      resetStoredUserPassword(target, String(body.password || ""));
      return NextResponse.json({ ok: true });
    }
    if (op === "delete") {
      deleteStoredUser(target);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: `unknown op "${op}"` }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 400 });
  }
}
