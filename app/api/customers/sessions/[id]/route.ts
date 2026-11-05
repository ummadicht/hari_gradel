import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/db";
import { requireServiceToken } from "@/lib/serviceToken";
import { CUSTOMERS_NOT_CONFIGURED, keycloakM2M } from "@/lib/m2m";
import { toPandasResult } from "@/lib/pandasResult";
import { publicOrigin } from "@/lib/authUrls";

// GET /api/customers/sessions/<id>   Authorization: Bearer <access_token>
// → 200 <Pandas result payload>
// → 401 missing/invalid token · 404 unknown session
// → 409 { status: "in_progress", retry_after: 5 } while still active
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // No Keycloak (KEYCLOAK_ISSUER unset): this API has no other scheme — 503.
  if (!keycloakM2M()) return NextResponse.json(CUSTOMERS_NOT_CONFIGURED.body, { status: CUSTOMERS_NOT_CONFIGURED.status });
  const svc = await requireServiceToken(req, { audience: "gradeiq", azp: "pandas-api" });
  if (!svc.ok)
    return NextResponse.json(
      { error: { code: svc.error, message: "Missing or invalid bearer token." } },
      { status: svc.status }
    );

  const { id } = await params;
  const s = getSession(id);
  if (!s) return new NextResponse(null, { status: 404 });

  // Public origin: the photo URLs in the result are fetched by the caller, and
  // behind Caddy `req.url` is the internal https://localhost:3700.
  const host = publicOrigin(req);
  const result = toPandasResult(s, host);

  // Per the docs: a still-running session returns 409 with a retry hint. We
  // treat "no grades at all yet" as still in progress.
  if (!s.cosmetic_grade && !s.functional_grade)
    return NextResponse.json({ status: "in_progress", retry_after: 5 }, { status: 409 });

  return NextResponse.json(result);
}
