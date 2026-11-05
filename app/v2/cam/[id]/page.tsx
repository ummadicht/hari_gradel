import V2Cam from "../../../components/V2Cam";

// The 2nd-device camera page — opened by scanning the QR the primary phone
// shows. It films the primary for cosmetics + display + Settings.
//
// `?pass=photos` / `?pass=screen` split that into two visits for a store flow
// where the customer's phone can't run the test app yet when the photos are
// taken (photos first, screen check after its tests). Anything else, or no
// `pass` at all, is today's single full pass — older links keep working.
export const dynamic = "force-dynamic";

export default async function V2CamPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ pass?: string }>;
}) {
  const { id } = await params;
  const { pass } = await searchParams;
  return <V2Cam sessionId={id} pass={pass === "photos" || pass === "screen" ? pass : undefined} />;
}
