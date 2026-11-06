import { NextRequest, NextResponse } from "next/server";
import { portalUser, scopedClient } from "@/lib/portalAuth";
import { isClientId } from "@/lib/clients";
import { getSetting, setSetting } from "@/lib/settings";
import {
  listPurchases, refreshOffer, settleMockPayout, creditBalance, openingCredit, creditHistory,
} from "@/lib/purchase";
import { razorpayConfigured } from "@/lib/razorpay";

// The superadmin "Retail desk" tab: one client's whole buyback book — purchases,
// credit line, ledger, payout config. Tenant-scoped like every portal API.

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

  const purchases = listPurchases(clientId, 50).map((p) =>
    p.status === "checking" ? refreshOffer(p) : p.status === "paid" ? settleMockPayout(p) : p
  );
  const creditClientId = clientId === "all" ? "swapmore-in" : clientId;
  return NextResponse.json({
    purchases,
    credit: creditBalance(creditClientId),
    opening: openingCredit(creditClientId),
    ledger: creditHistory(creditClientId, 30),
    storeVpa: clientId === "all" ? "" : (getSetting(`payout_vpa:${clientId}`) || ""),
    razorpayLive: razorpayConfigured(),
    isSuper: user.role === "super",
  });
}

export async function POST(req: NextRequest) {
  const user = await portalUser();
  if (!user) return NextResponse.json({ error: "auth required" }, { status: 401 });
  // Credit lines and payout destinations are PLATFORM decisions — super only.
  // A store must not raise its own limit or redirect its own payouts here.
  if (user.role !== "super") return NextResponse.json({ error: "super admin only" }, { status: 403 });
  const body = await req.json().catch(() => ({}));
  const clientId = String(body.client || "");
  if (!isClientId(clientId)) return NextResponse.json({ error: "unknown client" }, { status: 400 });

  const action = String(body.action || "");
  if (action === "set-credit") {
    const v = Number(body.value);
    if (!Number.isFinite(v) || v < 0) return NextResponse.json({ error: "credit must be ≥ 0 (₹ whole rupees)" }, { status: 400 });
    setSetting(`credit:${clientId}`, String(Math.round(v)));
    return NextResponse.json({ ok: true, opening: openingCredit(clientId), credit: creditBalance(clientId) });
  }
  if (action === "set-vpa") {
    const vpa = String(body.value || "").trim().slice(0, 80);
    if (vpa && !/^[\w.-]{2,}@[a-zA-Z]{2,}$/.test(vpa)) {
      return NextResponse.json({ error: "that doesn't look like a UPI VPA (name@bank)" }, { status: 400 });
    }
    setSetting(`payout_vpa:${clientId}`, vpa);
    return NextResponse.json({ ok: true, storeVpa: vpa });
  }
  return NextResponse.json({ error: `unknown action "${action}"` }, { status: 400 });
}
