import { NextResponse } from "next/server";
import { getSession } from "@/lib/db";
import { runsFor } from "@/lib/gradingRuns";
import { isEntAuthed } from "@/lib/entAuth";

// GET /api/sessions/[id]/runs → this session's grading history.
//
// Staff-gated for the same reason the re-grade is: the history exposes which
// model tier graded, who re-ran it and how the letter moved, which is operator
// information, not customer information.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isEntAuthed())) {
    return NextResponse.json({ error: "staff sign-in required" }, { status: 401 });
  }
  const { id } = await params;
  if (!getSession(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ runs: runsFor(id) });
}
