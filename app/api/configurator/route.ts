import { NextRequest, NextResponse } from "next/server";
import { getProgramConfig, saveProgramConfig } from "@/lib/programConfig";
import { applyConfigCommand } from "@/lib/configChat";
import { portalUser } from "@/lib/portalAuth";

/**
 * SUPER ADMIN ONLY (SUP-88).
 *
 * The program config is GLOBAL: every tenant's per-segment tests, photo targets
 * and pricing overrides (market base, margin, promo bonus). Until SUP-88 anyone
 * could POST a sentence here and rewrite it — "Add a $500 trade-in bonus" — with
 * no sign-in. A client admin is refused too: one tenant must not change another
 * tenant's program.
 *
 * Both methods are locked. Nothing in the public flow reads this route: the
 * session, offer and reprocess code read the config server-side through
 * getProgramConfig(), and the only browser caller is the /configurator page,
 * which the staff middleware now covers.
 *
 * portalUser() reads the Keycloak session in oidc mode and the portal cookie in
 * legacy mode, so the same check holds in both GIQ_AUTH_MODE settings.
 */
async function refuseUnlessSuper(): Promise<NextResponse | null> {
  const user = await portalUser();
  if (!user) return NextResponse.json({ error: "Sign in as a super admin to change the program config." }, { status: 401 });
  if (user.role !== "super") {
    return NextResponse.json({ error: "Only a super admin can change the program config." }, { status: 403 });
  }
  return null;
}

// GET -> current program config
export async function GET() {
  const refused = await refuseUnlessSuper();
  if (refused) return refused;
  return NextResponse.json(getProgramConfig());
}

// POST { message } -> apply a natural-language config change, persist, reply
export async function POST(req: NextRequest) {
  const refused = await refuseUnlessSuper();
  if (refused) return refused;

  const body = await req.json().catch(() => ({}));
  const message = String(body.message ?? "").slice(0, 400);
  if (!message) return NextResponse.json({ error: "empty" }, { status: 400 });

  const cfg = getProgramConfig();
  const { reply, config, changed } = await applyConfigCommand(message, cfg);
  if (changed) saveProgramConfig(config);
  return NextResponse.json({ reply, changed, config });
}
