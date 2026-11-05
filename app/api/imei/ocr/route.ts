import { NextRequest, NextResponse } from "next/server";
import { extractImei } from "@/lib/gemini";
import { paidCaller } from "@/lib/serverKey";
import { admitUpload } from "@/lib/uploadLimits";

// POST /api/imei/ocr  { photo: dataUrl }  -> read the IMEI off a *#06# screen
//
// Each call spends a Gemini request. Callers: a server (x-gradeiq-server-key —
// SwapUp's "Read the screen"), signed-in staff, or GradeIQ's own seller pages
// (same-origin browser fetch — /v2, /inspect, /j/… read the screen before any
// session exists). Anonymous cross-site or scripted calls get 401.
//
// A seller's call (and a script that forges the same-origin headers) also meets
// the size cap and the per-IP rate limit (SUP-80, lib/uploadLimits.ts): 413 or
// 429 before the photo is read, and no Gemini call. There is no session yet, so
// only the per-IP limit applies. The server key and staff are never limited.
export async function POST(req: NextRequest) {
  if (!(await paidCaller(req, { seller: true })))
    return NextResponse.json({ imei: "", error: "unauthorized" }, { status: 401 });
  const admitted = await admitUpload(req, "imei-ocr", null);
  if (!admitted.ok) return admitted.response;
  const body = admitted.body;
  const photo = String(body.photo ?? "");
  if (!photo.startsWith("data:image/"))
    return NextResponse.json({ imei: "", error: "bad_image" });
  // Pass the failure REASON through — the UI needs to tell "AI is over quota, use
  // the scanner" apart from "that photo wasn't readable, retake it".
  const { imei, error } = await extractImei(photo);
  return NextResponse.json({ imei, error });
}
