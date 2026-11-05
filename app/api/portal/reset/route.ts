import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import { portalUser } from "@/lib/portalAuth";

/**
 * Start-fresh: delete session data (rows, audit events, uploaded photos/videos).
 *
 * This is the one irreversible operation in the console, so it is fenced three
 * ways and none of them are cosmetic:
 *   1. SUPER ADMIN ONLY — a client admin cannot clear even their own tenant.
 *   2. An explicit confirmation phrase in the body. A stray POST does nothing.
 *   3. `keep` — an explicit list of session ids that survive, together with
 *      their uploads. Evidence someone is still working from must not vanish
 *      because a wipe was scoped by "everything".
 *
 * Configuration (pricebooks, price catalogs, journey config, integration keys)
 * is deliberately NOT touched: "clean the data" means the trade-in records, not
 * the tenant setup that took real work to enter.
 */
const PHRASE = "DELETE ALL SESSIONS";

export async function POST(req: NextRequest) {
  const user = await portalUser();
  if (!user) return NextResponse.json({ error: "auth required" }, { status: 401 });
  if (user.role !== "super") {
    return NextResponse.json({ error: "forbidden: super admin only" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as { confirm?: string; keep?: unknown; client?: string };
  if (body.confirm !== PHRASE) {
    return NextResponse.json(
      { error: `confirmation required — post {"confirm":"${PHRASE}"}` },
      { status: 400 },
    );
  }

  const keep = new Set(
    (Array.isArray(body.keep) ? body.keep : []).map((x) => String(x).toLowerCase().trim()).filter(Boolean),
  );
  const client = typeof body.client === "string" && body.client ? body.client : null;

  const rows = db
    .prepare(
      client
        ? "SELECT id, photos, video FROM sessions WHERE client_id = ?"
        : "SELECT id, photos, video FROM sessions",
    )
    .all(...(client ? [client] : [])) as { id: string; photos: string; video: string }[];

  const doomed = rows.filter((r) => !keep.has(r.id.toLowerCase()));

  const namesOf = (r: { photos: string; video: string }): string[] => {
    const out: string[] = [];
    try {
      for (const p of JSON.parse(r.photos || "[]") as string[]) out.push(String(p).split("/").pop() || "");
    } catch {
      /* corrupt json — nothing to unlink */
    }
    if (r.video) out.push(String(r.video).split("/").pop() || "");
    return out.filter(Boolean);
  };

  // A kept session's files are protected even if a doomed row references the
  // same name — losing the evidence behind a report we were told to preserve
  // would be worse than leaving an orphan file on disk.
  const keepAll = db.prepare("SELECT id, photos, video FROM sessions").all() as {
    id: string;
    photos: string;
    video: string;
  }[];
  const protectedFiles = new Set(keepAll.filter((r) => keep.has(r.id.toLowerCase())).flatMap(namesOf));

  const uploads = path.join(process.cwd(), "data", "uploads");
  let filesRemoved = 0;
  for (const name of new Set(doomed.flatMap(namesOf))) {
    if (protectedFiles.has(name)) continue;
    try {
      fs.unlinkSync(path.join(uploads, name));
      filesRemoved++;
    } catch {
      /* already gone */
    }
  }

  db.transaction(() => {
    const delEvents = db.prepare("DELETE FROM session_events WHERE session_id = ?");
    const delSession = db.prepare("DELETE FROM sessions WHERE id = ?");
    for (const r of doomed) {
      delEvents.run(r.id);
      delSession.run(r.id);
    }
  })();

  const remaining = db.prepare("SELECT COUNT(*) AS c FROM sessions").get() as { c: number };
  const events = db.prepare("SELECT COUNT(*) AS c FROM session_events").get() as { c: number };

  return NextResponse.json({
    ok: true,
    deleted: doomed.length,
    kept: rows.length - doomed.length,
    keptIds: [...keep],
    filesRemoved,
    remainingSessions: remaining.c,
    remainingEvents: events.c,
  });
}
