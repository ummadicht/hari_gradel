import { NextRequest, NextResponse } from "next/server";
import { deviceTokenFromCookie } from "@/lib/deviceToken";
import { db, getSession } from "@/lib/db";
import { luhnValid } from "@/lib/luhn";

// POST /api/sessions/[id]/device  { device: {...}, model?: string }
// Stores browser-detected device signals and, if we don't have a model yet,
// backfills the best-guess model from the auto-fetcher. Likewise a session with
// no IMEI takes a valid `device.imei` — no lookup is run for it.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const s = getSession(id);
  if (!s) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  /**
   * MERGE, don't replace.
   *
   * This overwrote `device` wholesale, so whichever writer posted last won and
   * silently erased the other's fields — the browser fingerprint and the
   * seller's own answers (storage, colour) are gathered at different moments by
   * different screens, and both belong on the same record.
   */
  const prev = (s.device as Record<string, unknown>) || {};
  const device = { ...prev, ...(body.device ?? {}) };
  /* The DEVICE UNDER TEST's own browser token, from its cookie.
   *
   * This is the record that matters most: matching it against the session's
   * origin token answers "is the phone being tested the phone this started on"
   * for two identical handsets, which no user-agent comparison can. Taken from
   * the cookie so the page cannot assert someone else's identity. */
  const tok = deviceTokenFromCookie(req.headers.get("cookie"));
  if (tok) (device as Record<string, unknown>).token = tok;
  const model = s.model || String(body.model ?? "").slice(0, 80);
  /* The session's IMEI, when it has none yet.
   *
   * A partner (SwapUp) creates the session without an IMEI and sends the one
   * it captured here. Stored only in device JSON, it never became the session's
   * identity anchor, so identity.imei_mismatch and the DeviceFax had nothing to
   * compare a photographed IMEI against. Only fills an empty IMEI — never
   * replaces one — and only with a Luhn-valid 15 digits, so a typo can't
   * become the anchor. No paid lookup: the caller already resolved it. */
  const offered = String((body.device ?? {}).imei ?? "").replace(/\D/g, "");
  const imei = s.imei || (offered.length === 15 && luhnValid(offered) ? offered : "");

  db.prepare(
    "UPDATE sessions SET device = ?, model = ?, imei = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(JSON.stringify(device), model, imei, id);

  return NextResponse.json({ ok: true, session: getSession(id) });
}
