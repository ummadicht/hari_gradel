import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { db, getSession } from "@/lib/db";
import { runVisionCascade, reconcilePasses, type VisionCascadeResult } from "@/lib/visionAgents";
import { cropPhotosToDevice, remapFindingsToOriginal } from "@/lib/capture/cropPhotos";
import { availableProviders, proOnly, type VisionProvider } from "@/lib/visionProvider";
import { recomputeOverall } from "@/lib/recompute";
import { isEntAuthed } from "@/lib/entAuth";
import { portalUser } from "@/lib/portalAuth";
import { recordRun, previousRun, diffRuns } from "@/lib/gradingRuns";
import { logEvent } from "@/lib/events";
import { computeOffer } from "@/lib/offer";
import { effectiveCatalog } from "@/lib/priceCatalog";
import { marketBaseFor } from "@/lib/clientPricing";
import { getProgramConfig } from "@/lib/programConfig";
import { regradeWrites, resolveImeiForRegrade } from "@/lib/imeiCache";
import { lookupGrant } from "@/lib/lookupBudget";
import { computeTrust } from "@/lib/trust";
import { evaluateCapture } from "@/lib/captureGateServer";

// POST /api/sessions/[id]/reprocess
//
// RE-GRADE THE WHOLE RECORD, not just the cosmetics.
//
// A report is one claim made of several parts — condition, identity, diagnostics,
// trust and price — and re-running only the vision half left the other halves
// speaking for an older assessment. So this refreshes everything that can be
// re-derived from evidence we already hold:
//
//   • cosmetic grade   ← the stored photos, through the CURRENT vision pipeline
//   • device identity  ← the same pass (make/model/match) + the IMEI's answer
//   • diagnostics      ← the IMEI's one Phonecheck answer (battery, FMiP,
//                        blacklist, lock), through the 24 h lookup cache, with
//                        the station database asked again when that answer
//                        holds no station record
//   • overall grade    ← recombined
//   • trade-in offer   ← re-priced from the client's live catalog
//   • trust score      ← derived, so it follows automatically
//
// What it deliberately does NOT touch: the FUNCTIONAL results. Those are
// measurements taken on the device itself, and no amount of re-reading old
// photos produces a new one. Re-running them needs the phone back.
//
// Unlike the live /cosmetic flow, this runs the FULL synchronous two-tier pass
// (Flash → Pro escalation) and waits for it: a manual reprocess should return the
// final Pro grade, not an instant Flash estimate with a background upgrade.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  /**
   * STAFF ONLY.
   *
   * This route was completely open: anyone holding a report link could POST it,
   * repeatedly, and each call spends real paid Pro vision credits. Worse, it
   * lets the person being quoted re-roll their own grade until they like the
   * letter — grade shopping against our own price. Re-grading is an operator
   * action, so it needs an operator.
   */
  if (!(await isEntAuthed())) {
    return NextResponse.json({ error: "staff sign-in required to re-grade" }, { status: 401 });
  }
  const actor = (await portalUser())?.username || "staff";

  const { id } = await params;
  const s = getSession(id);
  if (!s) return NextResponse.json({ error: "not found" }, { status: 404 });

  const stored: string[] = Array.isArray(s.photos) ? s.photos : [];
  if (stored.length === 0) {
    return NextResponse.json(
      { error: "no stored photos to reprocess" },
      { status: 400 }
    );
  }

  // Map each "/api/uploads/<file>.jpg" back to its file on disk and re-encode as
  // a data URL for the vision call. Skip any file that has gone missing.
  const dir = path.join(process.cwd(), "data", "uploads");
  const dataUrls: string[] = [];
  for (const url of stored) {
    const file = url.split("/").pop();
    if (!file) continue;
    const abs = path.join(dir, file);
    try {
      const buf = fs.readFileSync(abs);
      dataUrls.push(`data:image/jpeg;base64,${buf.toString("base64")}`);
    } catch {
      /* file gone — skip it */
    }
  }
  if (dataUrls.length === 0) {
    return NextResponse.json(
      { error: "stored photo files are missing on disk" },
      { status: 410 }
    );
  }

  /**
   * RE-CHECK THE IMAGES THEMSELVES, not just what the model says about them.
   *
   * The capture gate (device present? six distinct views? sharp enough?) only
   * ever ran at capture time, so a re-grade re-read photos that today's gate
   * would reject and reported the resulting letter with a straight face. The
   * blur bar has since been raised twice — a set that squeaked through in the
   * morning is not necessarily gradeable evidence in the afternoon.
   *
   * It does NOT block: the operator asked for this run, and refusing would
   * strand them on the older grade with no way forward. It grades, and it says
   * plainly that the photos are below the current bar.
   */
  const captureCheck = await evaluateCapture(dataUrls, dataUrls.length);
  db.prepare("UPDATE sessions SET capture = ? WHERE id = ?").run(
    JSON.stringify({
      verdict: captureCheck.ok ? "ok" : "below-standard",
      code: captureCheck.code,
      reasons: captureCheck.reasons,
      attempt: ((s.capture as any) || {}).attempt || 0,
      recheckedAt: new Date().toISOString(),
    }),
    id,
  );

  const priorCosmetic = (s.cosmetic ?? {}) as Partial<VisionCascadeResult>;
  const before = {
    grade: s.cosmetic_grade,
    tierUsed: priorCosmetic.tierUsed,
    score: priorCosmetic.score,
    findings: Array.isArray(priorCosmetic.findings) ? priorCosmetic.findings.length : 0,
  };

  // Tier is the caller's to choose — an operator re-running a batch on Flash to
  // triage cheaply is a real workflow — but the DEFAULT is Pro: reprocessing
  // exists to SETTLE a grade, so it shouldn't depend on whether Flash happened
  // to feel uncertain. If Pro is rate-limited, fall back to Flash rather than
  // losing the run.
  const body = (await req.json().catch(() => ({}))) as { tier?: string; provider?: string };
  /**
   * "Re-grade with <vendor>" — a SECOND OPINION from a different model family.
   *
   * Two samples of one model share that model's blind spots, so re-running
   * Gemini twice corroborates less than it appears to. An independent vendor
   * failing to see the same defect is much stronger evidence it was never
   * there. Only an explicitly named, key-configured provider is honoured; an
   * unknown name falls through to the normal selection rather than erroring,
   * and visionJSON does NOT fall back for a forced provider, so the answer is
   * always honestly attributable to the model the operator chose.
   */
  const askedProvider = String(body.provider || "").toLowerCase().trim();
  const forcedProvider = (availableProviders() as string[]).includes(askedProvider)
    ? (askedProvider as VisionProvider)
    : undefined;
  // Pro-only mode overrules the caller: the cheap tier is switched off for
  // this operator precisely so it can never produce a stored grade.
  const wanted: "flash" | "pro" = proOnly() ? "pro" : body.tier === "flash" ? "flash" : "pro";
  let passes: string[] = [];

  /**
   * A Pro re-grade runs TWO independent passes and reconciles them, because a
   * single pass is not reproducible: the same photos graded B/2-findings then
   * A/0-findings on consecutive Pro runs. The worse grade and the union of
   * findings win, and a disagreement flags human review (see reconcilePasses).
   * Flash stays single-pass — it is the cheap triage tier, and its job is speed.
   */
  let cosmetic: VisionCascadeResult;
  if (wanted === "pro") {
    /**
     * SEQUENTIALLY, not concurrently.
     *
     * These two passes used to fire together via Promise.all. Each one carries
     * every stored photo plus a ~31k-character prompt, so two at once is a
     * burst big enough to trip the provider's per-minute ceiling — and the
     * evidence for that is in this session's own history: the `passes` field
     * recorded "D/—" (one pass answered, one returned nothing) on two separate
     * re-grades before degrading to "—/—" entirely. A second opinion that is
     * rate-limited into silence is not a second opinion, and the reconcile then
     * has nothing to reconcile.
     *
     * Serial costs latency — this is the "settle it" action, which the operator
     * already waits on — and buys an answer that actually arrives. The pause
     * between them keeps the two calls out of the same rate window.
     */
    /* Re-frame to the handset first, exactly as the capture-time refinement
     * does — otherwise "settle it" would re-read the whole room and reach a
     * different answer from the automatic Pro pass on the very same photos,
     * which is the inconsistency an operator would report as a bug.
     *
     * The boxes come from the LAST grading run rather than a fresh call: the
     * stored photos have not changed, so where the phone sits in them has not
     * either, and re-deriving it would cost a call for a known answer. No
     * stored boxes (an older session) simply means no crop. */
    /* Sessions graded before deviceBoxes existed carry none, and every session
     * already in the database is one of those — so without this the crop would
     * silently no-op on exactly the back catalogue an operator re-grades. A
     * Flash pass is the cheap tier and localisation is all we want from it, so
     * when the boxes are missing we buy them rather than skip the re-framing. */
    let boxes = (s.cosmetic as any)?.deviceBoxes ?? [];
    if (!boxes.length) {
      const locate = await runVisionCascade(dataUrls, s.model, { forceTier: "flash", provider: forcedProvider });
      boxes = locate.deviceBoxes ?? [];
    }
    const framed = await cropPhotosToDevice(dataUrls, boxes);
    /* Whether the re-framing actually happened, recorded BEFORE the grade.
     *
     * Without this a re-grade that returns an identical result is unreadable:
     * it could mean the crop applied and changed nothing, or that it silently
     * never applied. Those call for opposite next steps, and guessing between
     * them is how a feature gets believed to work for weeks. */
    logEvent(id, "cosmetics", "reprocess-framing", {
      actor,
      storedBoxes: ((s.cosmetic as any)?.deviceBoxes ?? []).length,
      derivedBoxes: boxes.length,
      cropped: framed.croppedCount,
      photos: dataUrls.length,
      coverage: Number(framed.meanCoverage.toFixed(2)),
    });
    const passA = await runVisionCascade(framed.photos, s.model, { forceTier: "pro", provider: forcedProvider });
    await new Promise((r) => setTimeout(r, 1500));
    const passB = await runVisionCascade(framed.photos, s.model, { forceTier: "pro", provider: forcedProvider });
    // Back to the stored photos' coordinates BEFORE reconciling — the two
    // passes are compared by where their findings sit, so mixed coordinate
    // spaces would make agreeing passes look like disagreeing ones.
    if (framed.croppedCount) {
      remapFindingsToOriginal(passA, framed.applied);
      remapFindingsToOriginal(passB, framed.applied);
    }
    cosmetic = reconcilePasses(passA, passB);
    passes = [passA.grade || "—", passB.grade || "—"];
  } else {
    cosmetic = await runVisionCascade(dataUrls, s.model, { forceTier: "flash", provider: forcedProvider });
  }
  /**
   * TIER DOWNGRADES MUST BE VISIBLE.
   *
   * When both Pro passes fail, this falls back to Flash so the operator gets
   * *something* — reasonable. What was not reasonable is that it said nothing:
   * the operator picked "Pro (settle)", waited, and got back a result labelled
   * "flash" with no explanation, so a cheap-tier answer looked like a settled
   * one. On session 9016c5b4 that is exactly how four consecutive Pro grades of
   * D became a Flash grade of A — not because the phone changed, but because
   * the tier silently did, and Flash saw none of the findings Pro had.
   *
   * Two Pro passes run CONCURRENTLY here, each carrying every stored photo and
   * a ~31k-character prompt, so repeated re-grades hit a token/rate ceiling
   * long before the API itself is unhealthy (both tiers answer a small prompt
   * fine). That is a quota story, and the operator needs to be told it so they
   * can wait rather than trust the downgraded letter.
   */
  let degraded: string | null = null;
  // In pro-only mode there is nothing to fall back TO — a failed Pro is a
  // failed grade, reported as such below, never a Flash answer in disguise.
  if (cosmetic.tierUsed === "stub" && wanted === "pro" && !proOnly()) {
    // WHY Pro failed decides what the operator should do next, so keep it:
    // an overloaded model (5xx) is not cured by waiting a minute, a quota is.
    const proError = cosmetic.visionError ?? null;
    // Keep the forced provider on the retry too — dropping it here would answer
    // a "re-grade with X" request using a different vendor without saying so.
    cosmetic = await runVisionCascade(dataUrls, s.model, { forceTier: "flash", provider: forcedProvider });
    if (cosmetic.tierUsed !== "stub") {
      degraded =
        proError === "unavailable"
          ? "Pro is unavailable at the provider right now (overloaded or erroring) — this grade came from Flash, the quick tier. Re-grade on Pro once it recovers to settle it."
          : proError === "model_gone"
            ? "The Pro model is no longer available (it has probably been retired) — this grade came from Flash, the quick tier. An admin needs to point the Pro model setting at a current model; waiting will not fix it."
            : proError === "timeout"
              ? "Pro took too long to answer (the provider is slow right now) — this grade came from Flash, the quick tier. Re-grade on Pro later to settle it."
            : proError === "quota"
              ? "Pro hit its per-minute quota (usually after repeated re-grades) — this grade came from Flash, the quick tier. Wait a minute and re-grade on Pro to settle it."
              : "Pro didn't answer — this grade came from Flash, the quick tier. Re-grade on Pro to settle it.";
      logEvent(id, "cosmetics", "reprocess-degraded", { actor, requested: "pro", used: cosmetic.tierUsed, reason: proError });
    }
  }

  // NEVER persist a non-answer over a real grade. Reprocess is a refinement, not
  // a reset: if no provider answered, the existing grade is better evidence than
  // an empty one, so keep it and say the service was unavailable.
  if (cosmetic.tierUsed === "stub") {
    logEvent(id, "cosmetics", "reprocess-failed", { actor, tier: wanted, kept: before.grade, reason: cosmetic.visionError ?? null });
    return NextResponse.json(
      {
        error: "inspection service didn't respond — existing grade kept",
        reason: cosmetic.visionError ?? null,
        before,
        retryable: true,
      },
      { status: 503 }
    );
  }

  // Merge the fresh cosmetic assessments with the existing functional ones.
  const funcAssessments = Object.entries(s.functional).map(([testId, r]) => ({
    component: testId,
    condition: r === "pass" ? "Working" : r === "fail" ? "Faulty" : "Skipped",
    component_group: "Functional Classification" as const,
    weight: r === "skip" ? 0 : 1,
    assessment_types: [testId],
  }));
  const assessments = [...cosmetic.assessments, ...funcAssessments];

  // Adopt a model the vision identified only if the session had none.
  const noModel = !s.model || /^unknown/i.test(s.model);
  const newModel =
    noModel && cosmetic.device?.model
      ? [cosmetic.device.make, cosmetic.device.model].filter(Boolean).join(" ").trim()
      : s.model;

  db.prepare(
    "UPDATE sessions SET cosmetic = ?, cosmetic_grade = ?, assessments = ?, model = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(
    JSON.stringify(cosmetic),
    cosmetic.grade,
    JSON.stringify(assessments),
    newModel,
    id
  );
  recomputeOverall(id);

  // History BEFORE anything derived — this row is the record that the run
  // happened, and it must survive even if a later step throws.
  recordRun(id, cosmetic, { trigger: "reprocess", actor, photos: dataUrls.length });

  /**
   * REFRESH IDENTITY + DIAGNOSTICS — ONE lookup, through the 24 h cache.
   *
   * Both come from the IMEI's one Phonecheck answer (station record, else the
   * GSMA registry). This used to call lookupImei — which itself calls
   * getPhonecheck — and then getPhonecheck again, straight past the cache and
   * the daily limits: two paid lookups per re-grade, for the same answer.
   *
   * resolveImeiForRegrade makes at most one paid call: none when the IMEI was
   * resolved in the last 24 h WITH a station record; one GetDeviceInfo when the
   * cached answer is the registry's (SwapUp's call A is made before the phone
   * goes on a station, so the station test can only be seen by asking again);
   * one full lookup on a miss. The 24 h TTL is still what lets a new lost/stolen
   * report land the next day.
   *
   * What is written back never downgrades (lib/imeiCache.ts regradeWrites): a
   * registry answer, an outage or a held-back lookup never replaces a station
   * record already stored — except that a fresher BLACKLISTED is always kept.
   */
  const refreshed: string[] = [];
  let lookupAt: { cached: boolean; at: string; station: string | null } | null = null;
  const freshBeforeLookups = getSession(id)!;
  if (freshBeforeLookups.imei) {
    try {
      const r = await resolveImeiForRegrade(
        freshBeforeLookups.imei,
        Date.now(),
        await lookupGrant(req, { client: freshBeforeLookups.client_id, channel: freshBeforeLookups.profile?.channel }),
      );
      lookupAt = { cached: r.cached, at: r.at, station: r.station ?? null };
      const w = regradeWrites(
        { imeiInfo: freshBeforeLookups.imei_info, phonecheck: freshBeforeLookups.phonecheck },
        { info: r.info, phonecheck: r.phonecheck },
      );
      if (w.imeiInfo) {
        db.prepare("UPDATE sessions SET imei_info = ? WHERE id = ?").run(JSON.stringify(w.imeiInfo), id);
        refreshed.push("identity");
      }
      if (w.phonecheck) {
        db.prepare("UPDATE sessions SET phonecheck = ? WHERE id = ?").run(JSON.stringify(w.phonecheck), id);
        refreshed.push("diagnostics");
      }
    } catch {
      /* keep the existing identity and diagnostics */
    }
  }

  /**
   * REFRESH THE STORED OFFER.
   *
   * recomputeOverall() rebuilds the overall grade, but the `offer` column was
   * left exactly as it was — so a session re-graded A → D kept its old, higher
   * price on disk. The report happens to hide that (OfferPanel re-POSTs /offer
   * on view), but the console, the audit trail and any export read the stored
   * value, and a saved offer that contradicts the saved grade is the precise
   * failure this codebase keeps having to unwind. Re-price it here, in the
   * client's own currency, off the fresh grade.
   */
  const fresh = getSession(id)!;
  const catalog = effectiveCatalog(fresh.client_id);
  const base = marketBaseFor(fresh.client_id, catalog.currency, fresh.model, (fresh as { model_id?: string }).model_id);
  const offer = computeOffer({
    model: fresh.model,
    cosmetic: {
      grade: fresh.cosmetic_grade,
      conclusive: (fresh.cosmetic as any).conclusive,
      gradeRange: (fresh.cosmetic as any).gradeRange,
      provisional: (fresh.cosmetic as any).provisional,
    },
    functional: fresh.functional,
    imei: fresh.imei_info as any,
    phonecheck: fresh.phonecheck as any,
    pricing: getProgramConfig().pricing,
    catalog,
    marketBase: catalog.currency === "USD" && base === null ? undefined : base,
    vision: {
      obstruction: (fresh.cosmetic as any)?.obstruction,
      deviceMatch: (fresh.cosmetic as any)?.device?.match,
      oemVerdict: (fresh.cosmetic as any)?.oem?.verdict,
    },
  });
  db.prepare("UPDATE sessions SET offer = ?, updated_at = datetime('now') WHERE id = ?").run(
    JSON.stringify(offer),
    id,
  );

  // What actually changed, against the run before this one (falling back to the
  // cosmetic we replaced, for sessions graded before history existed).
  const prior = previousRun(id);
  const diff = diffRuns(priorCosmetic, cosmetic);

  logEvent(id, "cosmetics", "reprocessed", {
    actor,
    tier: cosmetic.tierUsed,
    passes: passes.join("/"),
    from: diff.from || "—",
    to: diff.to || "—",
    direction: diff.direction,
    findings: diff.findingsTo,
    offer: offer.blocked ? "blocked" : offer.offer,
  });

  const finalSession = getSession(id)!;
  const trust = computeTrust(finalSession);

  return NextResponse.json({
    ok: true,
    // Set only when the operator asked for Pro and got Flash instead. The UI
    // must show this: without it a downgraded grade is indistinguishable from
    // a settled one.
    degraded,
    tierRequested: wanted,
    refreshed: ["images", "condition", ...refreshed, "offer", "trust"],
    // Whether identity/diagnostics came from the 24 h cache, when that answer
    // was looked up, and what the station re-check found ("found" | "none" |
    // "failed" | "skipped"; null when none was needed). null: no IMEI.
    lookup: lookupAt,
    // Whether the stored photos still clear today's capture bar. A grade drawn
    // from photos that don't is reported, not hidden.
    captureCheck: {
      ok: captureCheck.ok,
      code: captureCheck.code,
      reasons: captureCheck.reasons,
      blurryIndexes: captureCheck.blurryIndexes,
      distinctViews: captureCheck.distinctViews,
      photos: dataUrls.length,
    },
    // Said out loud so the UI can say it too: re-reading photos cannot re-run a
    // measurement taken on the device.
    notRefreshed: ["functional tests"],
    trust: { score: trust.score, grade: trust.grade, identity: trust.identityVerdict },
    // What each independent pass said, so a disagreement is visible rather than
    // averaged away behind one confident letter.
    passes,
    identity: finalSession.imei_info,
    before,
    after: {
      grade: cosmetic.grade,
      tierUsed: cosmetic.tierUsed,
      escalated: cosmetic.escalated,
      score: cosmetic.score,
      device: cosmetic.device,
      oem: cosmetic.oem,
      needsHumanReview: cosmetic.needsHumanReview,
      findings: cosmetic.findings.length,
    },
    diff,
    offer: { value: offer.offer, currency: offer.currency, blocked: offer.blocked },
    previousRunAt: prior?.at ?? null,
    overall: getSession(id)?.overall_grade ?? "",
  });
}
