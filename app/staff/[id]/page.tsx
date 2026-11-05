import { getSession } from "@/lib/db";
import CosmeticCapture from "@/app/components/CosmeticCapture";

export const dynamic = "force-dynamic";

export default async function StaffPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const s = getSession(id);
  if (!s)
    return (
      <div className="container py-16 text-center text-[var(--muted)]">
        Session not found.
      </div>
    );
  const photoTarget = Number((s.profile as any)?.photoTarget) || 6;
  const seg = (s.profile as any)?.segment;
  // Two-device flows (consumer self-serve + enterprise desk-tester) lead with a
  // screen-OFF shot, then hand the phone its diagnostics via QR.
  const twoDevice = seg === "c2b" || seg === "enterprise";
  // Enterprise diagnostics: manual capture by default, verify each shot before
  // advancing to the next angle (auto is opt-in).
  const enterprise = seg === "enterprise";
  return (
    <CosmeticCapture
      sessionId={id}
      model={s.model}
      photoTarget={photoTarget}
      screenOffFirst={twoDevice}
      nextHref={twoDevice ? `/handoff/${id}` : undefined}
      manualFirst={enterprise}
      verifyEachAngle={enterprise}
    />
  );
}
