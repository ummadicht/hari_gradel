import { notFound } from "next/navigation";
import { getJourney } from "@/lib/journeys";
import JourneyLauncher from "@/app/components/JourneyLauncher";

export const dynamic = "force-dynamic";

// /j/[journey] — the employee launcher: scan/enter the IMEI, start a session,
// and drop the associate straight into the runner.
export default async function JourneyLaunchPage({
  params,
}: {
  params: Promise<{ journey: string }>;
}) {
  const { journey: journeyId } = await params;
  const journey = getJourney(journeyId);
  if (!journey) notFound();
  return (
    <JourneyLauncher
      journeyId={journey.id}
      label={journey.label}
      steps={journey.steps.map((s) => s.label)}
    />
  );
}
