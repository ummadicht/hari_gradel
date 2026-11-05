import { NextResponse } from "next/server";
import { getSession } from "@/lib/db";
import { gradeFunctional } from "@/lib/grading";
import { getJourney } from "@/lib/journeys";
import { stationsFor } from "@/lib/journeyConfig";
import { stepCompletion } from "@/lib/journeys";

// GET /api/journeys/[journey]/s/[id] → the runner's view of a journey session:
// the step rail (derived from session state) + the facts each station shows.
//
// Public read (the runner is opened from a link), but it exposes only summary
// grade/offer data — no keys, no raw diagnostics — the same shape the report
// already shows anyone with the link.
export async function GET(_req: Request, { params }: { params: Promise<{ journey: string; id: string }> }) {
  const { journey: journeyId, id } = await params;
  const journey = getJourney(journeyId);
  if (!journey) return NextResponse.json({ error: "unknown journey" }, { status: 404 });
  const s = getSession(id);
  if (!s) return NextResponse.json({ error: "not found" }, { status: 404 });

  // CONFIG-DRIVEN stations: which stops this client's journey channel runs, with
  // the portal's labels/blurbs. Falls back to the journey's template if a tenant
  // has no saved config yet.
  const channel = (s.profile as { channel?: string })?.channel || "employee";
  const configured = stationsFor(s.client_id, channel);
  const stations = configured.length
    ? configured
    : journey.steps.map((st) => ({ id: st.id, label: st.label, blurb: st.blurb, enabled: true }));

  // Status derives from the session's own state; "current" = first not-done.
  const done = stepCompletion(s);
  let hitCurrent = false;
  const steps = stations.map((st) => {
    let status: "done" | "current" | "todo";
    if (done[st.id as keyof typeof done]) status = "done";
    else if (!hitCurrent) {
      status = "current";
      hitCurrent = true;
    } else status = "todo";
    return { id: st.id, label: st.label, blurb: st.blurb, status };
  });
  const currentId = (steps.find((x) => x.status === "current")?.id ?? "complete") as string;
  const functional = gradeFunctional(s.functional);

  return NextResponse.json({
    steps,
    currentId,
    session: {
      id: s.id,
      model: s.model,
      imei: s.imei,
      clientId: s.client_id,
      grades: {
        cosmetic: s.cosmetic_grade,
        functional: functional.grade,
        overall: s.overall_grade,
      },
      offer: s.offer,
      accepted: Number(s.accepted) === 1,
      photos: (s.photos || []).length,
      updatedAt: s.updated_at,
    },
  });
}
