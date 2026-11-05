import { NextRequest, NextResponse } from "next/server";
import { loadPricebook, savePricebook } from "@/lib/clientPricing";
import type { Pricebook } from "@/lib/pricebook";
import { isClientId } from "@/lib/clients";
import { requireServiceToken } from "@/lib/serviceToken";
import { checkSyncSecret, keycloakM2M } from "@/lib/m2m";

// POST /api/clients/[clientId]/pricebook  { ...Pricebook }
// Receives a pushed pricebook (SwapMore-ERP → GradeIQ feed). With Keycloak
// (KEYCLOAK_ISSUER set): a client_credentials token (client `swapmore-svc`,
// audience `gradeiq`). Without it: SwapMore's `x-sync-secret` header, matched in
// constant time against PRICEBOOK_SYNC_SECRET (401 wrong, 503 unset) — see
// lib/m2m.ts. GradeIQ HOLDS it at data/pricebook-<clientId>.json and prices
// offers from it.
export async function POST(req: NextRequest, { params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  if (!isClientId(clientId)) return NextResponse.json({ error: "unknown client" }, { status: 404 });
  const svc = keycloakM2M()
    ? await requireServiceToken(req, { audience: "gradeiq", azp: "swapmore-svc" })
    : checkSyncSecret(req);
  if (!svc.ok) return NextResponse.json({ error: svc.error }, { status: svc.status });
  const book = (await req.json().catch(() => null)) as Pricebook | null;
  if (!book || book.schema !== 1 || !Array.isArray(book.models) || !book.models.length)
    return NextResponse.json({ error: "invalid pricebook" }, { status: 400 });
  savePricebook(clientId, book);
  return NextResponse.json({ ok: true, models: book.models.length, currency: book.currency });
}

// GET → the stored (or seed) pricebook for the console. Pricing isn't secret.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  if (!isClientId(clientId)) return NextResponse.json({ error: "unknown client" }, { status: 404 });
  const { book, source } = loadPricebook(clientId);
  return NextResponse.json({ source, book });
}
