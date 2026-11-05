import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { db, getSession } from "@/lib/db";
import { extractDeviceInfo } from "@/lib/deviceOcr";
import { resolveImei } from "@/lib/imeiCache";
import { lookupGrant } from "@/lib/lookupBudget";
import { recordCompliance, checkScreenshotFreshness } from "@/lib/compliance";
import { admitUpload } from "@/lib/uploadLimits";

// Infer a brand from a model string when the TAC lookup couldn't (so identity
// still works off an OCR-read model like "iPhone 15 Pro").
function brandFromModel(m: string): string {
  const s = (m || "").toLowerCase();
  if (/iphone|ipad|ipod/.test(s)) return "Apple";
  if (/galaxy|samsung/.test(s)) return "Samsung";
  if (/pixel/.test(s)) return "Google";
  if (/oneplus/.test(s)) return "OnePlus";
  if (/redmi|xiaomi|poco/.test(s)) return "Xiaomi";
  if (/moto|motorola/.test(s)) return "Motorola";
  if (/oppo|vivo|realme|huawei|honor|nokia|sony|nothing/.test(s)) return s.split(" ")[0];
  return "";
}

// POST /api/sessions/[id]/ocr  { frames: [dataUrl, ...] }
// Continuous Settings-scroll OCR. Reads the device's own Settings screens and
// fuses the hard facts (model, storage, IMEI, battery health, parts) into the
// session — including resolving the OCR'd IMEI to make/model so the anti-fraud
// identity check now has a REAL scanned IMEI to compare the connected device to.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const s = getSession(id);
  if (!s) return NextResponse.json({ error: "not found" }, { status: 404 });

  // SUP-80: the size cap and the anonymous rate limit, before the body is read
  // (413 / 429 — nothing written, no model call). lib/uploadLimits.ts
  const admitted = await admitUpload(req, "ocr", id);
  if (!admitted.ok) return admitted.response;
  const body = admitted.body;
  const frames: string[] = Array.isArray(body.frames) ? body.frames.slice(0, 8) : [];
  const ocr = await extractDeviceInfo(frames, s.model);

  /**
   * KEEP THE SCREENSHOTS.
   *
   * These frames are the *#06# / Settings / Battery-Health screens the seller
   * showed us — the evidence behind the IMEI we trust, the storage we quote and
   * the battery health we price in. They were read for their text and then
   * dropped, so a report asserted "IMEI 3550…" and "battery 87%" with nothing to
   * point at, and a dispute had no source. The photos of the phone are kept;
   * there is no reason these are not.
   *
   * `kind` labels each one from what the OCR actually found in it, so the report
   * can caption them instead of showing six anonymous tiles.
   */
  const dir = path.join(process.cwd(), "data", "uploads");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = Date.now();
  const shots: { url: string; kind: string }[] = [];
  frames.forEach((f, i) => {
    const m = /^data:image\/[a-z]+;base64,(.*)$/i.exec(f || "");
    if (!m) return;
    const file = `${id}-ocr-${stamp}-${i}.jpg`;
    try {
      fs.writeFileSync(path.join(dir, file), Buffer.from(m[1], "base64"));
      shots.push({ url: `/api/uploads/${file}`, kind: (body.kind as string) || "settings" });
    } catch {
      /* a frame we can't write is simply not listed */
    }
  });
  // Merge with anything captured earlier in the session (the battery step and
  // the Settings sweep both land here) rather than replacing it.
  const priorShots = Array.isArray((s.ocr as any)?.shots) ? (s.ocr as any).shots : [];
  (ocr as any).shots = [...priorShots, ...shots].slice(-12);

  // Merge device fields (storage / serial) without clobbering existing data.
  const device = { ...(s.device as any) };
  if (ocr.storage && !device.storage) device.storageText = ocr.storage;
  if (ocr.serial && !device.serial) device.serial = ocr.serial;
  if (ocr.os) device.os = ocr.os;

  // Parts & Service → the passport's parts section + Trust OEM band.
  let parts = s.parts as any;
  if (ocr.parts && ocr.parts.length) {
    const anyNonGenuine = ocr.parts.some((p) => /non-genuine|non genuine|unknown|aftermarket/i.test(p.status));
    parts = {
      found: true,
      anyNonGenuine,
      parts: ocr.parts.map((p) => ({ name: p.name, status: p.status })),
      warnings: ocr.warnings ?? [],
      source: "settings-ocr",
    };
  }

  /**
   * FRESHNESS — the check the flow never had.
   *
   * A screenshot uploaded minutes after the step began was taken of something
   * else, possibly another phone. `issuedAt` is stamped by the browser when the
   * step opens and `takenAt` is the file's own lastModified, so BOTH come from
   * the device clock and any skew cancels. Recorded, not blocked: the window is
   * a guess until the recorded ages say what honest sellers actually take.
   */
  const issuedAt = Number(body.issuedAt);
  const takenAt = Number(body.takenAt);
  if (Number.isFinite(issuedAt) && Number.isFinite(takenAt)) {
    const f = checkScreenshotFreshness(issuedAt, takenAt);
    if (!f.fresh) {
      recordCompliance({
        sessionId: id,
        clientId: s.client_id,
        kind: "evidence.stale_screenshot",
        expected: `within ${Math.round(180)}s of the check starting`,
        observed: f.reason,
        source: "process",
        detail: { ageMs: f.ageMs, issuedAt, takenAt },
      });
    }
  }

  /**
   * STORAGE — the seller's claim against the device's own Settings screen.
   *
   * A TAC identifies make and model but never capacity, so the only two sources
   * that know it are the person selling the phone and the phone itself. When
   * they disagree, the claim is what the price was quoted from, so the
   * disagreement is worth money and gets recorded.
   *
   * Normalised before comparing: "128 GB", "128GB" and "128gb" are the same
   * answer, and flagging those as fraud would bury the real cases.
   */
  const norm = (v: unknown) => String(v ?? "").replace(/\s+/g, "").toLowerCase();
  /**
   * The claim is preferably PHONECHECK's, not the seller's.
   *
   * Phonecheck reads capacity off the device via its own diagnostic, so it is
   * the one source here that is not the party being paid. The seller's typed
   * answer is the fallback for sessions where Phonecheck found nothing.
   */
  const pc = s.phonecheck as { capacity?: string; found?: boolean } | null;
  const claimSource = pc?.found && pc.capacity ? "phonecheck" : "typed";
  const claimedRaw = pc?.found && pc.capacity ? pc.capacity : (s.device as any)?.storageText;
  const claimedStorage = norm(claimedRaw);
  const readStorage = norm(ocr.storage);
  if (claimedStorage && readStorage && claimedStorage !== readStorage) {
    recordCompliance({
      sessionId: id,
      clientId: s.client_id,
      kind: "identity.storage_mismatch",
      expected: String(claimedRaw ?? ""),
      observed: String(ocr.storage ?? ""),
      source: claimSource,
      detail: { note: `${claimSource} capacity vs the device's Settings screen` },
    });
  }

  // Resolve the OCR'd IMEI → make/model, and set it as the scanned IMEI so the
  // identity coupling has a real reference.
  let imei = s.imei;
  let imeiInfo: any = s.imei_info;
  let model = s.model;
  if (ocr.imei && ocr.imei.length === 15) {
    /**
     * RECORD BEFORE RECONCILE.
     *
     * The line below overwrites the typed IMEI with the one read off the
     * device's own screen. That is the right resolution — a photograph of the
     * hardware beats a number somebody typed — but performing it silently
     * DESTROYS the fraud signal: after the overwrite, checkIdentity() compares
     * the new IMEI against itself and reports "match". Someone entering phone
     * 1's IMEI and showing phone 2's screen would leave no trace at all.
     *
     * So the disagreement is written down first, with both values, and only
     * then reconciled.
     */
    if (s.imei && s.imei.length === 15 && s.imei !== ocr.imei) {
      recordCompliance({
        sessionId: id,
        clientId: s.client_id,
        kind: "identity.imei_mismatch",
        expected: s.imei,
        observed: ocr.imei,
        source: "ocr",
        detail: { note: "typed IMEI replaced by the one on the device's own screen" },
      });
    }
    imei = ocr.imei;
    try {
      // From the per-IMEI cache (24 h): SwapUp resolved this IMEI minutes ago,
      // and every Settings submission or retake used to pay Phonecheck again.
      // A miss is paid only under the session-create rules (lib/lookupBudget.ts).
      const grant = await lookupGrant(req, { client: s.client_id, channel: s.profile?.channel });
      imeiInfo = (await resolveImei(ocr.imei, Date.now(), grant)).info;
    } catch {
      /* keep prior */
    }
    // A model read straight off the Settings screen beats a TAC lookup that
    // couldn't name the device ("Unknown device (TAC …)"). Reflect the best
    // model + brand into imei_info so identity/passport read the real device.
    const looked = imeiInfo?.model && !/^unknown/i.test(imeiInfo.model) ? imeiInfo.model : "";
    const best = looked || ocr.model || "";
    if (best) {
      if (!model || /^unknown/i.test(model)) model = best;
      imeiInfo = { ...(imeiInfo || {}), model: best, brand: imeiInfo?.brand || brandFromModel(best) };
    }
  } else if ((!model || /^unknown/i.test(model)) && ocr.model) {
    model = ocr.model;
  }

  db.prepare(
    "UPDATE sessions SET ocr = ?, device = ?, parts = ?, imei = ?, imei_info = ?, model = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(
    JSON.stringify(ocr),
    JSON.stringify(device),
    JSON.stringify(parts),
    imei,
    JSON.stringify(imeiInfo ?? {}),
    model,
    id
  );

  return NextResponse.json({ ok: true, ocr, session: getSession(id) });
}
