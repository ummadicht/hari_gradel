import { NextRequest, NextResponse } from "next/server";
import { db, hydrate, newSessionId, type SessionRow } from "@/lib/db";
import { buildProfile, DEFAULT_PROFILE, type Segment, type Demographic } from "@/lib/profiles";
import type { ImeiInfo } from "@/lib/imei";
import { resolveImei } from "@/lib/imeiCache";
import { lookupGrant } from "@/lib/lookupBudget";
import type { PhonecheckReport } from "@/lib/phonecheck";
import { getProgramConfig } from "@/lib/programConfig";
import { isClientId } from "@/lib/clients";
import { clientIpFrom } from "@/lib/uaInfo";
import { deviceTokenFromCookie } from "@/lib/deviceToken";
import { logEvent } from "@/lib/events";
import { hasServerKey } from "@/lib/serverKey";

// POST /api/sessions  { imei?, model?, segment?, demographic?, client?, channel? }  -> new session
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const imei = String(body.imei ?? "").replace(/[^0-9]/g, "").slice(0, 15);
  let model = String(body.model ?? "").slice(0, 80);
  // Per-tenant: which client's pricing this session uses (swapmore → SwapMore prices).
  const clientId = isClientId(body.client) ? String(body.client).toLowerCase().trim() : "default";
  // Which of the client's journey CHANNELS this session runs (retail desk, consumer
  // embed, …) — selects the channel's capture steps/phases from journeyConfig.
  const channel = String(body.channel ?? "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 24) || "consumer";
  // Retail-desk purchases pass their id so the commercial record follows the check.
  const purchaseId = String(body.purchase ?? "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);

  // The IMEI is the diagnostic key: it drives model + carrier lock + FMiP +
  // battery health + blacklist. The Phonecheck report is pulled up front, so
  // the diagnostics are populated at session creation — not deferred to (and
  // coupled with) the pricing step.
  //
  // ONE Phonecheck answer, not two: the identity is derived from the same
  // report (this used to run lookupImei AND getPhonecheck side by side — the
  // same station + GSMA calls paid twice). And an IMEI resolved in the last
  // 24 h (SwapUp's scan, a reload) answers from the cache with no call at all.
  //
  // A MISS is paid only for a caller with the right to one (lib/lookupBudget.ts):
  // SwapUp's server key, CounterIQ's retail key, staff, or a known channel (a
  // tenant's embed, a keyless retail desk) within its per-IP and all-IP daily
  // limits. Anyone else still gets a session — identified from the free TAC
  // data, and unverified.
  let imeiInfo: ImeiInfo | null = null;
  let phonecheck: PhonecheckReport | null = null;
  if (imei.length === 15) {
    const grant = await lookupGrant(req, { channel: body.channel, client: body.client });
    ({ info: imeiInfo, phonecheck } = await resolveImei(imei, Date.now(), grant));
    // Prefer a real make/model from either source.
    if (!model) model = imeiInfo.model || phonecheck?.model || "";
  }

  const profile =
    body.segment
      ? buildProfile(
          body.segment as Segment,
          (body.demographic as Demographic) ?? "standard"
        )
      : { ...DEFAULT_PROFILE };

  // Apply Configurator per-segment overrides (photoTarget/mode/coverage/tests).
  const ov = getProgramConfig().segments[profile.segment];
  if (ov) {
    if (typeof ov.photoTarget === "number") profile.photoTarget = ov.photoTarget;
    if (ov.mode) profile.mode = ov.mode;
    if (ov.coverage) profile.coverage = ov.coverage;
    if (ov.disabledTests?.length)
      profile.tests = profile.tests.filter((t) => !ov.disabledTests!.includes(t));
  }

  // Who started this session — the PRIMARY device's browser + IP (Pandas-style
  // "Device / IP" provenance on the session monitor). Server-captured, so it
  // can't be spoofed by the page the way self-reported fields can.
  (profile as any).origin = {
    ua: (req.headers.get("user-agent") || "").slice(0, 400),
    ip: clientIpFrom(req.headers).slice(0, 64),
    at: new Date().toISOString(),
    // Read from the COOKIE, not the body: no call site can forget it, and a
    // page cannot claim to be a browser it is not. Two identical handsets are
    // only distinguishable by this.
    token: deviceTokenFromCookie(req.headers.get("cookie")),
  };
  // V2Flow + journeyConfig read the channel off the profile (retail desk vs
  // consumer embed run different capture steps/copy for the same client).
  (profile as any).channel = channel;
  // Which app created the session, when that can be proven (SUP-265). The
  // server key belongs to SwapUp alone (lib/serverKey.ts), so only SwapUp's
  // creates are marked — never one a public caller asks for in the body. SwapUp
  // shares its client/channel pair (swapmore-in · retail) with GradeIQ's own
  // retail desk and CounterIQ, so the pair cannot tell them apart. The camera
  // page reads the mark to say "back to SwapUp Store" when it is done.
  if (hasServerKey(req)) (profile as any).app = "swapup";

  let id = newSessionId();
  // Extremely unlikely collision guard (a UUID never collides in practice).
  for (let i = 0; i < 5; i++) {
    const exists = db.prepare("SELECT 1 FROM sessions WHERE id = ?").get(id);
    if (!exists) break;
    id = newSessionId();
  }

  const phone = String(body.phone ?? body.customerPhone ?? "").replace(/[^\d+]/g, "").slice(0, 20);
  const recordedAt = String(body.recordedAt ?? body.datetime ?? new Date().toISOString()).slice(0, 40);
  const timezone =
    String(
      body.timezone ??
        req.headers.get("x-timezone") ??
        req.headers.get("x-vercel-ip-timezone") ??
        "UTC"
    )
      .trim()
      .slice(0, 64) || "UTC";

  const { resolveClient } = await import("@/lib/clients");
  const { getSetting } = await import("@/lib/settings");
  const clientDef = resolveClient(clientId);
  const storeId = String(body.storeId ?? body.store?.id ?? `${clientId}-${channel}`).trim().slice(0, 64);
  const storeName = String(body.storeName ?? body.store?.name ?? clientDef.name).trim().slice(0, 120);
  const storeInfo: Record<string, unknown> = {
    storeId,
    storeName,
    branch: String(body.storeBranch ?? body.store?.branch ?? channel).slice(0, 80),
    storePhone: String(body.storePhone ?? body.store?.phone ?? phone).slice(0, 24),
    address: String(body.storeAddress ?? body.store?.address ?? "").slice(0, 160),
    city: String(body.storeCity ?? body.store?.city ?? "").slice(0, 64),
    vpa: getSetting(`payout_vpa:${clientId}`) || "",
    currency: clientDef.currency,
    channel,
    purchaseId: purchaseId || null,
    phone,
    imei,
    model,
    recordedAt,
    timezone,
    ...(body.store && typeof body.store === "object" ? body.store : {}),
  };

  db.prepare(
    `INSERT INTO sessions (
       id, imei, phone, model, profile, imei_info, phonecheck, client_id,
       recorded_at, timezone, store_id, store_name, store_info
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    imei,
    phone,
    model,
    JSON.stringify(profile),
    JSON.stringify(imeiInfo ?? {}),
    JSON.stringify(phonecheck ?? {}),
    clientId,
    recordedAt,
    timezone,
    storeId,
    storeName,
    JSON.stringify(storeInfo)
  );

  try {
    db.prepare(
      `INSERT INTO stores (id, client_id, store_name, branch, phone, address, city, timezone, vpa, store_info)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         store_name = CASE WHEN excluded.store_name <> '' THEN excluded.store_name ELSE stores.store_name END,
         branch = CASE WHEN excluded.branch <> '' THEN excluded.branch ELSE stores.branch END,
         phone = CASE WHEN excluded.phone <> '' THEN excluded.phone ELSE stores.phone END,
         timezone = CASE WHEN excluded.timezone <> '' AND excluded.timezone <> 'UTC' THEN excluded.timezone ELSE stores.timezone END,
         store_info = excluded.store_info,
         updated_at = datetime('now')`
    ).run(
      storeId,
      clientId,
      storeName,
      String(storeInfo.branch || ""),
      String(storeInfo.storePhone || ""),
      String(storeInfo.address || ""),
      String(storeInfo.city || ""),
      timezone,
      String(storeInfo.vpa || ""),
      JSON.stringify(storeInfo)
    );
  } catch {
    /* non-blocking store sync */
  }

  // Tie the check to its retail purchase (lazy import keeps the consumer path
  // from touching the purchase tables at all). GUARDED: linking requires an
  // authenticated portal user whose tenant owns the purchase — the desk opens
  // the v2 flow in the operator's own browser, so the portal cookie is present.
  // Without this, anyone who guessed a purchase id could attach their own
  // session (their own, better phone) to someone else's priced purchase.
  if (purchaseId) {
    try {
      const { linkSession, getPurchase } = await import("@/lib/purchase");
      const { portalUser } = await import("@/lib/portalAuth");
      const user = await portalUser();
      const target = getPurchase(purchaseId);
      const allowed =
        !!user && !!target && (user.role === "super" || user.clientId === target.client_id);
      if (allowed) linkSession(purchaseId, id);
    } catch {
      /* a bad/foreign purchase id never blocks the check itself */
    }
  }

  // Attributed to device-identification, not layout: a session is created at the
  // moment the IMEI is scanned/typed, i.e. the user is ALREADY past the intro.
  // Logging it as "layout" made the path show layout → device-id → layout again,
  // because the flow also pings the real layout step from the intro screen.
  logEvent(id, "device-identification", "session-created", {
    client: clientId,
    segment: profile.segment,
    ua: (profile as any).origin?.ua?.slice(0, 160),
    ip: (profile as any).origin?.ip,
    phone: phone || undefined,
    imei: imei || undefined,
    timezone,
    storeId,
  });
  if (imei) {
    logEvent(id, "device-identification", imeiInfo?.model ? "identified" : "imei-entered", {
      imei,
      model: model || null,
      source: imeiInfo?.model ? "imei-lookup" : "typed",
    });
    if (imeiInfo?.skipped) logEvent(id, "device-identification", "lookup-skipped", { reason: imeiInfo.skipped });
  }

  return NextResponse.json({
    id,
    imei,
    phone,
    model,
    profile,
    imeiInfo,
    phonecheck,
    client: clientId,
    recordedAt,
    timezone,
    storeId,
    storeName,
    storeInfo,
  });
}

// GET /api/sessions  -> recent sessions for the staff dashboard
export async function GET() {
  // Staff-only: this is a cross-tenant dump (IMEIs + diagnostics). The consumer
  // flow never lists sessions — only the staff Dashboard does — so require a
  // staff sign-in. A CLIENT login is scoped to its own tenant's rows; only super
  // sees all (the ops dashboard). The scope used to be skipped whenever the
  // enterprise gate passed — and that gate passes for EVERY signed-in user, so
  // a client admin was handed every tenant's sessions.
  const { portalUser } = await import("@/lib/portalAuth");
  const user = await portalUser();
  if (!user) return NextResponse.json({ error: "auth required" }, { status: 401 });
  if (user.role !== "super" && !user.clientId) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const scopedToClient = user.role !== "super" ? user.clientId : null;
  const rows = (
    scopedToClient
      ? db.prepare("SELECT * FROM sessions WHERE client_id = ? ORDER BY created_at DESC LIMIT 30").all(scopedToClient)
      : db.prepare("SELECT * FROM sessions ORDER BY created_at DESC LIMIT 30").all()
  ) as SessionRow[];
  return NextResponse.json(rows.map(hydrate));
}
