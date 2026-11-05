import { NextRequest, NextResponse } from "next/server";
import { portalUser, scopedClient } from "@/lib/portalAuth";
import { isClientId } from "@/lib/clients";
import { catalogFor, saveCatalog, resetCatalog } from "@/lib/priceCatalog";

// The grade & fault price catalog, per client. Scope is enforced by
// scopedClient(): a client admin can only ever read/write their own tenant.
//
// GET    ?client=…              → that client's catalog (+ whether it's saved or default)
// POST   ?client=… {catalog}    → save it (normalized, clamped, currency from the registry)
// DELETE ?client=…              → revert to the starter defaults for that currency

export async function GET(req: NextRequest) {
  const user = await portalUser();
  if (!user) return NextResponse.json({ error: "auth required" }, { status: 401 });
  const scope = scopedClient(user, req.nextUrl.searchParams.get("client"), isClientId);
  if (!scope.ok) return NextResponse.json({ error: scope.error }, { status: scope.status });
  return NextResponse.json({ clientId: scope.clientId, catalog: catalogFor(scope.clientId) });
}

export async function POST(req: NextRequest) {
  const user = await portalUser();
  if (!user) return NextResponse.json({ error: "auth required" }, { status: 401 });
  const scope = scopedClient(user, req.nextUrl.searchParams.get("client"), isClientId);
  if (!scope.ok) return NextResponse.json({ error: scope.error }, { status: scope.status });
  const body = await req.json().catch(() => ({}));
  const catalog = saveCatalog(scope.clientId, body.catalog, user.username);
  return NextResponse.json({ ok: true, clientId: scope.clientId, catalog });
}

export async function DELETE(req: NextRequest) {
  const user = await portalUser();
  if (!user) return NextResponse.json({ error: "auth required" }, { status: 401 });
  const scope = scopedClient(user, req.nextUrl.searchParams.get("client"), isClientId);
  if (!scope.ok) return NextResponse.json({ error: scope.error }, { status: scope.status });
  return NextResponse.json({ ok: true, clientId: scope.clientId, catalog: resetCatalog(scope.clientId) });
}
