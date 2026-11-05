import { NextRequest, NextResponse } from "next/server";
import { channelConfig } from "@/lib/journeyConfig";
import { isClientId } from "@/lib/clients";

// PUBLIC read of one channel's journey config — the v2 flow and the second-device
// camera fetch this at runtime, so a portal edit reshapes the live journey with
// no deploy. Contains nothing sensitive (step labels, phase toggles, copy).
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ clientId: string; channel: string }> },
) {
  const { clientId, channel } = await params;
  if (!isClientId(clientId)) return NextResponse.json({ error: "unknown client" }, { status: 404 });
  return NextResponse.json({ clientId, channel, config: channelConfig(clientId, channel) });
}
