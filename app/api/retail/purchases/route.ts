import { NextRequest, NextResponse } from "next/server";
import { portalUser, scopedClient } from "@/lib/portalAuth";
import { isClientId } from "@/lib/clients";
import { createPurchase, listPurchases, refreshOffer, settleMockPayout, creditBalance } from "@/lib/purchase";

// The retail desk's purchase book. Auth = the portal cookie; scope = the
// login's tenant (a client login can never read or write another store's book).

export async function GET(req: NextRequest) {
  const user = await portalUser();
  if (!user) return NextResponse.json({ error: "auth required" }, { status: 401 });

  const requested = req.nextUrl.searchParams.get("client");
  let clientId = "";
  if (user.role === "super" && requested === "all") {
    clientId = "all";
  } else {
    const scope = scopedClient(user, requested, isClientId);
    if (!scope.ok) return NextResponse.json({ error: scope.error }, { status: scope.status });
    clientId = scope.clientId;
  }

  // Refresh offers + settle mock payouts lazily on read — the desk polls this
  // list while a check runs or a mock payout is settling.
  const purchases = listPurchases(clientId).map((p) =>
    p.status === "checking" ? refreshOffer(p) : p.status === "paid" ? settleMockPayout(p) : p
  );
  const creditClientId = clientId === "all" ? "swapmore-in" : clientId;
  return NextResponse.json({ purchases, credit: creditBalance(creditClientId) });
}

export async function POST(req: NextRequest) {
  const user = await portalUser();
  if (!user) return NextResponse.json({ error: "auth required" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const scope = scopedClient(user, body.client, isClientId);
  if (!scope.ok) return NextResponse.json({ error: scope.error }, { status: scope.status });

  try {
    const p = createPurchase(
      scope.clientId,
      user.username,
      {
        name: String(body.name || ""),
        phone: String(body.phone || ""),
      },
      {
        imei: String(body.imei || ""),
        model: String(body.model || ""),
        timezone: String(body.timezone || req.headers.get("x-vercel-ip-timezone") || "UTC"),
        recordedAt: String(body.recordedAt || new Date().toISOString()),
        storeId: String(body.storeId || ""),
        storeName: String(body.storeName || ""),
        branch: String(body.branch || ""),
        storePhone: String(body.storePhone || ""),
        address: String(body.address || ""),
        city: String(body.city || ""),
      }
    );
    return NextResponse.json({ purchase: p });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "bad request" }, { status: 400 });
  }
}
