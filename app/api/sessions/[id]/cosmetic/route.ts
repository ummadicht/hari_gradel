import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { db, getSession, updateScreen, type Session } from "@/lib/db";
import {
  runVisionCascade,
  reconcilePasses,
  proRefinementAvailable,
  type VisionCascadeResult,
} from "@/lib/visionAgents";
import { proOnly } from "@/lib/visionProvider";
import { recomputeOverall } from "@/lib/recompute";
import { evaluateCapture } from "@/lib/captureGateServer";
import { cropPhotosToDevice, remapFindingsToOriginal } from "@/lib/capture/cropPhotos";
import { logEvent } from "@/lib/events";
import { recordRun } from "@/lib/gradingRuns";
import { recordCompliance } from "@/lib/compliance";
import { admitUpload } from "@/lib/uploadLimits";
import { modelAfterGrade, screenAfterGrade, screenAfterHolding, screenAfterReject } from "@/lib/cosmeticScreen";

// POST /api/sessions/[id]/cosmetic  { photos: [dataUrl, ...] }
/** Write data-URL frames to disk and return their served paths. */
function persistPhotos(id: string, photos: string[]): string[] {
  const dir = path.join(process.cwd(), "data", "uploads");
  fs.mkdirSync(dir, { recursive: true });
  const out: string[] = [];
  photos.forEach((p, i) => {
    const m = /^data:image\/[a-z]+;base64,(.*)$/i.exec(p);
    if (!m) return;
    const file = `${id}-${Date.now()}-${i}.jpg`;
    fs.writeFileSync(path.join(dir, file), Buffer.from(m[1], "base64"));
    out.push(`/api/uploads/${file}`);
  });
  return out;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const s = getSession(id);
  if (!s) return NextResponse.json({ error: "not found" }, { status: 404 });

  // SUP-80: the size cap and the anonymous rate limit, before the body is read
  // (413 / 429 — nothing written, no model call). lib/uploadLimits.ts
  const admitted = await admitUpload(req, "cosmetic", id);
  if (!admitted.ok) return admitted.response;
  const body = admitted.body;
  const photos: string[] = Array.isArray(body.photos)
    ? body.photos.slice(0, 6)
    : [];
  // Torch-lit twins of the same angles. Raking light reveals hairlines that flat
  // light hides, so the grader sees both — but they are NOT gated for
  // view-distinctness (a flash/no-flash pair of one angle is the same view).
  const lit: string[] = Array.isArray(body.lit) ? body.lit.slice(0, 6) : [];
  // Why the lit set is the size it is. "ok" = the flash fired, "unsupported" =
  // no torch API on this browser (iOS Safari), "untested" = the pass was off.
  // Recorded because `lit: 0` with no explanation looked like a working feature
  // for weeks while the torch was never once attempted.
  const torch = typeof body.torch === "string" ? body.torch.slice(0, 20) : "untested";
  // The angle each photo was shot at (Front, Back, Left…), in submit order —
  // recorded so the report/passport labels every side by what it ACTUALLY is
  // rather than reconstructing a fixed sequence that drifts on custom journeys.
  const angleLabels: string[] = Array.isArray(body.angleLabels)
    ? body.angleLabels.slice(0, 6).map((x: unknown) => String(x))
    : [];

  /* VALIDATE-ONLY. Runs the capture gate and stops — no vision call, no photos
   * written, no grade, no cosmeticDone.
   *
   * This is what lets the flow defer grading to the end without making the
   * seller discover a rejected photo set only AFTER they have sat through the
   * display sweep and the Settings scan. The gate is deterministic and AI-free,
   * so asking it twice costs nothing and burns no Gemini quota. */
  const validateOnly = body.validateOnly === true;
  /** Store the photos, answer immediately, grade afterwards. */
  const background = body.background === true;

  // ── CAPTURE GATE ────────────────────────────────────────────────────────
  // Deterministic, AI-free, and authoritative: is a device actually in frame, and
  // are these genuinely different sides? Runs BEFORE the vision cascade for two
  // reasons: a rejected set must never reach the grader, and a rejected set costs
  // zero Gemini quota — which matters because quota exhaustion is precisely what
  // makes the AI layer fail open.
  //
  // Verified against the production photo corpus: this rejects real sessions that
  // previously graded (e.g. six frames of empty grey noise → cosmetic_grade "D"
  // plus a priced offer) while passing every genuine seller set.
  /* RECOVER THE STAGED FRAMES BEFORE THE GATE RUNS.
     The final submit deliberately carries no images — the validate pass already
     stored them. Recovering them after the gate meant the gate judged an empty
     array and rejected the submission with "none of the photos came through",
     which is true of the request and false of the session. */
  let fromStage = false;
  if (!photos.length && !validateOnly) {
    try {
      const st = JSON.parse(String((s as { staged?: string }).staged || "null"));
      if (st && Array.isArray(st.photos) && st.photos.length) {
        photos.push(...st.photos.slice(0, 6));
        if (Array.isArray(st.lit)) lit.push(...st.lit.slice(0, 6));
        fromStage = true;
      }
    } catch { /* nothing staged — the gate below will say so */ }
  }

  const gate = await evaluateCapture(photos, 6);
  if (!gate.ok) {
    const prev = ((s.capture as any) || {}).attempt || 0;
    const verdict = {
      verdict: "retake" as const,
      code: gate.code,
      reasons: gate.reasons,
      attempt: prev + 1,
      distinctViews: gate.distinctViews,
      undecodable: gate.undecodable,
      // Which photos were too soft, so the retake screen can name the angles
      // instead of just saying "some photos are blurry".
      blurryIndexes: gate.blurryIndexes,
      sharpness: gate.sharpness.map((v) => Math.round(v)),
      at: new Date().toISOString(),
    };
    // Persist ONLY the verdict. No grade, no photos, no assessments, no
    // recompute — a rejected capture must leave nothing behind that the report,
    // the passport or the offer could later read as a real assessment.
    // Clearing cosmeticDone is what actually sends both devices back to photos.
    // On the screen as it is NOW, not the copy read before the upload and the
    // gate (SUP-263): only `capture` and `cosmeticDone` are this route's.
    // handoffDone is left alone, as before — /screen clears it on a retake.
    updateScreen(id, (cur) => screenAfterReject(cur, verdict), { capture: JSON.stringify(verdict) });

    logEvent(id, "cosmetics", "capture-rejected", {
      code: gate.code,
      attempt: verdict.attempt,
      blurry: gate.blurryIndexes,
      reason: gate.reasons[0],
    });
    return NextResponse.json({ ok: false, rejected: true, capture: verdict }, { status: 422 });
  }

  /* Gate passed. On a validate-only pass, KEEP THE BYTES.
   *
   * This used to gate the photos and throw them away, so the final submit
   * re-uploaded the identical six frames plus their torch twins — ten to twenty
   * megabytes sent twice from a phone, for pictures the server had already held
   * once. The seller waited through both transfers under one unchanging
   * "Checking the photos…" label.
   *
   * Now the first pass stores them and the second refers to them, so the final
   * submit carries no image payload at all. */
  if (validateOnly) {
    const held = persistPhotos(id, photos);
    db.prepare(
      "UPDATE sessions SET photos = ?, staged = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(
      JSON.stringify(held),
      JSON.stringify({ photos, lit, angleLabels, torch, at: Date.now() }),
      id,
    );
    return NextResponse.json({
      ok: true, validated: true, stored: true,
      photos: photos.length, lit: lit.length,
    });
  }

  /* Pull in the display sweep, if this session already has one.
   *
   * With `gradeAtEnd` the sweep runs BEFORE this call, so by now the screen-on
   * pattern frames exist on the session. Appending them is what finally puts the
   * LCD in front of the grader — previously the Display component was asked to
   * judge a screen it had only ever seen switched off, and so returned an empty
   * grade on every session ever graded. */
  /* SAVE THE PHOTOS BEFORE GRADING THEM.
   *
   * They used to be written only after the vision pass returned, which made
   * the upload and the grade one indivisible wait: the seller stood there
   * while a model thought about pictures that were already on the wire. The
   * two are independent — nothing about storing a JPEG depends on its grade —
   * so saving first is what lets the response come back as soon as the bytes
   * are safe. */
  // Already on disk from the validate pass; only re-persist if this call
  // carried its own images (a client that skipped validation).
  /* Already on disk from the validate pass — reuse those paths rather than
     rewriting identical bytes. The session's `photos` may arrive already
     deserialised or still as JSON text depending on the caller, so handle both
     rather than assuming; assuming is what produced a 500 on a request that was
     otherwise completely valid. */
  const storedPaths = ((): string[] => {
    const raw = (s as { photos?: unknown }).photos;
    if (Array.isArray(raw)) return raw as string[];
    if (typeof raw === "string" && raw.trim()) {
      try { const j = JSON.parse(raw); return Array.isArray(j) ? j : []; } catch { return []; }
    }
    return [];
  })();
  const saved: string[] = fromStage && storedPaths.length ? storedPaths : persistPhotos(id, photos);

  const displayFrames = loadDisplayFrames(s);
  const allPhotos = [...photos, ...lit, ...displayFrames.dataUrls];
  const displayOpt = displayFrames.patterns.length
    ? { startIndex: photos.length + lit.length, patterns: displayFrames.patterns }
    : undefined;

  /**
   * Grade the set and persist it. Awaited normally; fired and forgotten when
   * the caller asked for a background grade.
   */
  // Identifies THIS submission. Shared by the holding row written below and by
  // the grade that lands later, so the stale-Pro guard compares like with like.
  const submitId = Date.now();

  const gradeAndPersist = async () => {
    // ── TIER 1: FLASH (synchronous) ──
    // Only the cheap Flash pass runs before we respond, so the flow proceeds on an
    // instant estimate instead of waiting ~30s for a two-call Flash+Pro sequence.
    // Pro-only mode removes the instant Flash estimate: the seller waits for the
    // accurate grader rather than being shown a cheap number that a background
    // refinement then quietly contradicts. Slower by design, and single-valued.
    let cosmetic = await runVisionCascade(allPhotos, s.model, {
      forceTier: proOnly() ? "pro" : "flash",
      litCount: lit.length,
      display: displayOpt,
    });

    /**
     * ONE RETRY BEFORE GIVING UP — pro-only removes the safety net, so put a
     * smaller one back.
     *
     * With Flash disabled, Pro is the SYNCHRONOUS grader on the seller's capture,
     * and Pro is precisely the tier that hits the provider's per-minute ceiling.
     * Nothing here ever checked for a stub, because when Flash held this slot a
     * failure was rare — so a quota blip would now persist an EMPTY grade onto a
     * real capture and the seller would be quoted on nothing.
     *
     * A single retry after a short pause clears a momentary rate window without
     * reintroducing the cheap tier the operator switched off. If it still fails,
     * the empty result is persisted as before and the report shows an ungraded
     * session — honest, and recoverable with a re-grade — rather than a number
     * nobody stands behind.
     */
    if (cosmetic.tierUsed === "stub" && proOnly()) {
      await new Promise((r) => setTimeout(r, 2500));
      const retry = await runVisionCascade(allPhotos, s.model, {
        forceTier: "pro",
        litCount: lit.length,
        display: displayOpt,
      });
      if (retry.tierUsed !== "stub") cosmetic = retry;
      logEvent(id, "cosmetics", "pro-retry", { recovered: retry.tierUsed !== "stub" });
    }

    // Tags this submission so a slow background Pro refinement can detect whether a
    // NEWER submission (a retake) replaced it in the meantime and bow out instead
    // of clobbering the fresher grade.
    (cosmetic as any)._submitId = submitId;


    // EVERY session is refined on Pro, not just borderline ones.
    //
    // Consistency is why: the same Galaxy Z Fold 6 graded "Premium/100" when Flash
    // answered alone but "A/95" whenever Pro ran — the tiers themselves were the
    // biggest source of "same phone, different result". Flash is confident on clean
    // devices, so `borderline` never fired and its optimistic grade stood as final.
    // Flash still gives the seller an instant number; Pro always settles the record,
    // so one grader decides every stored grade.
    // Nothing to refine when Pro already graded it.
    const willRefine =
      !proOnly() && cosmetic.tierUsed === "flash" && proRefinementAvailable(cosmetic.provider);
    cosmetic.refining = willRefine;

    const okVerdict = { verdict: "ok" as const, code: "ok", reasons: [], attempt: ((s.capture as any) || {}).attempt || 0 };
    persistCosmetic(id, s, cosmetic, saved, okVerdict, angleLabels);
    // First entry in this session's grading history — every later re-grade is
    // diffed against it.
    recordRun(id, cosmetic, { trigger: "capture", photos: saved.length });
    logEvent(id, "cosmetics", "graded", {
      grade: cosmetic.grade || null,
      tier: cosmetic.tierUsed,
      score: cosmetic.score,
      photos: saved.length,
      lit: lit.length,
      torch,
      coverage: cosmetic.coverage,
      findings: cosmetic.findings.length,
      review: cosmetic.needsHumanReview,
      refining: willRefine,
    });

    // ── TIER 2: PRO (background) ──
    // Fire-and-forget: this Node process (pm2 `next start`, not serverless) keeps
    // running after the response, so the Pro pass re-persists the grade + offer
    // when it finishes. A viewer polling the session picks up the upgrade; a
    // dealer/dispute view always ends on the Pro grade. Fully wrapped — a refine
    // failure must never crash the process or corrupt the Flash result.
    if (willRefine) {
      void (async () => {
        try {
          /* RE-FRAME BEFORE REFINING.
           *
           * The Flash pass reported where the handset actually sits in each photo.
           * A seller's side capture puts the phone in a narrow strip with hand,
           * table and room around it, and the grader downsamples the whole
           * picture — so a hairline is sub-pixel before anything examines it, and
           * the surrounding texture is free to be read as damage ON the device.
           *
           * Cropping to the reported box spends the same budget on the phone.
           * This costs NO extra call: the Pro pass already runs, and it is the
           * one whose grade is persisted.
           *
           * Localisation is asked of the model rather than computed, because a
           * gradient-based device finder measured against the stored capture
           * corpus tightened 0 of 24 real photos, and a fixed centre crop of the
           * guide box clipped the handset whenever the seller held it off-centre.
           *
           * The stored photos are NOT touched — the crop exists only in this
           * request, and every returned box is mapped back below. */
          const framed = await cropPhotosToDevice(allPhotos, cosmetic.deviceBoxes ?? []);
          let pro = await runVisionCascade(framed.photos, s.model, {
            forceTier: "pro",
            litCount: lit.length,
            display: displayOpt,
          });
          if (pro.tierUsed !== "pro") {
            // Pro didn't answer → keep the Flash grade, and SAY the refinement is
            // over. Returning with `refining` still true left the report showing
            // "confirming on Pro…" and polling on every visit, for a Pro result
            // that was never coming — on every capture through the Pro outage.
            endRefining(id, submitId, pro.visionError ?? null);
            return;
          }
          /* Back into the stored photos' coordinates, BEFORE anything persists or
           * draws them. Skipping this does not error — it silently paints damage
           * markers in the wrong place on the report. */
          if (framed.croppedCount) remapFindingsToOriginal(pro, framed.applied);

          // CORROBORATE BEFORE CONDEMNING.
          //
          // A single Pro sample decided every stored grade, and Gemini 3 is a
          // reasoning model: identical photos genuinely produce different verdicts
          // run to run. That is survivable for a scratch — it moves the score a
          // little — but not for structural damage, which overrides the score
          // outright and drops the device to D. On one Galaxy Z Fold6 a lone pass
          // reported "Shattered glass" and D was published, while the Flash pass
          // and every later run on the SAME photos called it A/Premium.
          //
          // So D is the one verdict that has to be seen twice. We only pay for the
          // second Pro call when the first one is about to condemn the device —
          // most phones never trigger it, so the cost is close to unchanged — and
          // reconcilePasses then requires both passes to agree before D stands.
          if (pro.grade === "D") {
            // Same framing as the pass it corroborates — two passes that disagree
            // only because one saw a crop and the other saw a room would make
            // reconcilePasses compare readings of different pictures.
            const second = await runVisionCascade(framed.photos, s.model, {
              forceTier: "pro",
              litCount: lit.length,
              display: displayOpt,
            });
            if (second.tierUsed === "pro") {
              if (framed.croppedCount) remapFindingsToOriginal(second, framed.applied);
              pro = reconcilePasses(pro, second);
            }
          }
          pro.refining = false;
          (pro as any)._submitId = submitId;
          const fresh = getSession(id);
          if (!fresh) return;
          // Re-persist only if THIS submission is still the current one — a later
          // retake (verdict reset, or a newer submitId) must win over a stale Pro.
          if ((fresh.capture as any)?.verdict === "retake") return;
          if ((fresh.cosmetic as any)?._submitId !== submitId) return;
          persistCosmetic(id, fresh, pro, null, okVerdict);
          recordRun(id, pro, { trigger: "refine", photos: saved.length });
          logEvent(id, "cosmetics", "pro-refined", {
            grade: pro.grade || null,
            score: pro.score,
            findings: pro.findings.length,
            review: pro.needsHumanReview,
            // How many photos the refinement actually saw re-framed, and how
            // tight. A run of `cropped: 0` means the model has stopped returning
            // deviceBoxes and grading has quietly gone back to reading rooms —
            // which is invisible from the grade alone.
            cropped: framed.croppedCount,
            coverage: Number(framed.meanCoverage.toFixed(2)),
          });
        } catch {
          /* background refinement is best-effort — never fatal; but it must
             not leave the Flash grade claiming a refinement is under way */
          endRefining(id, submitId, "error");
        }
      })();
    }
    return { cosmetic, willRefine };
  };

  /* BACKGROUND GRADE — answer as soon as the photos are stored.
   *
   * The capture gate has already passed at this point, so there is nothing
   * left that the seller's decision depends on: the remaining work is a vision
   * call that takes 8-30s and produces a number the report can collect later.
   * Holding the response for it meant six photos and an LCD sweep ended in a
   * blank wait at the very moment the phone was ready to be handed back.
   *
   * The UPLOAD is still awaited by the client — the bytes are on disk before
   * this returns — so nothing is lost if the seller closes the tab a second
   * later. Only the grading is detached. The session is marked `refining`, and
   * the report already renders that honestly ('Still locating marks') and
   * refreshes itself when the grade lands. */
  if (background) {
    // cosmeticDone on the screen as it is now (SUP-263) — the phone's echoes
    // and the camera's flags written during the upload stay.
    updateScreen(id, screenAfterHolding, {
      photos: JSON.stringify(saved),
      cosmetic: JSON.stringify({ refining: true, findings: [], _submitId: submitId }),
      capture: JSON.stringify({ verdict: "ok", code: "ok", reasons: [], attempt: ((s.capture as any) || {}).attempt || 0 }),
    });
    logEvent(id, "cosmetics", "uploaded", { photos: saved.length, lit: lit.length, torch });
    void gradeAndPersist().catch(() => {
      /* a failed background grade leaves the session `refining`; the report
         says so rather than showing a grade nobody computed */
    });
    return NextResponse.json({ ok: true, uploaded: saved.length, refining: true, background: true });
  }

  const { cosmetic, willRefine } = await gradeAndPersist();
  return NextResponse.json({ ok: true, cosmetic, refining: willRefine, session: getSession(id) });
}

