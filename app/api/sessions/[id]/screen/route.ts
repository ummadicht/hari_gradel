import { NextRequest, NextResponse } from "next/server";
import { db, getSession } from "@/lib/db";
import { lensesFor } from "@/lib/deviceSpecs";
import { clientIpFrom } from "@/lib/uaInfo";
import { deviceTokenFromCookie } from "@/lib/deviceToken";

// Remote screen control for the two-device screen test.
// - Inspector POSTs { pattern } to drive what the device-under-test displays.
// - Device POSTs { connected: true } to check in, and GETs to poll the pattern.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const s = getSession(id);
  if (!s) return NextResponse.json({ error: "not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const cur = (s.screen as any) || {};
  const next = { ...cur };
  if (typeof body.pattern === "string") next.pattern = body.pattern; // white|black|red|green|blue|stripes|idle
  if (body.connected === true) {
    next.connectedAt = new Date().toISOString();
    // Provenance of the SECOND device (the camera phone) — server-captured.
    next.connectedUa = (req.headers.get("user-agent") || "").slice(0, 400);
    next.connectedIp = clientIpFrom(req.headers).slice(0, 64);
    next.connectedToken = deviceTokenFromCookie(req.headers.get("cookie"));
  }
  // The device-under-test echoes back which pattern it is ACTUALLY displaying,
  // so the inspector can capture in sync (not blind-fire on a timer).
  if (typeof body.shown === "string") {
    next.shown = body.shown;
    next.shownAt = new Date().toISOString();
  }
  // The camera signals it has FINISHED the whole sequence (photos + display
  // sweep + Settings). The primary waits for THIS — not just cosmeticDone, which
  // /cosmetic sets mid-sequence — before leaving the two-device screen, so it
  // keeps driving the white/green display patterns while the sweep runs. Benign
  // (it only advances the primary's UI; the grade/offer gate stays on cosmeticDone).
  if (body.handoffDone === true) next.handoffDone = true;
  // The 2nd-device camera signals it has finished all captures, so the primary
  // phone can move on to its own functional tests.
  //
  // "Done" means the SERVER ACCEPTED the photos, not merely that the camera
  // stopped shooting — /cosmetic is what sets it, in its accept branch only. The
  // camera cannot assert it past a rejection: a dropped or lost response on a
  // flaky connection would otherwise read as a silent accept, which is the one
  // failure mode that would let a rejected set through unnoticed.
  // The client may CLEAR this but never SET it. /cosmetic writes it in its accept
  // branch, having actually judged the pixels; anything the camera asserts here is
  // unverified. Blocking only on verdict === "retake" was not enough — posting
  // {capture:{verdict:"retaking"}} first and {cosmeticDone:true} second walked
  // straight past that check without the photos ever being graded.
  if (body.cosmeticDone === false) delete next.cosmeticDone;
  // The capture verdict is ALSO mirrored into the screen blob, because both
  // devices already poll this endpoint and neither needs a second one. The
  // `capture` COLUMN stays the single source of truth though — writing only the
  // blob leaves the column stale, and since the GET reads the column first, the
  // seller's "retaking" state would never actually surface.
  //
  // Note the asymmetry: the camera may announce "retaking", but it may NOT
  // declare itself "ok". Only /cosmetic, having actually judged the pixels, can
  // clear a rejection — otherwise the client could simply assert its way past the
  // gate. Clearing must also clear cosmeticDone, or a stale `true` bounces a
  // returning seller straight back out of the photo screen.
  let captureCol: string | null = null;
  if (body.capture === null) {
    delete next.capture;
    captureCol = "{}";
  } else if (body.capture && typeof body.capture === "object" && body.capture.verdict !== "ok") {
    const v = { ...body.capture, at: new Date().toISOString() };
    next.capture = v;
    captureCol = JSON.stringify(v);
    if (v.verdict === "retake" || v.verdict === "retaking") {
      delete next.cosmeticDone;
      delete next.handoffDone;
    }
  }

  if (captureCol === null) {
    db.prepare(
      "UPDATE sessions SET screen = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(JSON.stringify(next), id);
  } else {
    db.prepare(
      "UPDATE sessions SET screen = ?, capture = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(JSON.stringify(next), captureCol, id);
  }

  return NextResponse.json({ ok: true, screen: next });
}

// Lightweight poll for the device (avoids fetching the whole session).
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const s = getSession(id);
  if (!s) return NextResponse.json({ pattern: "idle" });
  const sc = (s.screen as any) || {};
  // Also hand the device its model + the expected lens layout so the camera
  // test is model-aware (a Pro has 3 rear lenses, an Ultra 4) and can flag any
  // lens the browser can't isolate for manual zoom testing.
  // The verdict is derived, not just echoed: a session whose capture was rejected
  // can never report cosmeticDone, however the blob got written.
  // `{}` is the column default and is truthy, so test for an actual verdict —
  // otherwise every fresh session reports a capture object with a null verdict,
  // which a client checking `if (capture)` would read as "something happened".
  const col = (s.capture as any) || {};
  const cap = col.verdict ? col : (sc.capture as any)?.verdict ? sc.capture : null;
  const rejected = cap?.verdict === "retake";
  return NextResponse.json({
    pattern: sc.pattern || "idle",
    shown: sc.shown || null,
    cosmeticDone: sc.cosmeticDone === true && !rejected,
    handoffDone: sc.handoffDone === true && !rejected,
    // Both devices poll this already, so the rejection reaches the camera AND the
    // primary without either needing a new endpoint or a mount-time race.
    capture: cap
      ? { verdict: cap.verdict, code: cap.code || null, reasons: cap.reasons || [], attempt: cap.attempt || 0 }
      : null,
    connectedAt: sc.connectedAt || null,
    model: s.model || "",
    lenses: lensesFor(s.model).map((l) => ({
      id: l.id,
      name: l.name,
      facing: l.facing,
    })),
  });
}
