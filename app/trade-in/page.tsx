import { redirect } from "next/navigation";

// The old IMEI-first /trade-in journey is retired — the guided v2 flow is the
// single consumer sell experience now. Redirect here so any existing link, QR
// or SwapMore CTA lands in v2, carrying the ?client tenant through.
//
// NOTE: next/navigation redirect() already applies basePath — do NOT withBase().
export const dynamic = "force-dynamic";

export default async function TradeIn({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const client = typeof sp.client === "string" ? sp.client : "";
  redirect(`/v2${client ? `?client=${encodeURIComponent(client)}` : ""}`);
}
