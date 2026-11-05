import { NextRequest, NextResponse } from "next/server";
import { portalUser } from "@/lib/portalAuth";
import { getSession } from "@/lib/db";
import { getSetting } from "@/lib/settings";
import {
  getPurchase, refreshOffer, acceptOffer, declineOffer, saveKyc,
  verifyClearance, autoClearance, claimPayout, commitPayout, releasePayout,
  reversePayout, settleMockPayout, creditBalance,
} from "@/lib/purchase";
import { payoutToUpi, razorpayConfigured } from "@/lib/razorpay";

// One purchase: read (with live offer + auto-clearance), and the staged actions
// accept | decline | kyc | clearance | pay. Every action re-checks tenant scope.

async function authorized(id: string) {
  const user = await portalUser();
  if (!user) return { error: NextResponse.json({ error: "auth required" }, { status: 401 }) };
  const p = getPurchase(id);
  if (!p) return { error: NextResponse.json({ error: "not found" }, { status: 404 }) };
  if (user.role !== "super" && user.clientId !== p.client_id) {
    return { error: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  }
  return { user, p };
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const a = await authorized(id);
  if ("error" in a) return a.error;
  const p = settleMockPayout(refreshOffer(a.p));
  const s = p.session_id ? getSession(p.session_id) : null;
  return NextResponse.json({
    purchase: p,
    auto: autoClearance(s),
    credit: creditBalance(p.client_id),
    razorpay: razorpayConfigured(),
    storeVpa: getSetting(`payout_vpa:${p.client_id}`) || null,
  });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const a = await authorized(id);
  if ("error" in a) return a.error;
  const body = await req.json().catch(() => ({}));
  const action = String(body.action || "");

  try {
    if (action === "accept") return NextResponse.json({ purchase: acceptOffer(id) });
    if (action === "decline") return NextResponse.json({ purchase: declineOffer(id) });
    if (action === "kyc") {
      return NextResponse.json({
        purchase: saveKyc(id, {
          idType: String(body.idType || ""),
          idLast4: String(body.idLast4 || ""),
          idName: String(body.idName || ""),
          address: String(body.address || ""),
        }),
      });
    }
    if (action === "clearance") {
      return NextResponse.json({
        purchase: verifyClearance(id, a.user.username, {
          simRemoved: !!body.simRemoved,
          factoryReset: !!body.factoryReset,
          fmipVisuallyOff: !!body.fmipVisuallyOff,
        }),
      });
    }
    if (action === "pay") {
      const pre = getPurchase(id)!;
      // Destination: the STORE's registered UPI (settings payout_vpa:<clientId>).
      // The store settles the customer directly; the platform settles the store
      // and draws down its credit line.
      const vpa = getSetting(`payout_vpa:${pre.client_id}`) || "";
      if (razorpayConfigured() && !vpa) {
        throw new Error("No store UPI on file — set payout_vpa:<client> in Settings first.");
      }
      // RESERVE first — atomically re-checks status/currency/balance, deducts
      // the credit, and claims "paying". A concurrent second request fails HERE,
      // before any money can move. (See lib/purchase.ts claim/commit/release.)
      const { amount } = claimPayout(id);
      let result;
      try {
        result = await payoutToUpi({
          name: pre.client_id,
          phone: String(pre.customer?.phone || ""),
          vpa,
          amountINR: amount,
          ref: pre.id,
        });
      } catch (e) {
        // External call failed → refund the reservation, persist the failure.
        const purchase = releasePayout(id, e instanceof Error ? e.message : "Razorpay call failed");
        return NextResponse.json(
          { error: `Payout failed — credit was not consumed. ${e instanceof Error ? e.message : ""}`.trim(), purchase },
          { status: 502 }
        );
      }
      if (result.status === "failed") {
        const purchase = releasePayout(id, result.note || "Payout rejected");
        return NextResponse.json(
          { error: result.note || "Payout failed — credit was not consumed.", purchase },
          { status: 502 }
        );
      }
      // Success (processed or queued) → commit. Balance was reserved at claim,
      // so this cannot fail on funds — a successful payout is always recorded.
      const purchase = commitPayout(id, {
        method: result.method,
        payoutId: result.payoutId,
        utr: result.utr,
        amount,
        currency: "INR",
        vpa: vpa || undefined,
        status: result.status,
        at: new Date().toISOString(),
        note: result.note,
      });
      return NextResponse.json({ purchase, credit: creditBalance(purchase.client_id) });
    }
    if (action === "reverse") {
      // Operational credit-back when RazorpayX reverses an async payout —
      // SUPER only (it mints credit; a store must not reverse itself).
      if (a.user.role !== "super") {
        return NextResponse.json({ error: "super admin only" }, { status: 403 });
      }
      const purchase = reversePayout(id, a.user.username, String(body.reason || "reversed"));
      return NextResponse.json({ purchase, credit: creditBalance(purchase.client_id) });
    }
    return NextResponse.json({ error: `unknown action "${action}"` }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 400 });
  }
}
