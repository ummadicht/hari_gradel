import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/db";
import { portalUser } from "@/lib/portalAuth";
import { superiqBearer } from "@/lib/m2m";
import { buildDeviceExport } from "@/lib/deviceExport";
import { publicOrigin } from "@/lib/authUrls";

// POST /api/report/[id]/push-superiq — push this device's diagnostics into
// SuperIQ's /api/diagnostics/ingest as source "GradeIQ" (matched by IMEI).
// Staff-only (console action), and a client admin may push only their own
// tenant's sessions. Authenticates to SuperIQ with a Keycloak
// client_credentials token (client `gradeiq-svc`, audience `superiq-erp`) when
// KEYCLOAK_ISSUER is set, else with SUPERIQ_TOKEN as a static Bearer — SuperIQ's
// legacy ingest compares it with its Phonecheck webhook secret (lib/m2m.ts).
// Neither configured → 503 "not configured", never a thrown error.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await portalUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const s = getSession(id);
  if (!s) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (user.role !== "super" && s.client_id !== user.clientId)
    return NextResponse.json({ error: "forbidden: not your client" }, { status: 403 });
  if (!s.imei)
    return NextResponse.json(
      { error: "No IMEI — SuperIQ matches devices by IMEI." },
      { status: 400 }
    );

  const target = process.env.SUPERIQ_DIAGNOSTICS_URL;
  if (!target)
    return NextResponse.json(
      { error: "SUPERIQ_DIAGNOSTICS_URL not configured on GradeIQ." },
      { status: 501 }
    );

  const bearer = await superiqBearer();
  if (!bearer.ok) return NextResponse.json({ error: bearer.error }, { status: bearer.status });

  try {
    // Built in-process (lib/deviceExport.ts) — the same document
    // /api/report/[id]/export?format=superiq serves, with public URLs in it.
    const payload = buildDeviceExport(s, publicOrigin(req), "superiq");
    const r = await fetch(target, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearer.token}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok)
      return NextResponse.json(
        { error: `SuperIQ ${r.status}`, detail: out },
        { status: 502 }
      );
    return NextResponse.json({ ok: true, superiq: out });
  } catch (e) {
    // Reaching SuperIQ failed — the upstream's problem (502). Our own side
    // (no token, Keycloak down) already answered 503 above.
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "push failed" },
      { status: 502 }
    );
  }
}
