import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/db";
import { buildDeviceExport } from "@/lib/deviceExport";
import { publicOrigin } from "@/lib/authUrls";

// GET /api/report/[id]/export — the SuperIQ import contract.
//   ?format=devicefax (default) → the rich single-device DeviceFax document.
//   ?format=superiq             → a Phonecheck-shaped { source, rows:[…] }
//                                 batch that SuperIQ's existing /api/diagnostics
//                                 endpoint ingests directly (matched by IMEI),
//                                 with the DeviceFax extras carried in `raw`.
// This is "replace Phonecheck but leverage it": GradeIQ becomes another
// diagnostics `source` feeding the same pipeline. Photos stay in GradeIQ as the
// source of truth; SuperIQ references (or mirrors) them on import.
// The document itself is built in lib/deviceExport.ts (shared with push-superiq).
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const s = getSession(id);
  if (!s) return NextResponse.json({ error: "not found" }, { status: 404 });
  const format = new URL(req.url).searchParams.get("format") === "superiq" ? "superiq" : "devicefax";
  return NextResponse.json(buildDeviceExport(s, publicOrigin(req), format));
}
