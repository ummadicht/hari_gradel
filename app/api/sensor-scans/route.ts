import { NextRequest, NextResponse } from "next/server";
import { db, getSession, newSessionId } from "@/lib/db";
import { portalUser, scopedClient } from "@/lib/portalAuth";
import { isClientId, resolveClient } from "@/lib/clients";
import { getSetting } from "@/lib/settings";
import { buildProfile } from "@/lib/profiles";
import { gradeFunctional } from "@/lib/grading";
import { recomputeOverall } from "@/lib/recompute";
import { logEvent } from "@/lib/events";

function safeParse<T>(raw: unknown, fallback: T): T {
  if (!raw || typeof raw !== "string") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function GET(req: NextRequest) {
  const user = await portalUser();
  if (!user) return NextResponse.json({ error: "auth required" }, { status: 401 });

  const requested = req.nextUrl.searchParams.get("client");
  const limit = Math.min(100, Math.max(1, Number(req.nextUrl.searchParams.get("limit")) || 25));

  let where = "";
  let args: string[] = [];
  if (user.role === "super" && requested === "all") {
    // cross-tenant view
  } else {
    const scope = scopedClient(user, requested, isClientId);
    if (!scope.ok) return NextResponse.json({ error: scope.error }, { status: scope.status });
    where = "WHERE client_id = ?";
    args = [scope.clientId];
  }

  const rawScans = db
    .prepare(
      `SELECT id, session_id, client_id, phone, imei, model, store_id, store_name, store_info,
              pass_count, fail_count, skip_count, total_count, duration_ms,
              functional_map, sensor_readings, device_info, scanned_at, timezone, created_at
       FROM sensor_scans ${where} ORDER BY id DESC LIMIT ?`
    )
    .all(...args, limit) as Record<string, any>[];

  const scans = rawScans.map((r) => ({
    id: r.id,
    session_id: r.session_id || "",
    client_id: r.client_id || "default",
    phone: r.phone || "",
    imei: r.imei || "",
    model: r.model || "",
    store_id: r.store_id || "",
    store_name: r.store_name || "",
    store_info: safeParse(r.store_info, {}),
    pass_count: Number(r.pass_count ?? 0),
    fail_count: Number(r.fail_count ?? 0),
    skip_count: Number(r.skip_count ?? 0),
    total_count: Number(r.total_count ?? 0),
    duration_ms: Number(r.duration_ms ?? 0),
    functional_map: safeParse(r.functional_map, {}),
    sensor_readings: safeParse(r.sensor_readings, []),
    device_info: safeParse(r.device_info, {}),
    scanned_at: r.scanned_at || r.created_at || "",
    timezone: r.timezone || "UTC",
    created_at: r.created_at || "",
  }));

  const rawStores = db
    .prepare(
      `SELECT id, client_id, store_name, branch, phone, address, city, timezone, vpa, operator, store_info, created_at, updated_at
       FROM stores ${where} ORDER BY updated_at DESC LIMIT 50`
    )
    .all(...args) as Record<string, any>[];

  const stores = rawStores.map((s) => ({
    ...s,
    store_info: safeParse(s.store_info, {}),
  }));

  const rawReports = db
    .prepare(
      `SELECT id, client_id, session_id, phone, imei, store_id, store_name, store_info,
              pass_count, fail_count, skip_count, total_checks, sessions_count,
              generated_at, timezone, created_at
       FROM diagnostic_reports ${where} ORDER BY id DESC LIMIT 25`
    )
    .all(...args) as Record<string, any>[];

  const reports = rawReports.map((rep) => ({
    ...rep,
    store_info: safeParse(rep.store_info, {}),
  }));

  return NextResponse.json({ scans, stores, reports });
}

export async function POST(req: NextRequest) {
  const user = await portalUser();

  if (!user) {
    return NextResponse.json(
      { error: "auth required" },
      { status: 401 }
    );
  }

  const body = await req.json().catch(() => ({}));

  const rawClient = String(body.client ?? body.clientId ?? "default").toLowerCase().trim();
  const clientId = isClientId(rawClient) ? rawClient : user?.clientId && isClientId(user.clientId) ? user.clientId : "default";
  const clientDef = resolveClient(clientId);
  const operator = user?.username || String(body.operator || "console");

  const phone = String(body.phone ?? body.customerPhone ?? "").replace(/[^\d+]/g, "").slice(0, 20);
  const imei = String(body.imei ?? "").replace(/\D/g, "").slice(0, 15);
  const model = String(body.model ?? body.deviceInfo?.modelGuess ?? "Console Sensor Probe").trim().slice(0, 80);
  const timezone =
    String(
      body.timezone ??
        req.headers.get("x-timezone") ??
        req.headers.get("x-vercel-ip-timezone") ??
        "UTC"
    )
      .trim()
      .slice(0, 64) || "UTC";
  const scannedAt = String(body.scannedAt ?? body.datetime ?? new Date().toISOString()).slice(0, 40);

  const storeId = String(body.storeId ?? body.store?.storeId ?? `${clientId}-main`).trim().slice(0, 64);
  const storeName = String(body.storeName ?? body.store?.storeName ?? clientDef.name).trim().slice(0, 120);
  const storeBranch = String(body.storeBranch ?? body.store?.branch ?? "Main Counter").trim().slice(0, 80);
  const storePhone = String(body.storePhone ?? body.store?.storePhone ?? phone).replace(/[^\d+]/g, "").slice(0, 24);
  const storeAddress = String(body.storeAddress ?? body.store?.address ?? "").trim().slice(0, 160);
  const storeCity = String(body.storeCity ?? body.store?.city ?? "").trim().slice(0, 64);
  const storeVpa = getSetting(`payout_vpa:${clientId}`) || String(body.store?.vpa ?? "").slice(0, 80);

  const storeInfo = {
    storeId,
    storeName,
    branch: storeBranch,
    storePhone,
    address: storeAddress,
    city: storeCity,
    vpa: storeVpa,
    currency: clientDef.currency,
    operator,
    phone,
    imei,
    model,
    scannedAt,
    timezone,
    ...(body.store && typeof body.store === "object" ? body.store : {}),
  };

  // Upsert store record in `stores` table
  try {
    db.prepare(
      `INSERT INTO stores (id, client_id, store_name, branch, phone, address, city, timezone, vpa, operator, store_info)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         client_id = excluded.client_id,
         store_name = excluded.store_name,
         branch = excluded.branch,
         phone = CASE WHEN excluded.phone <> '' THEN excluded.phone ELSE stores.phone END,
         address = CASE WHEN excluded.address <> '' THEN excluded.address ELSE stores.address END,
         city = CASE WHEN excluded.city <> '' THEN excluded.city ELSE stores.city END,
         timezone = excluded.timezone,
         vpa = CASE WHEN excluded.vpa <> '' THEN excluded.vpa ELSE stores.vpa END,
         operator = excluded.operator,
         store_info = excluded.store_info,
         updated_at = datetime('now')`
    ).run(
      storeId,
      clientId,
      storeName,
      storeBranch,
      storePhone,
      storeAddress,
      storeCity,
      timezone,
      storeVpa,
      operator,
      JSON.stringify(storeInfo)
    );
  } catch {
    /* non-blocking store upsert */
  }

  // Action: save diagnostic summary PDF / report snapshot
  if (body.action === "save-report") {
    const diag = body.diagnostics?.summary ?? {};
    const passCount = Number(diag.pass ?? body.passCount ?? 0);
    const failCount = Number(diag.fail ?? body.failCount ?? 0);
    const skipCount = Number(diag.skip ?? body.skipCount ?? 0);
    const totalChecks = Number(diag.total ?? passCount + failCount + skipCount);
    const sessionsCount = Number(body.totalSessions ?? diag.sessionsTested ?? 0);
    const sessionId = String(body.sessionId ?? "").slice(0, 64);

    db.prepare(
      `INSERT INTO diagnostic_reports (
         client_id, session_id, phone, imei, store_id, store_name, store_info,
         pass_count, fail_count, skip_count, total_checks, sessions_count,
         report_payload, generated_at, timezone
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      clientId,
      sessionId,
      phone,
      imei,
      storeId,
      storeName,
      JSON.stringify(storeInfo),
      passCount,
      failCount,
      skipCount,
      totalChecks,
      sessionsCount,
      JSON.stringify(body.reportPayload ?? body.diagnostics ?? {}),
      scannedAt,
      timezone
    );

    return NextResponse.json({
      ok: true,
      clientId,
      storeId,
      storeName,
      generatedAt: scannedAt,
      timezone,
    });
  }

  // Default action: save sensor scan to `sensor_scans` AND create/update linked `sessions` row
  const report = body.report ?? {};
  const summary = report.summary ?? {};
  const items = Array.isArray(report.items) ? report.items : [];
  const functionalMap: Record<string, "pass" | "fail" | "skip"> = {};
  const rawFn = (report.functionalMap ?? body.functional ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(rawFn)) {
    if (v === "pass" || v === "fail" || v === "skip") {
      functionalMap[k] = v;
    }
  }
  const passCount = Number(summary.pass ?? items.filter((i: any) => i?.status === "pass").length);
  const failCount = Number(summary.fail ?? items.filter((i: any) => i?.status === "fail").length);
  const skipCount = Number(summary.skip ?? items.filter((i: any) => i?.status === "skip").length);
  const totalCount = Number(summary.total ?? items.length);
  const durationMs = Number(report.totalDurationMs ?? 0);
  const deviceInfo = body.deviceInfo && typeof body.deviceInfo === "object" ? body.deviceInfo : {};

  let sessionId = String(body.sessionId ?? "").trim().slice(0, 64);
  const shouldSyncSession = body.createSession !== false;

  if (shouldSyncSession) {
    const existing = sessionId ? getSession(sessionId) : null;
    if (!existing) {
      sessionId = newSessionId();
      const profile = buildProfile("enterprise", "standard");
      (profile as any).channel = "retail";
      (profile as any).origin = {
        ua: (req.headers.get("user-agent") || "").slice(0, 400),
        at: scannedAt,
        timezone,
      };
      const verdict = gradeFunctional(functionalMap);

      db.prepare(
        `INSERT INTO sessions (
           id, imei, phone, model, status, functional, functional_grade,
           profile, device, client_id, recorded_at, timezone,
           store_id, store_name, store_info, sensor_scan
         ) VALUES (?, ?, ?, ?, 'functional_done', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        sessionId,
        imei,
        phone,
        model,
        JSON.stringify(functionalMap),
        verdict.grade,
        JSON.stringify(profile),
        JSON.stringify({ ...deviceInfo, phone, imei, timezone, fetchedAt: scannedAt }),
        clientId,
        scannedAt,
        timezone,
        storeId,
        storeName,
        JSON.stringify(storeInfo),
        JSON.stringify(report)
      );
      recomputeOverall(sessionId);
      logEvent(sessionId, "functional-tests", "sensor-scan-recorded", {
        client: clientId,
        phone: phone || undefined,
        imei: imei || undefined,
        model,
        storeId,
        storeName,
        pass: passCount,
        fail: failCount,
        skip: skipCount,
        scannedAt,
        timezone,
      });
    } else {
      const mergedFn: Record<string, "pass" | "fail" | "skip"> = {
        ...(existing.functional ?? {}),
        ...functionalMap,
      };
      const verdict = gradeFunctional(mergedFn);
      const mergedDevice = {
        ...(existing.device ?? {}),
        ...deviceInfo,
        ...(phone ? { phone } : {}),
        ...(imei ? { imei } : {}),
        timezone,
        fetchedAt: scannedAt,
      };
      const nextImei = existing.imei || imei;
      const nextPhone = existing.phone || phone;
      const nextModel = existing.model && existing.model !== "Console Sensor Probe" ? existing.model : model;

      db.prepare(
        `UPDATE sessions
         SET imei = ?, phone = ?, model = ?, functional = ?, functional_grade = ?,
             device = ?, recorded_at = ?, timezone = ?,
             store_id = ?, store_name = ?, store_info = ?, sensor_scan = ?,
             updated_at = datetime('now')
         WHERE id = ?`
      ).run(
        nextImei,
        nextPhone,
        nextModel,
        JSON.stringify(mergedFn),
        verdict.grade,
        JSON.stringify(mergedDevice),
        scannedAt,
        timezone,
        storeId,
        storeName,
        JSON.stringify(storeInfo),
        JSON.stringify(report),
        sessionId
      );
      recomputeOverall(sessionId);
      logEvent(sessionId, "functional-tests", "sensor-scan-updated", {
        client: clientId,
        phone: nextPhone || undefined,
        imei: nextImei || undefined,
        model: nextModel,
        storeId,
        storeName,
        pass: passCount,
        fail: failCount,
        skip: skipCount,
        scannedAt,
        timezone,
      });
    }
  }

  db.prepare(
    `INSERT INTO sensor_scans (
       session_id, client_id, phone, imei, model,
       store_id, store_name, store_info,
       pass_count, fail_count, skip_count, total_count, duration_ms,
       functional_map, sensor_readings, device_info, scanned_at, timezone
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    sessionId,
    clientId,
    phone,
    imei,
    model,
    storeId,
    storeName,
    JSON.stringify(storeInfo),
    passCount,
    failCount,
    skipCount,
    totalCount,
    durationMs,
    JSON.stringify(functionalMap),
    JSON.stringify(items),
    JSON.stringify(deviceInfo),
    scannedAt,
    timezone
  );

  return NextResponse.json({
    ok: true,
    sessionId,
    clientId,
    phone,
    imei,
    model,
    storeId,
    storeName,
    storeInfo,
    scannedAt,
    timezone,
    summary: { pass: passCount, fail: failCount, skip: skipCount, total: totalCount },
  });
}
