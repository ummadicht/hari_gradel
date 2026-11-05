/**
 * What /api/sessions/[id]/cosmetic writes into a session's `screen` blob
 * (SUP-263).
 *
 * `screen` is shared by several writers — the camera (`pattern`,
 * `handoffDone`), the phone (`shown`/`shownAt` echoes), the camera's check-in
 * (`connectedAt`), /display (`displayCheck`). /cosmetic owns only three of its
 * fields: `capture`, `cosmeticDone` and `angleLabels`. Each function takes the
 * screen AS IT IS STORED NOW (lib/db.ts `updateScreen` hands it over inside the
 * write's own transaction) and changes only those, so nothing another writer
 * put there is lost.
 *
 * Pure, so the exact changes the route makes are unit-tested
 * (lib/updateScreen.test.mjs).
 */
type Screen = Record<string, any>;

/** A graded set (the Flash grade, a background grade or the Pro re-persist). */
export function screenAfterGrade(current: Screen, okVerdict: Record<string, unknown>, angleLabels?: string[]): Screen {
  return {
    ...current,
    capture: okVerdict,
    cosmeticDone: true,
    // A re-persist passes no labels — the ones already stored carry through.
    angleLabels: angleLabels && angleLabels.length ? angleLabels : current.angleLabels,
  };
}

/** The background branch: the photos are stored and the grade comes later. */
export function screenAfterHolding(current: Screen): Screen {
  return { ...current, cosmeticDone: true };
}

/**
 * A set the capture gate rejected: record the verdict and clear cosmeticDone,
 * which is what sends both devices back to photos. `handoffDone` is left alone,
 * as it always was — /screen clears it when the camera announces the retake.
 */
export function screenAfterReject(current: Screen, verdict: Record<string, unknown>): Screen {
  const next: Screen = { ...current, capture: verdict };
  delete next.cosmeticDone;
  return next;
}

/**
 * The session's model after a grade: the vision pass's make and model fill it
 * only when the model AS STORED NOW is empty or "Unknown…". Worked out inside
 * the write (lib/db.ts updateScreen, columns as a function of the row), never
 * from the copy the route read before its 8-30 s vision call — /ocr can name
 * the phone from its Settings screen in between, and a vision guess (a 16 Pro
 * Max for a 17 Pro Max) or the stale "Unknown…" must not replace that.
 */
export function modelAfterGrade(
  current: string | null | undefined,
  identified: { make?: string | null; model?: string | null } | null | undefined
): string {
  const now = current ?? "";
  const noModel = !now || /^unknown/i.test(now);
  if (!noModel || !identified?.model) return now;
  return [identified.make, identified.model].filter(Boolean).join(" ").trim();
}
