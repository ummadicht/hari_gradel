import { notFound } from "next/navigation";
import { getSession } from "@/lib/db";
import { getJourney } from "@/lib/journeys";
import JourneyRunner from "@/app/components/JourneyRunner";

export const dynamic = "force-dynamic";

// /j/[journey]/s/[id] — the employee-journey runner (Pandas' /j/…/s/… shape).
export default async function JourneySessionPage({
  params,
}: {
  params: Promise<{ journey: string; id: string }>;
}) {
  const { journey: journeyId, id } = await params;
  const journey = getJourney(journeyId);
  if (!journey) notFound();
  if (!getSession(id)) notFound();
  return <JourneyRunner journey={journey} sessionId={id} />;
}
