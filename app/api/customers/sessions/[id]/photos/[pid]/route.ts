import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { getSession } from "@/lib/db";
import { requireServiceToken } from "@/lib/serviceToken";
import { CUSTOMERS_NOT_CONFIGURED, keycloakM2M } from "@/lib/m2m";

// GET /api/customers/sessions/<id>/photos/<pid>   Authorization: Bearer <token>
// → 200 <image bytes> · 401 · 403 · 404. pid is p1..pN (1-indexed into photos).
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; pid: string }> }
) {
  // No Keycloak (KEYCLOAK_ISSUER unset): this API has no other scheme — 503.
  if (!keycloakM2M()) return NextResponse.json(CUSTOMERS_NOT_CONFIGURED.body, { status: CUSTOMERS_NOT_CONFIGURED.status });
  const svc = await requireServiceToken(req, { audience: "gradeiq", azp: "pandas-api" });
  if (!svc.ok)
    return NextResponse.json(
      { error: { code: svc.error, message: "Missing or invalid bearer token." } },
      { status: svc.status }
    );

  const { id, pid } = await params;
  const s = getSession(id);
  if (!s) return new NextResponse(null, { status: 404 });

  const idx = Number(/^p(\d+)$/.exec(pid)?.[1]) - 1;
  const rel = s.photos?.[idx];
  if (rel == null) return new NextResponse(null, { status: 404 });

  // photos are stored as /api/uploads/<file>; read the file off disk.
  const file = rel.replace(/^.*\/uploads\//, "");
  const abs = path.join(process.cwd(), "data", "uploads", file);
  if (!fs.existsSync(abs)) return new NextResponse(null, { status: 404 });

  const buf = fs.readFileSync(abs);
  const ext = path.extname(abs).toLowerCase();
  const type = ext === ".png" ? "image/png" : "image/jpeg";
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: { "Content-Type": type, "Cache-Control": "private, max-age=3600" },
  });
}
