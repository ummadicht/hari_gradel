import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/db";
import { estimateValue } from "@/lib/valuation";
import { computeTrust } from "@/lib/trust";

/**
 * GET /api/sessions/[id]/value → trade value + trust bands.
 *
 * NO VALUE ON THE RETAIL CHANNEL.
 *
 * At a counter the desk quotes from the store's own book — including fault
 * deductions GradeIQ knows nothing about — so a value here would be a second,
 * contradictory price in front of the same customer. The client already
 * declines to render it, but a number withheld only in the UI is still in the
 * JSON: anyone opening devtools on their own phone reads it. Withholding has to
 * happen here to mean anything.
 *
 * Trust and bands stay in both cases. They are grading evidence, which is
 * exactly what a counter session is for.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const s = getSession(id);
  if (!s) return NextResponse.json({ error: "not found" }, { status: 404 });

  const channel = String((s.profile as Record<string, unknown>)?.channel || "consumer");
  const retail = channel === "retail";
  // One response shape in both branches: two differently-typed NextResponse
  // returns produce a union Next's route validator rejects, which is the same
  // error already sitting on /api/clients/[clientId]/pricebook.
  const body: { value: unknown; trust: unknown; priceWithheld: string | null } = {
    value: retail ? null : estimateValue(s),
    trust: computeTrust(s),
    priceWithheld: retail ? "retail" : null,
  };
  return NextResponse.json(body);
}
