import { NextRequest, NextResponse } from "next/server";
import { db, hydrate, newSessionId, type SessionRow } from "@/lib/db";
import { buildProfile } from "@/lib/profiles";
import { resolveImei } from "@/lib/imeiCache";
import { lookupGrant } from "@/lib/lookupBudget";
import { clientIpFrom } from "@/lib/uaInfo";
import { logEvent } from "@/lib/events";
import { getJourney } from "@/lib/journeys";
import { isEntAuthed } from "@/lib/entAuth";
import { portalUser } from "@/lib/portalAuth";

// POST /api/journeys/[journey]/start  { imei? }  → open a new session for this
// journey and return its runner URL.
//
// An EMPLOYEE journey is staff-run, so launching one needs a staff sign-in —
// the same gate as the desk tester and the re-grade. The session is stamped with
// the journey's client (DeNovo prices against DeNovo), its segment, and the
// journey id + channel so the monitor and the runner both know which flow it is.
export async function POST(req: NextRequest, { params }: { params: Promise<{ journey: string }> }) {
  const { journey: journeyId } = await params;
  const journey = getJourney(journeyId);
  if (!journey) return NextResponse.json({ error: "unknown journey" }, { status: 404 });

  if (journey.mode === "employee" && !(await isEntAuthed())) {
    return NextResponse.json({ error: "staff sign-in required to start this journey" }, { status: 401 });
  }
  const actor = (await portalUser())?.username || "staff";

  const body = await req.json().catch(() => ({}));
  const imei = String(body.imei ?? "").replace(/[^0-9]/g, "").slice(0, 15);

  // ONE lookup through the 24 h cache (lib/imeiCache.ts), like session create.
  // This used to run lookupImei AND getPhonecheck side by side — the same
  // station + GSMA calls paid twice — and skipped the cache entirely. A miss is
  // paid only for a caller with the right to one (lib/lookupBudget.ts).
  let model = "";
  let imeiInfo: unknown = {};
  let phonecheck: unknown = {};
  let skipped: string | undefined;
  if (imei.length === 15) {
    const grant = await lookupGrant(req, { client: journey.clientId });
    const r = await resolveImei(imei, Date.now(), grant);
    imeiInfo = r.info ?? {};
    phonecheck = r.phonecheck ?? {};
    skipped = r.skipped;
    model = r.info?.model || r.phonecheck?.model || "";
  }

  const profile = buildProfile(journey.segment as never, "standard") as Record<string, unknown>;
  // The runner and the session monitor both read profile.channel / profile.journey.
  profile.channel = "employee";
  profile.journey = journey.id;
  profile.origin = {
    ua: (req.headers.get("user-agent") || "").slice(0, 400),
    ip: clientIpFrom(req.headers).slice(0, 64),
    at: new Date().toISOString(),
  };

  const id = newSessionId();
  db.prepare(
    `INSERT INTO sessions (id, imei, model, client_id, profile, imei_info, phonecheck)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    imei,
    model,
    journey.clientId,
    JSON.stringify(profile),
    JSON.stringify(imeiInfo),
    JSON.stringify(phonecheck),
  );

  logEvent(id, "layout", "journey-started", { journey: journey.id, actor, imei: imei || undefined, model: model || undefined });
  if (model) logEvent(id, "device-identification", "identified", { model, source: imei ? "imei-lookup" : "manual" });
  if (skipped) logEvent(id, "device-identification", "lookup-skipped", { reason: skipped });

  const base = process.env.NEXT_PUBLIC_BASE_PATH || "";
  const session = hydrate(db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow);
  return NextResponse.json({
    ok: true,
    sessionId: id,
    url: `${base}/j/${journey.id}/s/${id}`,
    model: session.model,
  });
}
