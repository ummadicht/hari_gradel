import { NextRequest, NextResponse } from "next/server";
import { portalUser } from "@/lib/portalAuth";
import { getPhonecheck, gsmaCheck, lastProbe } from "@/lib/phonecheck";
import { getSetting } from "@/lib/settings";

// GET /api/portal/phonecheck-probe?imei=...
//
// What does `/cloud/cloudDB/GetDeviceInfo` ACTUALLY return for this IMEI?
//
// Production shows 58 of 64 lookups returning nothing, and until now there was
// no way to tell three very different situations apart:
//   • the endpoint answered and this device simply is not in Phonecheck's cloud
//     (the ordinary case — it only knows devices processed at their stations);
//   • the credentials or URL are wrong;
//   • the payload's field names changed and our parser stopped recognising them.
//
// Each looks identical from the outside: an empty report. This makes the
// difference visible from inside the app rather than by adding a console.log
// and redeploying.
//
// Returns field NAMES and our parsed verdict — never raw vendor values, so a
// diagnostic cannot become a side channel for customer data.
export async function GET(req: NextRequest) {
  const user = await portalUser();
  // Super only: this reveals integration configuration state.
  if (!user || user.role !== "super") {
    return NextResponse.json({ error: "super admin required" }, { status: 403 });
  }

  const imei = (req.nextUrl.searchParams.get("imei") || "").replace(/\D/g, "").slice(0, 15);
  if (imei.length !== 15) {
    return NextResponse.json({ error: "a 15-digit imei is required" }, { status: 400 });
  }

  const configured = {
    url: getSetting("phonecheck_url", "PHONECHECK_API_URL") || "https://clientapiv2.phonecheck.com",
    endpoint: "/cloud/cloudDB/GetDeviceInfo",
    hasKey: !!getSetting("phonecheck_key", "PHONECHECK_API_KEY"),
    hasUsername: !!getSetting("phonecheck_username", "PHONECHECK_USERNAME"),
    demoMode: (getSetting("phonecheck_demo", "PHONECHECK_DEMO") || "").toLowerCase().trim() === "true",
  };

  const report = await getPhonecheck(imei);
  // Ask the GSMA registry directly too, so the two Cloud DB endpoints can be
  // told apart: GetDeviceInfo answers only for devices tested at our stations,
  // CheckEsn answers for any IMEI. A blank report with a populated `gsma` block
  // means the device is simply new to us — not that the integration is broken.
  const gsma = await gsmaCheck(imei).catch(() => null);

  return NextResponse.json({
    configured,
    gsma: gsma
      ? {
          endpoint: "/cloud/cloudDB/CheckEsn/",
          found: true,
          make: gsma.make ?? null,
          model: gsma.model ?? null,
          modelNumber: gsma.modelNumber ?? null,
          blacklist: gsma.blacklist,
        }
      : { endpoint: "/cloud/cloudDB/CheckEsn/", found: false },
    // Why there is or isn't an answer: api | not_found | unconfigured | error | demo
    source: report.source,
    found: report.found,
    // The shape the vendor sent back on the most recent call — the answer to
    // "does GetDeviceInfo even offer colour and capacity, and under what key?"
    responseShape: lastProbe,
    parsed: {
      make: report.make ?? null,
      model: report.model ?? null,
      colour: report.colour ?? null,
      capacity: report.capacity ?? null,
      modelNumber: report.modelNumber ?? null,
      carrier: report.carrier ?? null,
      batteryHealth: report.batteryHealth,
      blacklist: report.blacklist,
      simLock: report.simLock,
      fmip: report.fmip,
    },
    // Anything the vendor sent that the parser does not map — the shortlist of
    // fields worth adding aliases for.
    unmappedKeys: report.extra ? Object.keys(report.extra) : [],
  });
}
