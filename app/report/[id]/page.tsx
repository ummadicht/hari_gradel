import { getSession } from "@/lib/db";
import { withBase } from "@/lib/basePath";
import { buildPassport, DIAG_SOURCE } from "@/lib/passport";
import { buildPlan } from "@/lib/suggester";
import OfferPanel from "@/app/components/OfferPanel";
import GradeSelect from "@/app/components/GradeSelect";
import VisionCascade from "@/app/components/VisionCascade";
import DevicePassport from "@/app/components/DevicePassport";
import RefurbPlan from "@/app/components/RefurbPlan";
import ManualChecks from "@/app/components/ManualChecks";
import DisplayResult from "@/app/components/DisplayResult";
import EvidenceShots from "@/app/components/EvidenceShots";
import TrustScoreCard from "@/app/components/TrustScoreCard";
import DamageHighlights from "@/app/components/DamageHighlights";
import CameraFrames from "@/app/components/CameraFrames";
import ComplianceTrail from "@/app/components/ComplianceTrail";
import RefreshWhileRefining from "@/app/components/RefreshWhileRefining";
import { listCompliance } from "@/lib/compliance";
import DeviceInfoCard from "@/app/components/DeviceInfoCard";
import AiInspectionCard from "@/app/components/AiInspectionCard";
import RegradeBar from "@/app/components/RegradeBar";
import { computeTrust } from "@/lib/trust";
import { sessionAlias } from "@/lib/sessionAlias";
import { isEntAuthed } from "@/lib/entAuth";
import { portalUser } from "@/lib/portalAuth";
import { proOnly, refineStatusNow } from "@/lib/visionProvider";
import { resolveExperience, tx } from "@/lib/experience";

export const dynamic = "force-dynamic";

