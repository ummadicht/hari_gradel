import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/db";
import { portalUser } from "@/lib/portalAuth";
import { parseUa } from "@/lib/uaInfo";
import { modelFromFingerprint, modelAgrees } from "@/lib/deviceModel";
import { buildPath, eventsFor } from "@/lib/events";
import { refineField } from "@/lib/refineStatus";
import { refineStatusNow } from "@/lib/visionProvider";

// GET /api/portal/sessions/[id] — the full session detail for the portal's
// click-through view (Pandas "Sessions > tradein" equivalent): status, device
// identity, BROWSER PROVENANCE of both devices, vision summary, capture
// verdict, functional results and the offer. Scoped: a client admin can only
// open sessions belonging to their own tenant.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await portalUser();
  if (!user) return NextResponse.json({ error: "auth required" }, { status: 401 });

  const { id } = await params;
  const s = getSession(id);
  if (!s) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (user.role !== "super" && s.client_id !== user.clientId) {
    return NextResponse.json({ error: "forbidden: not your client" }, { status: 403 });
  }

  const c = (s.cosmetic as any) || {};
  const profile = (s.profile as any) || {};
  const screen = (s.screen as any) || {};
  const device = (s.device as any) || {};
  const fp = ((s.verification as any) || {}).deviceFp || {};

  // Browser provenance, three independent sources:
  //   origin    — server-captured UA+IP of whoever CREATED the session (primary)
  //   camera    — server-captured UA+IP of the second device at check-in
  //   reported  — what the device-under-test said about itself (deviceFetch/attest)
  const origin = profile.origin || {};
  const browsers = {
    origin: origin.ua
      ? { ua: origin.ua, ip: origin.ip || "", at: origin.at || "", token: origin.token || "", parsed: parseUa(origin.ua) }
      : null,
    // A second device that checked in but whose UA we never recorded is CONNECTED
    // WITHOUT PROVENANCE — not absent. The console used to print "second device
    // never connected" for it, which flatly contradicts screen.connectedAt.
    camera: screen.connectedUa
      ? {
          ua: screen.connectedUa,
          ip: screen.connectedIp || "",
          at: screen.connectedAt || "",
          token: screen.connectedToken || "",
          parsed: parseUa(screen.connectedUa),
        }
      : null,
    cameraConnectedAt: screen.connectedAt || "",
    reported:
      device.ua || fp.ua
        ? {
            ua: device.ua || fp.ua,
            token: device.token || "",
            parsed: parseUa(device.ua || fp.ua),
            platform: device.platform || "",
            screen: device.screen || fp.screen || "",
            battery: device.battery ?? null,
            /**
             * The MODEL, which the user agent cannot give us.
             *
             * iOS never put the model in the UA and Android Chrome redacted it
             * to the placeholder "K", so the provenance panel had a device with
             * an OS and a browser and no idea what phone it was. The viewport we
             * already store identifies it on Apple hardware; a Client Hint gives
             * the real string on Android. `agrees` then cross-checks it against
             * the model the seller claimed — a 375x667 viewport on a session
             * claiming an iPhone 16 Pro Max is an iPhone 8, and that is exactly
             * the contradiction the panel should be showing.
             */
            model: modelFromFingerprint(device.screen || fp.screen, device.ua || fp.ua, device.modelGuess || fp.modelGuess),
            agrees: modelAgrees(
              s.model,
              modelFromFingerprint(device.screen || fp.screen, device.ua || fp.ua, device.modelGuess || fp.modelGuess),
              device.screen || fp.screen,
            ),
          }
        : null,
  };

  return NextResponse.json({
    id: s.id,
    clientId: s.client_id,
    status: s.status,
    imei: s.imei,
    model: s.model,
    grades: {
      cosmetic: s.cosmetic_grade,
      functional: s.functional_grade,
      overall: s.overall_grade,
    },
    vision: {
      tierUsed: c.tierUsed ?? null,
      escalated: c.escalated ?? null,
      score: c.score ?? null,
      conclusive: c.conclusive ?? null,
      needsHumanReview: c.needsHumanReview ?? null,
      coverage: c.coverage ?? null,
      deviceMatch: c.device ?? null,
      oem: c.oem ?? null,
      obstruction: c.obstruction ?? null,
      findings: (c.findings || []).length,
      // SUP-63: still grading, or did the background grade die? Read-only.
      refine: refineField(refineStatusNow(c, s.updated_at)),
      specialists: (c.specialists || []).map((sp: any) => ({
        id: sp.id,
        grade: sp.grade,
        confidence: sp.confidence,
        findings: (sp.findings || []).length,
        notes: sp.notes,
      })),
    },
    /**
     * The AUTHORITATIVE spec, and what was claimed against it.
     *
     * Phonecheck reads colour and capacity off the device itself, so it is the
     * only source here that is not the party being paid. The seller's typed
     * answer is the fallback, and `source` says which one the console is
     * showing — a chip that says "colour matched" is worthless if you cannot
     * tell whether it matched the phone or matched what somebody typed.
     */
    /** Where the Phonecheck answer came from — or why there isn't one. */
    phonecheckSource: ((s.phonecheck as any)?.source) || "",
    spec: (() => {
      const pc = (s.phonecheck as any) || {};
      const dev = (s.device as any) || {};
      const authoritative = !!(pc.found && (pc.colour || pc.capacity));
      return {
        source: authoritative ? "phonecheck" : "typed",
        colour: (authoritative ? pc.colour : dev.color) || "",
        capacity: (authoritative ? pc.capacity : dev.storageText) || "",
        modelNumber: pc.modelNumber || "",
        carrier: pc.carrier || "",
        // What the PHOTOS showed, for the side-by-side.
        seenColour: ((s.cosmetic as any)?.device?.colour) || "",
      };
    })(),
    capture: (s.capture as any)?.verdict ? s.capture : null,
    functional: s.functional,
    offer: s.offer,
    photos: s.photos,
    // The other two evidence sets an operator asks for by name: the device's own
    // Settings/*#06#/Battery screenshots, and the screen test patterns as the
    // camera saw them. Both were already on disk and neither reached the console.
    shots: ((s.ocr as any)?.shots ?? []) as { url: string; kind?: string }[],
    ocrRead: {
      imei: (s.ocr as any)?.imei ?? "",
      model: (s.ocr as any)?.model ?? "",
      storage: (s.ocr as any)?.storage ?? "",
      batteryHealth: (s.ocr as any)?.batteryHealth ?? null,
      serial: (s.ocr as any)?.serial ?? "",
    },
    display: {
      verdict: ((s.screen as any)?.displayCheck?.verdict ?? "") as string,
      note: ((s.screen as any)?.displayCheck?.note ?? "") as string,
      captures: ((s.screen as any)?.displayCheck?.captures ?? []) as { pattern: string; photo: string }[],
      requested: ((s.screen as any)?.displayCheck?.requested ?? []) as string[],
      missing: ((s.screen as any)?.displayCheck?.missing ?? []) as string[],
    },
    browsers,
    // Full audit trail + the collapsed PATH with dwell times.
    path: buildPath(eventsFor(id)),
    events: eventsFor(id),
    profile: { segment: profile.segment, channel: profile.channel || "consumer" },
    created_at: s.created_at,
    updated_at: s.updated_at,
  });
}
