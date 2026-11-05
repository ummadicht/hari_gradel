import { NextRequest, NextResponse } from "next/server";
import { portalUser, scopedClient } from "@/lib/portalAuth";
import { isClientId } from "@/lib/clients";
import { createPurchase, listPurchases, refreshOffer, settleMockPayout, creditBalance } from "@/lib/purchase";

// The retail desk's purchase book. Auth = the portal cookie; scope = the
// login's tenant (a client login can never read or write another store's book).

export async function GET(req: NextRequest) {
  const user = await portalUser();
  if (!user) return NextResponse.json({ error: "auth required" }, { status: 401 });
  const scope = scopedClient(user, req.nextUrl.searchParams.get("client"), isClientId);
  if (!scope.ok) return NextResponse.json({ error: scope.error }, { status: scope.status });

  // Refresh offers + settle mock payouts lazily on read — the desk polls this
  // list while a check runs or a mock payout is settling.
  const purchases = listPurchases(scope.clientId).map((p) =>
    p.status === "checking" ? refreshOffer(p) : p.status === "paid" ? settleMockPayout(p) : p
  );
  return NextResponse.json({ purchases, credit: creditBalance(scope.clientId) });
}

export async function POST(req: NextRequest) {
  const user = await portalUser();
  if (!user) return NextResponse.json({ error: "auth required" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const scope = scopedClient(user, body.client, isClientId);
  if (!scope.ok) return NextResponse.json({ error: scope.error }, { status: scope.status });

  try {
    const p = createPurchase(scope.clientId, user.username, {
      name: String(body.name || ""),
      phone: String(body.phone || ""),
    });
    return NextResponse.json({ purchase: p });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "bad request" }, { status: 400 });
  }
}
