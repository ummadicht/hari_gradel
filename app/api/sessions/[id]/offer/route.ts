import { NextResponse } from "next/server";
import { db, getSession } from "@/lib/db";
import { resolveImei } from "@/lib/imeiCache";
import { lookupGrant } from "@/lib/lookupBudget";
import { computeOffer } from "@/lib/offer";
import { getProgramConfig } from "@/lib/programConfig";
import { logEvent } from "@/lib/events";
import { effectiveCatalog } from "@/lib/priceCatalog";
import { marketBaseFor } from "@/lib/clientPricing";

// POST /api/sessions/[id]/offer  -> pull diagnostics + compute the AI offer
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const s = getSession(id);
  if (!s) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Trusted diagnostics (Phonecheck) — from the per-IMEI cache (24 h), so a
  // report page that re-prices on every view no longer pays for every view.
  // A miss is paid only under the session-create rules (lib/lookupBudget.ts).
  const phonecheck = s.imei
    ? (await resolveImei(s.imei, Date.now(), await lookupGrant(req, { client: s.client_id, channel: s.profile?.channel })))
        .phonecheck ?? (s.phonecheck as any)
    : (s.phonecheck as any);

  // The money model for THIS tenant, in THIS tenant's currency — grade
  // multipliers, fault repair costs, battery rule, margin, promo. Editable in
  // the console (Pricing → grade & fault catalog).
  const catalog = effectiveCatalog(s.client_id);
  // Base must be denominated in the same currency. For a non-USD tenant with no
  // book of its own that's `null`, and the engine refuses to quote rather than
  // dressing a dollar figure up in the local symbol.
  const base = marketBaseFor(s.client_id, catalog.currency, s.model, (s as { model_id?: string }).model_id);

  const offer = computeOffer({
    model: s.model,
    catalog,
    marketBase: catalog.currency === "USD" && base === null ? undefined : base,
    cosmetic: {
      grade: s.cosmetic_grade,
      conclusive: (s.cosmetic as any).conclusive,
      gradeRange: (s.cosmetic as any).gradeRange,
      // A seller's unchecked pick is priced at the lowest grade (lib/offer.ts).
      provisional: (s.cosmetic as any).provisional,
    },
    functional: s.functional,
    imei: s.imei_info as any,
    phonecheck,
    pricing: getProgramConfig().pricing,
    // Vision hard-stops: a case hiding the device, a model that doesn't match
    // the claim, or suspected aftermarket parts must block the auto-offer.
    vision: {
      obstruction: (s.cosmetic as any)?.obstruction,
      deviceMatch: (s.cosmetic as any)?.device?.match,
      oemVerdict: (s.cosmetic as any)?.oem?.verdict,
    },
  });

  db.prepare(
    "UPDATE sessions SET phonecheck = ?, offer = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(JSON.stringify(phonecheck), JSON.stringify(offer), id);

  logEvent(id, "offer", offer.blocked ? "offer-blocked" : "offer-computed", {
    offer: offer.offer,
    currency: offer.currency,
    blocked: offer.blocked,
    needsModel: offer.needsModel,
    flags: offer.flags?.slice(0, 3),
  });
  return NextResponse.json({ ok: true, phonecheck, offer });
}
