import { NextResponse } from "next/server";
import { resolveImei } from "@/lib/imeiCache";
import { paidCaller } from "@/lib/serverKey";
import { requestIp } from "@/lib/lookupBudget";

// GET /api/imei/[imei] -> device make/model/model number + blacklist/lock from
// the IMEI check. Spends paid Phonecheck calls on a miss, so it answers only a
// server caller (x-gradeiq-server-key) or signed-in staff — never anonymously —
// and repeats come from the 24 h per-IMEI cache (lib/imeiCache.ts).
export async function GET(
  req: Request,
  { params }: { params: Promise<{ imei: string }> }
) {
  const who = await paidCaller(req);
  if (who !== "server" && who !== "staff")
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { imei } = await params;
  // Counted against the caller in the day's paid-lookup totals (no limit for these two).
  const { info } = await resolveImei(imei, Date.now(), { caller: who, ip: requestIp(req) });
  return NextResponse.json(info);
}