/**
 * The background Pro refinement ended WITHOUT a result: clear `refining` on the
 * Flash grade this submission stored, so the report stops promising an
 * upgrade. Touches only that result — a retake or newer submission owns the
 * session now and must not be edited — and changes nothing but the flag and
 * the reason, so the grade and offer stay exactly what the seller was shown.
 */
function endRefining(id: string, submitId: number, reason: string | null) {
  try {
    const fresh = getSession(id);
    if (!fresh) return;
    if ((fresh.capture as any)?.verdict === "retake") return;
    const cur = fresh.cosmetic as any;
    if (!cur || cur._submitId !== submitId || !cur.refining) return;
    db.prepare("UPDATE sessions SET cosmetic = ? WHERE id = ?").run(
      JSON.stringify({ ...cur, refining: false, refineError: reason }),
      id
    );
    logEvent(id, "cosmetics", "pro-refine-failed", { reason });
  } catch {
    /* best-effort, like the refinement itself */
  }
}

// Persist a cosmetic result onto the session: merge functional assessments, fill
// the model from what the vision model identified, write the grade + evidence,
// mark cosmeticDone, and recompute the overall grade. `savedPhotos` is null on a
// background re-persist (the photos were already written by the Flash phase).
function persistCosmetic(
  id: string,
  s: Session,
  cosmetic: VisionCascadeResult,
  savedPhotos: string[] | null,
  okVerdict: { verdict: "ok"; code: string; reasons: string[]; attempt: number },
  angleLabels?: string[]
) {
  const funcAssessments = Object.entries(s.functional).map(([testId, r]) => ({
    component: testId,
    condition: r === "pass" ? "Working" : r === "fail" ? "Faulty" : "Skipped",
    component_group: "Functional Classification" as const,
    weight: r === "skip" ? 0 : 1,
    assessment_types: [testId],
  }));
  const assessments = [...cosmetic.assessments, ...funcAssessments];

  const identified = cosmetic.device;

  /**
   * COLOUR — the seller's claim against what the photographs show.
   *
   * The cheapest same-model swap check there is. A TAC gives make and model but
   * never finish, so an operator entering a beaten iPhone 15 Pro's IMEI while
   * photographing a mint one passes every model check — both ARE 15 Pros. Colour
   * is the most-varying attribute between units of one model, and it is the one
   * thing the photos can settle independently of anything the seller typed.
   *
   * Matched loosely on purpose: "Space Black" / "black" / "Midnight" are the
   * same answer to a human, and a register full of naming quibbles would bury
   * the real cases. Only a genuine colour-word disagreement is recorded.
   */
  /**
   * Phonecheck's colour beats the seller's, for the same reason as capacity: it
   * comes off the device, not from the person being paid. Falls back to the
   * typed answer where Phonecheck found nothing.
   */
  const pcDev = s.phonecheck as { colour?: string; found?: boolean } | null;
  const colourClaimSource = pcDev?.found && pcDev.colour ? "phonecheck" : "typed";
  const colourClaimRaw = pcDev?.found && pcDev.colour ? pcDev.colour : (s.device as any)?.color;
  const claimedColour = String(colourClaimRaw ?? "").toLowerCase().trim();
  const seenColour = String(identified?.colour ?? "").toLowerCase().trim();
  if (claimedColour && seenColour) {
    const words = (v: string) => new Set(v.split(/[^a-z]+/).filter((w) => w.length > 2));
    const a = words(claimedColour);
    const b = words(seenColour);
    const overlap = [...a].some((w) => b.has(w));
    if (!overlap) {
      recordCompliance({
        sessionId: id,
        clientId: s.client_id,
        kind: "identity.colour_mismatch",
        expected: String(colourClaimRaw ?? ""),
        observed: String(identified?.colour ?? ""),
        source: colourClaimSource,
        detail: { note: `${colourClaimSource} colour vs the body colour in the photos` },
      });
    }
  }

  // The vision pass's own model verdict, recorded rather than only rendered —
  // a mismatch already hard-stops the offer, but nothing kept a record of it.
  if (identified?.match === "mismatch") {
    recordCompliance({
      sessionId: id,
      clientId: s.client_id,
      kind: "identity.model_vs_vision",
      expected: s.model || "(no claimed model)",
      observed: [identified.make, identified.model].filter(Boolean).join(" "),
      source: "vision",
      detail: { reason: String(identified.reason || "").slice(0, 200) },
    });
  }
  // Keep the captured angle labels on the session so the report can label each
  // photo correctly. On a background Pro re-persist no labels are passed — the
  // current `screen` carries the Flash-phase labels through.
  //
  // The screen is the one stored NOW, not `s.screen` (SUP-263). This runs after
  // an 8-30 s vision call, and `s` was read when the request began: spreading
  // that copy erased the camera's handoffDone and the phone's echoes, so the
  // customer's phone never saw the camera finish. Only `capture`,
  // `cosmeticDone` and `angleLabels` are this route's; everything else stays.
  const photosJson = savedPhotos ? JSON.stringify(savedPhotos) : JSON.stringify(s.photos);

  // The model is worked out from the row as it is NOW, inside the write: /ocr
  // may have named the phone from its Settings screen during the vision call,
  // and `s.model` is the copy read before it (lib/cosmeticScreen.ts).
  updateScreen(
    id,
    (cur) => screenAfterGrade(cur, okVerdict, angleLabels),
    (row) => ({
      cosmetic: JSON.stringify(cosmetic),
      cosmetic_grade: cosmetic.grade,
      photos: photosJson,
      assessments: JSON.stringify(assessments),
      model: modelAfterGrade(row.model, identified),
      capture: JSON.stringify(okVerdict),
    })
  );

  recomputeOverall(id);
}

/**
 * Read this session's display-sweep captures back off disk as data URLs.
 *
 * The sweep stores them as served paths (`/api/uploads/…`) so the report can
 * show them without bloating the DB; the grader needs the bytes. Missing or
 * unreadable files are skipped silently — a sweep that half-succeeded should
 * still contribute the frames it did get, and the prompt tells the grader to
 * return an empty display grade rather than guess when they're absent.
 */
function loadDisplayFrames(s: { screen?: unknown }): { dataUrls: string[]; patterns: string[] } {
  const caps = ((s.screen as any)?.displayCheck?.captures || []) as Array<{ pattern?: string; photo?: string }>;
  const dataUrls: string[] = [];
  const patterns: string[] = [];
  for (const c of caps.slice(0, 8)) {
    const name = String(c.photo || "").split("/").pop();
    if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) continue;
    try {
      const buf = fs.readFileSync(path.join(process.cwd(), "data", "uploads", name));
      dataUrls.push(`data:image/jpeg;base64,${buf.toString("base64")}`);
      patterns.push(String(c.pattern || "pattern"));
    } catch {
      /* frame gone — skip it rather than fail the whole grade */
    }
  }
  return { dataUrls, patterns };
}
