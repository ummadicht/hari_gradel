import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { db, getSession } from "@/lib/db";
import { validateDisplay } from "@/lib/displayCheck";
import { gradeFunctional } from "@/lib/grading";
import { recomputeOverall } from "@/lib/recompute";
import { logEvent } from "@/lib/events";
import { admitUpload } from "@/lib/uploadLimits";
import { cleanSweepStats } from "@/lib/displaySweep";

// POST /api/sessions/[id]/display  { captures: [{ pattern, photo(dataUrl) }] }
// The inspector's camera auto-captured the device's lit screen for each test
// pattern. Run the AI display validation, persist the verdict (display is a
// critical functional test), and store per-pattern captures + findings.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const s = getSession(id);
  if (!s) return NextResponse.json({ error: "not found" }, { status: 404 });

  // SUP-80: the size cap and the anonymous rate limit, before the body is read
  // (413 / 429 — nothing written, no model call). lib/uploadLimits.ts
  const admitted = await admitUpload(req, "display", id);
  if (!admitted.ok) return admitted.response;
  const body = admitted.body;
  const incoming: { pattern: string; photo: string }[] = Array.isArray(body.captures)
    ? body.captures.slice(0, 8)
    : [];

  // Which patterns the sweep set out to verify — so the report can name the ones
  // it never managed to confirm instead of quietly showing a short strip.
  const requested: string[] = Array.isArray(body.requested)
    ? body.requested.map((p: unknown) => String(p).slice(0, 12)).slice(0, 8)
    : incoming.map((c) => c.pattern);

  const check = await validateDisplay(
    incoming.map((c) => ({ pattern: c.pattern, dataUrl: c.photo })),
    s.model
  );

  // Persist captures to disk so the report can show them.
  const dir = path.join(process.cwd(), "data", "uploads");
  fs.mkdirSync(dir, { recursive: true });
  const saved: { pattern: string; photo: string }[] = [];
  incoming.forEach((c, i) => {
    const m = /^data:image\/[a-z]+;base64,(.*)$/i.exec(c.photo || "");
    if (!m) return;
    const file = `${id}-disp-${Date.now()}-${i}.jpg`;
    fs.writeFileSync(path.join(dir, file), Buffer.from(m[1], "base64"));
    saved.push({ pattern: c.pattern, photo: `/api/uploads/${file}` });
  });

  // display is a critical functional test — fold the AI verdict in. "unknown"
  // (no key / call failed) stays a skip so the collector checks it manually.
  const functional = { ...(s.functional as Record<string, any>) };
  functional.display =
    check.verdict === "pass" ? "pass" : check.verdict === "fail" ? "fail" : "skip";
  const verdict = gradeFunctional(functional);

  const screen = {
    ...(s.screen as any),
    displayCheck: {
      ...check,
      captures: saved,
      requested,
      missing: requested.filter((p) => !saved.some((c) => c.pattern === p)),
      // Why the sweep produced nothing, when it produced nothing. Without this
      // a failed sweep and a sweep that never ran look identical on the report
      // — both just show no white/blue/black frames — and the operator has no
      // way to tell "the seller kept the foldable shut" from "the feature is
      // off". Absent on a successful sweep.
      reason: typeof body.reason === "string" ? body.reason.slice(0, 200) : undefined,
      // What the camera saw of the white it locked on and of each colour it
      // missed — rounded numbers only — so the sweep's cut-offs can be tuned
      // on real sweeps (lib/displaySweep.ts). Absent from an older camera page.
      sweepStats: cleanSweepStats(body.stats),
    },
  };

  db.prepare(
    "UPDATE sessions SET functional = ?, functional_grade = ?, screen = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(JSON.stringify(functional), verdict.grade, JSON.stringify(screen), id);

  recomputeOverall(id);
  logEvent(id, "display", "sweep-validated", {
    verdict: check.verdict,
    confidence: check.confidence,
    patterns: saved.length,
    findings: (check.findings || []).length,
  });
  return NextResponse.json({
    ok: true,
    display: { ...check, captures: saved, requested, missing: requested.filter((p) => !saved.some((c) => c.pattern === p)) },
  });
}
