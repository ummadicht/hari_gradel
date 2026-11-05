import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { portalUser } from "@/lib/portalAuth";
import { isComplianceKind } from "@/lib/compliance";

// GET /api/portal/compliance?client=&kind=&severity=&since=&limit=
//
// The fraud / mismatch register. Every contradiction the pipeline observed,
// with both sides of it, in the order observed.
//
// A client admin's scope is applied as a SEPARATE clause from the client
// filter, exactly as in the audit route: narrowing the dropdown can never widen
// past their own tenant, and asking for someone else's client is a 403 rather
// than silently scoped-away results — a compliance view that quietly returns
// the wrong tenant's fraud data would be worse than one that refuses.
export async function GET(req: NextRequest) {
  const user = await portalUser();
  if (!user) return NextResponse.json({ error: "auth required" }, { status: 401 });

  const q = req.nextUrl.searchParams;
  const requested = q.get("client") || "";
  if (user.role !== "super" && requested && requested !== user.clientId) {
    return NextResponse.json({ error: "forbidden: not your client" }, { status: 403 });
  }

  const where: string[] = [];
  const args: unknown[] = [];

  // Hard scope first — a client admin is pinned to their tenant whatever else
  // the query says.
  if (user.role !== "super") {
    where.push("client_id = ?");
    args.push(user.clientId);
  } else if (requested && requested !== "all") {
    where.push("client_id = ?");
    args.push(requested);
  }

  const kind = q.get("kind") || "";
  if (kind && isComplianceKind(kind)) {
    where.push("kind = ?");
    args.push(kind);
  }
  const severity = q.get("severity") || "";
  if (["block", "flag", "record"].includes(severity)) {
    where.push("severity = ?");
    args.push(severity);
  }
  const since = q.get("since") || "";
  if (since) {
    where.push("at >= ?");
    args.push(since);
  }

  const limit = Math.min(Number(q.get("limit")) || 200, 500);
  const sql = `SELECT * FROM compliance_events${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`;

  try {
    const rows = (db.prepare(sql).all(...args, limit) as Record<string, unknown>[]).map((r: any) => {
      let detail = {};
      try {
        detail = JSON.parse(r.detail || "{}");
      } catch {
        /* a malformed detail must not hide the event it belongs to */
      }
      return { ...r, detail };
    });

    // Counts by severity over the SAME scope, so the header cannot disagree
    // with the list beneath it.
    const countSql = `SELECT severity, COUNT(*) AS n FROM compliance_events${where.length ? " WHERE " + where.join(" AND ") : ""} GROUP BY severity`;
    const counts = Object.fromEntries(
      (db.prepare(countSql).all(...args) as { severity: string; n: number }[]).map((c) => [c.severity, c.n])
    );

    return NextResponse.json({ events: rows, counts });
  } catch {
    // The table is created on module load; if it is somehow absent, an empty
    // register is a truthful answer and a 500 is not.
    return NextResponse.json({ events: [], counts: {} });
  }
}
