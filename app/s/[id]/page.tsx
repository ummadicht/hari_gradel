import { getSession } from "@/lib/db";
import Gauntlet from "@/app/components/Gauntlet";

export const dynamic = "force-dynamic";

export default async function DeviceTestPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const s = getSession(id);
  if (!s) {
    return (
      <div className="stage items-center justify-center p-6 text-center">
        <div>
          <div className="text-5xl">🤔</div>
          <h1 className="mt-3 text-xl font-bold">Session not found</h1>
          <p className="text-[var(--muted)]">Ask staff for a fresh QR code.</p>
        </div>
      </div>
    );
  }
  return <Gauntlet sessionId={id} model={s.model} profile={s.profile} />;
}
