import { NextRequest, NextResponse } from "next/server";
import { portalUser, scopedClient } from "@/lib/portalAuth";
import { isClientId, type ClientId } from "@/lib/clients";
import { journeyFor, saveJourney } from "@/lib/journeyConfig";

// GET  ?client=…            → that client's journey config (scoped)
// POST ?client=… {journey}  → save it (scoped, validated)
export async function GET(req: NextRequest) {
  const user = await portalUser();
  if (!user) return NextResponse.json({ error: "auth required" }, { status: 401 });
  const scope = scopedClient(user, req.nextUrl.searchParams.get("client"), isClientId);
  if (!scope.ok) return NextResponse.json({ error: scope.error }, { status: scope.status });
  return NextResponse.json({ clientId: scope.clientId, journey: journeyFor(scope.clientId) });
}

export async function POST(req: NextRequest) {
  const user = await portalUser();
  if (!user) return NextResponse.json({ error: "auth required" }, { status: 401 });
  const scope = scopedClient(user, req.nextUrl.searchParams.get("client"), isClientId);
  if (!scope.ok) return NextResponse.json({ error: scope.error }, { status: scope.status });
  const body = await req.json().catch(() => ({}));
  const journey = saveJourney(scope.clientId as ClientId, body.journey);
  return NextResponse.json({ ok: true, clientId: scope.clientId, journey });
}
