import { NextRequest, NextResponse } from "next/server";
import { getSetting, setSetting } from "@/lib/settings";
import { portalUser } from "@/lib/portalAuth";
import { isEntAuthed } from "@/lib/entAuth";
import { paidLookupStats } from "@/lib/lookupBudget";

// Platform integrations (AI provider switch + Gemini/Kimi/Phonecheck keys).
//
// These are PLATFORM-level, not per-tenant: one bad write here changes grading
// for every client. So reads need staff auth and WRITES are super-admin only —
// this route used to be completely unauthenticated, meaning anyone who found the
// URL could read which keys were set and overwrite them.

const KEYS = [
  // Which vision backend grades photos: "gemini" (default, Gemini 3.1 Pro) or
  // "kimi" (Kimi K3). Not a secret — the operator flips it in the console.
  { id: "vision_provider", env: "VISION_PROVIDER", secret: false },
  { id: "gemini_key", env: "GEMINI_API_KEY", secret: true },
  { id: "kimi_key", env: "MOONSHOT_API_KEY", secret: true },
  { id: "imei_url", env: "IMEI_API_URL", secret: false },
  { id: "imei_key", env: "IMEI_API_KEY", secret: true },
  { id: "phonecheck_url", env: "PHONECHECK_API_URL", secret: false },
  { id: "phonecheck_username", env: "PHONECHECK_USERNAME", secret: false },
  { id: "phonecheck_key", env: "PHONECHECK_API_KEY", secret: true },
  // api.phonecheck.com only — SIM lock and iCloud/Find My. It will not accept
  // the Cloud DB key above, and its tokens live 24 hours, so the durable secret
  // is the password or an issued API token and GradeIQ mints the token itself.
  { id: "phonecheck_v2_password", env: "PHONECHECK_V2_PASSWORD", secret: true },
  { id: "phonecheck_v2_api_token", env: "PHONECHECK_V2_API_TOKEN", secret: true },
  { id: "phonecheck_v2_token", env: "PHONECHECK_V2_TOKEN", secret: true },
];

function mask(v: string) {
  if (!v) return "";
  return v.length <= 6 ? "••••" : `${v.slice(0, 3)}••••${v.slice(-2)}`;
}

// GET -> configured status (secrets masked, never returned in full), plus
// today's paid IMEI lookup counts (lib/lookupBudget.ts) under `paidLookups`.
export async function GET() {
  if (!(await isEntAuthed())) {
    return NextResponse.json({ error: "auth required" }, { status: 401 });
  }
  const out: Record<string, unknown> = {};
  for (const k of KEYS) {
    const v = getSetting(k.id, k.env);
    out[k.id] = {
      set: !!v,
      preview: k.secret ? mask(v) : v,
      secret: k.secret,
    };
  }
  try {
    out.paidLookups = paidLookupStats();
  } catch {
    /* the counter must never take the integrations page down */
  }
  return NextResponse.json(out);
}

// POST { [key]: value } -> save (empty string clears). SUPER ADMIN ONLY.
export async function POST(req: NextRequest) {
  const user = await portalUser();
  if (!user) return NextResponse.json({ error: "auth required" }, { status: 401 });
  if (user.role !== "super") {
    return NextResponse.json(
      { error: "forbidden: platform integrations are super-admin only" },
      { status: 403 },
    );
  }
  const body = await req.json().catch(() => ({}));
  for (const k of KEYS) {
    if (typeof body[k.id] !== "string") continue;
    let v = body[k.id].trim();
    // The provider switch is an enum, not free text — reject anything else so a
    // typo can't silently disable grading (an unknown value would fall back to
    // the default, which is at least safe, but store only valid values).
    if (k.id === "vision_provider" && v && v !== "gemini" && v !== "kimi") continue;
    setSetting(k.id, v);
  }
  return NextResponse.json({ ok: true });
}
