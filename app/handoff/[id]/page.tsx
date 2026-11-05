import { getSession } from "@/lib/db";
import ScreenTestControl from "@/app/components/ScreenTestControl";

export const dynamic = "force-dynamic";

export default async function HandoffPage({
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
  // The device-under-test's only job: scan the QR and display test patterns for
  // the inspector to photograph (LCD grading). All control + info stays here.
  return <ScreenTestControl sessionId={id} nextHref={`/report/${id}`} />;
}
