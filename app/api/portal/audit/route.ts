import { NextRequest, NextResponse } from "next/server";
import { portalUser } from "@/lib/portalAuth";
import { auditFacets, auditLog } from "@/lib/events";
import { CLIENT_IDS } from "@/lib/clients";

// GET /api/portal/audit?client=&model=&grade=&step=&event=&since=&until=&limit=
// The audit log. A client admin's scope is applied as a SEPARATE clause from the
// client filter, so narrowing the dropdown can never widen past their tenant.
export async function GET(req: NextRequest) {
  const user = await portalUser();
  if (!user) return NextResponse.json({ error: "auth required" }, { status: 401 });

  const scope = user.role === "super" ? undefined : [user.clientId!];
  const q = req.nextUrl.searchParams;
  const requestedClient = q.get("client") || "";

  // A client admin asking for someone else's client gets 403, not silent scoping.
  if (user.role !== "super" && requestedClient && requestedClient !== user.clientId) {
    return NextResponse.json({ error: "forbidden: not your client" }, { status: 403 });
  }

  const rows = auditLog({
    clientIds: scope,
    client: requestedClient && CLIENT_IDS.includes(requestedClient as any) ? requestedClient : undefined,
    model: q.get("model") || undefined,
    grade: q.get("grade") || undefined,
    step: q.get("step") || undefined,
    event: q.get("event") || undefined,
    since: q.get("since") || undefined,
    until: q.get("until") || undefined,
    limit: Number(q.get("limit")) || 200,
  });

  return NextResponse.json({
    rows,
    facets: auditFacets(scope),
    clients: user.role === "super" ? CLIENT_IDS : [user.clientId!],
  });
}
