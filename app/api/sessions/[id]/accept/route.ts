import { NextResponse } from "next/server";
import { db, getSession } from "@/lib/db";
import { logEvent } from "@/lib/events";
import { resolveImei } from "@/lib/imeiCache";
import { lookupGrant } from "@/lib/lookupBudget";
import { isLiveImeiSource } from "@/lib/imeiSource";

// POST /api/sessions/[id]/accept
// Runs the pre-payout verification gate before the offer can be accepted:
// FMiP/activation-lock OFF, data erased, not blacklisted, not carrier-locked.
// These come from trusted diagnostics (Phonecheck) + the IMEI check — the
// browser can't attest to them on its own.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const s = getSession(id);
  if (!s) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Trusted diagnostics (Phonecheck) — from the per-IMEI cache (24 h), exactly
  // like /offer. This route is anonymous (the session id is in the customer's
  // camera URL), so a direct Phonecheck call here paid again on every press.
  // A miss is paid only under the same rules as session create, judged on the
  // session's own channel (lib/lookupBudget.ts) — otherwise a session created
  // past the daily limit could buy its lookup here instead.
  const pc = s.imei
    ? (await resolveImei(s.imei, Date.now(), await lookupGrant(req, { client: s.client_id, channel: s.profile?.channel })))
        .phonecheck ?? (s.phonecheck as any)
    : (s.phonecheck as any);
  const imei = s.imei_info as any;
  const blacklistKnownClean =
    (pc.found === true && pc.blacklist === "clean") ||
    (isLiveImeiSource(imei?.source) && imei?.blacklist === "clean");

  const checks = [
    {
      label: "Find My iPhone / activation lock OFF",
      ok: pc.fmip === "off",
      critical: true,
    },
    {
      label: "Device data erased",
      ok: pc.erasedKnown === true && pc.erased === true,
      critical: true,
    },
    {
      label: "Not blacklisted (lost/stolen/unpaid)",
      // Unknown is not clean. At least one live provider must explicitly clear
      // the IMEI, and a positive hit from either provider still wins.
      ok:
        blacklistKnownClean &&
        pc.blacklist !== "blacklisted" &&
        imei?.blacklist !== "blacklisted",
      critical: true,
    },
    {
      label: "Carrier / SIM unlocked",
      ok: pc.simLock !== "locked" && imei.lock !== "locked",
      critical: false,
    },
  ];

  const passed = checks.filter((c) => c.critical).every((c) => c.ok);
  const at = new Date().toISOString();
  // Acceptance used to replace the entire verification document, erasing any
  // device binding, nonce or continuity evidence collected earlier. Preserve
  // that evidence and add the payout decision as a separate sub-record while
  // keeping the legacy top-level fields for current clients.
  const verification = {
    ...((s.verification as any) || {}),
    passed,
    checks,
    at,
    payout: { passed, checks, at },
  };

  db.prepare(
    "UPDATE sessions SET phonecheck = ?, accepted = ?, verification = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(JSON.stringify(pc), passed ? 1 : 0, JSON.stringify(verification), id);

  logEvent(id, "offer", passed ? "accepted" : "accept-blocked", {
    passed,
    failed: checks.filter((c) => !c.ok).map((c) => c.label).slice(0, 4),
  });
  return NextResponse.json({ ok: true, passed, verification });
}