export default async function ReportPage({
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

  // Presentation only: staff see the technical trail, sellers see plain language.
  // This never touches the grade or the price.
  const experience = resolveExperience({ authed: await isEntAuthed() });
  const T = tx(experience);

  /**
   * Where "back" actually goes, per who is holding the link.
   *
   * This was a fixed `href="/"` for everyone, which sent BOTH audiences
   * somewhere they didn't come from: an operator who opened the report from the
   * sessions monitor landed on the marketing home and had to navigate back in,
   * and a seller who arrived from their retailer's trade-in flow was dropped on
   * GradeIQ's own front page — a different brand than the one they were selling
   * to. A back link should undo the last step, not restart the product.
   *
   * Staff go back to the list they were working from (their own client's
   * console when they're scoped to one, the all-sessions monitor when they aren't);
   * a seller goes back to the trade-in flow for the client whose session this
   * is, so the journey continues inside the brand that sent them.
   */
  const staff = experience === "operator" ? await portalUser() : null;
  const back =
    staff?.role === "client" && staff.clientId
      ? { href: `/console/${staff.clientId}`, label: "← Sessions" }
      : staff
        ? { href: "/superadmin", label: "← Sessions" }
        : {
            href: s.client_id ? `/v2?client=${encodeURIComponent(s.client_id)}` : "/",
            label: "← GradeIQ",
          };

  const cosmetic = s.cosmetic as any;
  /**
   * SUP-63: `refining` is only true while the background grade may still land.
   * Older than the Pro timeout + retry + margin, the work died: the page says
   * "Grading did not finish" (and offers staff the re-grade) instead of a
   * spinner. Decided here on every render and never written: reading the
   * report changes no rows.
   */
  const refine = refineStatusNow(cosmetic, s.updated_at);
  const refining = refine.state === "running";
  const unfinished = refine.state === "unfinished";
  const passport = buildPassport(s);
  const trust = computeTrust(s);
  const plan = buildPlan(s);

  // Device OS — for hiding platform-specific tests (Face ID = iOS only). Prefer
  // the tested device's own fingerprint, fall back to the resolved brand.
  const fpUa = String((s.verification as any)?.deviceFp?.ua || "");
  const idStr = `${(s.imei_info as any)?.brand || ""} ${s.model || ""}`;
  const deviceOs = /iphone|ipad|ipod/i.test(fpUa)
    ? "ios"
    : /android/i.test(fpUa)
      ? "android"
      : /apple|iphone|ipad/i.test(idStr)
        ? "ios"
        : /samsung|galaxy|pixel|android|xiaomi|oneplus|motorola|oppo|vivo/i.test(idStr)
          ? "android"
          : "";

  // A grade is "usable for an offer" only if it's conclusive, a provisional
  // range, or a manual pick — NOT a low-confidence AI guess (e.g. glare hid the
  // screen). Otherwise we prompt a retake / manual pick instead of a firm offer.
  const cosmeticUsable =
    !!s.cosmetic_grade &&
    (cosmetic.conclusive || cosmetic.gradeRange || cosmetic.source === "manual");
  const shakyAi =
    !!s.cosmetic_grade && !cosmeticUsable && cosmetic.source === "gemini";

  return (
    <div className="mx-auto w-full max-w-5xl px-4 pb-8">
      <div className="flex items-center justify-between py-3">
        <a href={withBase(back.href)} className="pill">
          {back.label}
        </a>
        <span className="pill mono" title={s.id}>#{sessionAlias(s.id)}</span>
      </div>

      {/* Re-grade sits ABOVE everything it changes — condition, identity,
          diagnostics, overall grade and price all move together, so the control
          for that belongs at the top of the record, not inside one section.
          Operators only; the API enforces the same rule independently. */}
      {experience === "operator" && (
        <RegradeBar
          proOnly={proOnly()}
          sessionId={s.id}
          overall={s.overall_grade}
          trustScore={trust.score}
          lastGraded={s.updated_at}
          tierUsed={cosmetic?.tierUsed}
          unfinished={
            unfinished
              ? {
                  since: refine.startedAt ? `${new Date(refine.startedAt).toISOString().slice(0, 16).replace("T", " ")} UTC` : null,
                  afterMinutes: Math.round(refine.limitMs / 60_000),
                }
              : undefined
          }
        />
      )}

      {/* ── Reading order: Model → Damage → Functional → Price ─────────────────
          The one verified record leads (its own sections run model details →
          cosmetic damage → functional). Then the damage evidence, the functional
          checklist, and the offer — so a reader reaches the price right after
          condition + function, before the deeper assessment trail below. */}
      {/* The grade can still be settling when this page renders — see the
          detached Pro pass in the cosmetic route. Without this the report shows
          the provisional result and never updates itself. */}
      <RefreshWhileRefining
        sessionId={s.id}
        refining={refining}
        remainingMs={refine.startedAt ? refine.startedAt + refine.limitMs - refine.judgedAt : undefined}
      />

      {/* SUP-63: the grading died. Sellers are told plainly, and that the store
          acts, not them; staff get the same news on the re-grade bar above. */}
      {unfinished && experience !== "operator" && (
        <section
          className="card mt-4 p-5"
          role="status"
          style={{ borderColor: "var(--gold-2)" }}
        >
          <h2 className="text-lg font-bold">{T.unfinished}</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">{T.unfinishedBody}</p>
        </section>
      )}

      <DevicePassport p={passport} />

      {/* Extracted photos + highlighted damage — the evidence behind the grade */}
      <DamageHighlights
        photos={s.photos}
        findings={cosmetic?.findings ?? []}
        labels={passport.cosmetic.angles.map((a) => a.label)}
        /* So an empty panel can say WHY it is empty instead of showing a green
           "no visible damage" tick over a grade that says otherwise. */
        refining={refining}
        unfinished={unfinished}
        deviceBoxes={cosmetic?.deviceBoxes ?? []}
      />

      {/* Compliance trail — OPERATOR ONLY, and only when something disagreed.
          A seller should not read an automated "IMEI on screen ≠ IMEI entered"
          about their own phone; that is a conversation for a human. */}
      {experience === "operator" && <ComplianceTrail events={listCompliance(s.id)} />}

      {/* Camera test shots — OPERATOR ONLY. The front-lens frame shows whoever
          was holding the phone, i.e. the seller; that is evidence for the buyer,
          not something to render back at the person it depicts. */}
      {experience === "operator" && (
        <CameraFrames
          frames={(s.camera as any)?.frames}
          assessment={(s.camera as any)?.assessment}
        />
      )}

      {/* Functional checklist — highlights what the device couldn't auto-test */}
      <ManualChecks
        sessionId={s.id}
        initial={s.functional as Record<string, string>}
        camera={s.camera as any}
        deviceOs={deviceOs}
        canOverride={experience === "operator"}
        stationAnswered={{
          battery: passport.diagnostics.rows.some(
            (r) => (r.key === "batteryHealth" || r.key === "batteryCycles") && r.value != null && r.source === DIAG_SOURCE.station
          ),
          activationLock: passport.diagnostics.rows.some(
            (r) => r.key === "fmip" && r.value != null && r.source === DIAG_SOURCE.station
          ),
        }}
      />

      {/* AI trade-in offer — the price, right after condition + functional. Needs
          a usable cosmetic grade first. */}
      {cosmeticUsable ? (
        <OfferPanel sessionId={s.id} />
      ) : (
        <section className="card mt-4 p-5">
          <h2 className="text-lg font-bold">Cosmetic condition</h2>
          {shakyAi ? (
            <div className="mb-3">
              <div className="pill chip-yellow" style={{ fontSize: 12 }}>
                {T.notConfident}{experience === "operator" ? ` (${Math.round((cosmetic.confidence ?? 0) * 100)}%)` : ""}
              </div>
              <p className="mt-2 text-sm text-[var(--muted)]">
                {cosmetic.notes || "Couldn't confirm the condition from the photos."}{" "}
                <a className="text-[var(--brand)]" href={withBase(`/staff/${s.id}`)}>
                  Retake photos
                </a>{" "}
                for a firm grade
                {experience === "operator" ? ", or set the condition below." : ", or ask the store to confirm the condition."}
              </p>
            </div>
          ) : unfinished ? (
            <p className="mb-3 text-sm text-[var(--muted)]">
              {experience === "operator"
                ? `${T.unfinished}. Re-grade above, or set the condition below.`
                : `${T.unfinished}. The store will check your phone again. You can also pick the condition below to see an offer now.`}
            </p>
          ) : (
            <p className="mb-3 text-sm text-[var(--muted)]">
              {T.notGraded} —{" "}
              <a className="text-[var(--brand)]" href={withBase(`/staff/${s.id}`)}>
                {T.takePhotos}
              </a>
              , or pick the condition to get an offer now.
            </p>
          )}
          {/* The photos already produced a grade here, so only staff may set one
              by hand — the API refuses a seller's pick (409) rather than let it
              replace the AI's reading. With no grade at all, anyone may pick;
              without a sign-in that pick is stored as provisional. */}
          {(experience === "operator" || !shakyAi) && <GradeSelect sessionId={s.id} />}
        </section>
      )}

      {/* ── Below the price: the deeper assessment & evidence trail ───────────
          confidence, AI-inspection detail, OCR facts, Settings screenshots,
          display validation, parts authenticity, refurb plan, and the full
          agentic cascade — all secondary to the model/damage/functional/price
          summary above. */}
      <TrustScoreCard trust={trust} />

      {/* AI inspection evidence — model match, OEM verdict, which tier graded,
          human-review flag + a one-click reprocess. Always shown so the grade
          reads as inspected, not opaque; the reprocess button also lifts an
          older/stub grade onto the current pipeline. */}
      <AiInspectionCard
        experience={experience}
        sessionId={s.id}
        grade={s.cosmetic_grade}
        tierUsed={cosmetic?.tierUsed}
        escalated={cosmetic?.escalated}
        refining={refining}
        unfinished={unfinished}
        needsHumanReview={cosmetic?.needsHumanReview}
        device={cosmetic?.device}
        oem={cosmetic?.oem}
        findingsCount={(cosmetic?.findings ?? []).length}
        notes={cosmetic?.notes}
      />

      {/* Facts OCR'd from the device's own Settings (IMEI, battery, parts…) */}
      <DeviceInfoCard ocr={s.ocr as any} />

      {/* The device's own Settings / *#06# / Battery-Health screenshots — the
          evidence behind the IMEI, storage and battery-health numbers above. */}
      <EvidenceShots
        shots={((s.ocr as any)?.shots ?? []) as { url: string; kind?: string }[]}
        read={{
          imei: (s.ocr as any)?.imei,
          model: (s.ocr as any)?.model,
          storage: (s.ocr as any)?.storage,
          batteryHealth: (s.ocr as any)?.batteryHealth,
          serial: (s.ocr as any)?.serial,
        }}
      />

      {/* AI display validation — captured screen patterns + panel findings */}
      {(s.screen as any)?.displayCheck && (
        <DisplayResult check={(s.screen as any).displayCheck} />
      )}

      {/* Parts authenticity — the critical non-OEM check */}
      {!(s.parts as any)?.found && (
        <a
          href={withBase(`/parts/${s.id}`)}
          className="mt-4 flex items-center justify-between rounded-3xl border border-[var(--border)] bg-[var(--card)] px-6 py-5 sm:px-9"
        >
          <div>
            <div className="text-[15px] font-semibold">
              Check parts authenticity
            </div>
            <div className="mt-0.5 text-[13px] text-[var(--muted)]">
              Scan the phone&apos;s Settings → About to verify genuine vs non-OEM
              display, battery &amp; cameras.
            </div>
          </div>
          <span className="text-[var(--brand)]">→</span>
        </a>
      )}

      {/* Refurb plan — next best action from cosmetic + functional grading */}
      <RefurbPlan plan={plan} />

      {/* Agentic detail — how the Vision AI reached the grade */}
      {cosmetic?.specialists?.length > 0 && (
        <VisionCascade photos={s.photos} cascade={cosmetic} model={s.model} />
      )}

      <footer className="py-8 text-center text-xs text-[var(--muted)]">
        Generated by GradeIQ · {s.updated_at}
      </footer>
    </div>
  );
}
