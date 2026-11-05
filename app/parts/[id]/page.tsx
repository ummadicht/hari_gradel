import { getSession } from "@/lib/db";
import PartsCheck from "@/app/components/PartsCheck";

export const dynamic = "force-dynamic";

export default async function PartsPage({
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
  return <PartsCheck sessionId={id} />;
}
