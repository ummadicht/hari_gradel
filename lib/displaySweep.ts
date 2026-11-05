/**
 * The camera's screen sweep: how long it waits, how often it tries again, and
 * how it decides that the colour inside the locked screen box is the one the
 * phone was asked to show (SUP-264).
 *
 * Pure and dependency-free, so the rules run under a fake clock in
 * lib/displaySweep.test.mjs; app/components/V2Cam.tsx supplies the camera, the
 * session calls and the clock.
 *
 * Why it changed (field test 25 Oct, SU-AND-00048): the sweep confirmed 4 of 6
 * colours, and 7 of the 9 SwapUp sweeps since 17 Oct were incomplete — black
 * missing in every one that listed its misses. Each colour had ONE try (a
 * 2.6 s echo wait, then 4 s to match), and the match was absolute: black
 * needed every channel under 95, which glare on the glass defeats, and green a
 * fixed +30 lead, which a dim browser screen (it cannot raise its own
 * brightness) misses. Now a missed colour is tried again on the same lock, and
 * black and green are also judged against the white frame the sweep locked on
 * — on a try where the phone confirmed it is showing that colour.
 *
 * The relative cut-offs below are reasoned, not yet measured: the field
 * sessions store only the frames that matched, never the ones that missed. So
 * a miss now reports what the camera saw (`cleanSweepStats`, kept on the
 * session's displayCheck) and the cut-offs are to be re-tuned on those numbers.
 */

/** Wait for the phone to echo the first (white) pattern. Unchanged. */
export const SWEEP_WHITE_ECHO_MS = 4000;
/** Wait for the phone to echo each later colour (was 2600). */
export const SWEEP_ECHO_MS = 4000;
/** Look for each colour inside the locked box, per try. Unchanged. */
export const SWEEP_MATCH_MS = 4000;
/** Extra tries for a colour that was not seen, on the same lock. */
export const SWEEP_RETRIES = 2;
/** Retries only start while the sweep has spent less than this since the lock. */
export const SWEEP_RETRY_BUDGET_MS = 60_000;
/** One full try of a colour: the echo wait plus the look. */
export const SWEEP_TRY_MS = SWEEP_ECHO_MS + SWEEP_MATCH_MS;
/** The echo wait 6aa0726 used for every colour after white. */
export const SWEEP_ECHO_MS_BEFORE = 2600;
/**
 * The phone leaves its pattern screen this long after it first sees
 * cosmeticDone without handoffDone — GradeIQ's /v2 (V2Flow.tsx, await2nd) and
 * SwapUp Check (pairing.ts GRACE_AFTER_COSMETIC_MS) both use 30 s.
 */
export const PHONE_GRACE_AFTER_COSMETIC_MS = 30_000;
/** Kept back from that grace for the phone's poll and the network. */
export const PHONE_GRACE_MARGIN_MS = 3_000;

/**
 * Black: luminance at most this fraction of the locked white frame's.
 *
 * Glare lifts every channel of a black screen together, so the cut-off has to
 * reach above the absolute rule's 95 — a frame's luminance is never below its
 * smallest channel, and 0.35 x white (at most 89) could never pass a lifted
 * black. 0.48 passes glare up to about 47% of white (110 against a white of
 * 235) and still refuses the phone's #808080 grey, which reads at about half.
 */
export const BLACK_REL = 0.48;
/** …with the channels this close together, so a tinted, blue or red frame is never black… */
export const BLACK_MAX_SPREAD = 40;
/**
 * …and flat. Stripes: the in-box luminance spread above which the box holds
 * bands, not a flat field — the same 32 the stripes pattern has always used. A
 * striped frame's mean sits near half of white, so black must refuse it.
 */
export const STRIPES_MIN_SD = 32;
/** Green: on white-balanced channels, green at least this many times red and blue… */
export const GREEN_REL = 1.15;
/** …ahead of both by at least this much in raw camera values… */
export const GREEN_MIN_LEAD = 10;
/**
 * …green at least this share of what green read on white, and brighter overall
 * than the black cut-off — so no frame dark enough to be black is ever green.
 */
export const GREEN_MIN_REL_G = 0.35;

/** Mean colour (and luminance spread) inside the locked screen box. */
export type RegionStats = { r: number; g: number; b: number; sd: number };

export function luminance(st: { r: number; g: number; b: number }): number {
  return 0.299 * st.r + 0.587 * st.g + 0.114 * st.b;
}

/**
 * Does what the camera sees inside the locked box match the pattern asked for?
 *
 * The absolute rules are exactly the ones the sweep always used, so nothing
 * that matched before stops matching. With `white` — the stats of the white
 * frame the sweep locked on — black and green ALSO match relative to it, which
 * carries the camera's own exposure and the screen's own brightness. The sweep
 * passes `white` only on an echoed try (`matchesOnTry`).
 */
export function matchesPattern(st: RegionStats, p: string, white?: RegionStats | null): boolean {
  const { r, g, b, sd } = st;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  switch (p) {
    case "white":  return mn > 130 && mx - mn < 70;
    // Mid-gray: a flat neutral field, dimmer than white but well above black,
    // with the channels close together (no colour cast). This is the frame that
    // makes LCD lines / mura stand out.
    case "gray":   return mn > 60 && mx < 200 && mx - mn < 50;
    case "red":    return r > g + 35 && r > b + 35;
    case "green":  return (g > r + 30 && g > b + 30) || (!!white && greenAgainstWhite(st, white));
    case "blue":   return b > r + 30 && b > g + 30;
    case "black":  return mx < 95 || (!!white && blackAgainstWhite(st, white));
    case "stripes": return sd > STRIPES_MIN_SD; // alternating bands = high in-region contrast
    default: return true;
  }
}

/**
 * The match the sweep uses on one try: the relative rules only when the phone
 * echoed, on THIS try, that it is showing `p`. They are looser than the
 * absolute ones, so they are kept for the moment the right colour is known to
 * be on the screen — never for a stale frame of the previous colour while an
 * echo is late. The absolute rules apply either way, as they always did.
 */
export function matchesOnTry(st: RegionStats, p: string, white: RegionStats | null | undefined, echoed: boolean): boolean {
  return matchesPattern(st, p, echoed ? white : null);
}

/**
 * Black, judged against the locked white frame: dark compared with what this
 * camera saw of this screen's white (at most BLACK_REL of its luminance),
 * neutral (spread under BLACK_MAX_SPREAD) and flat (not stripes). Glare on the
 * glass lifts all three channels of a black screen well above the absolute 95,
 * but it stays well under half of its own white.
 */
export function blackAgainstWhite(st: RegionStats, white: RegionStats): boolean {
  const lw = luminance(white);
  if (!(lw > 0)) return false;
  const spread = Math.max(st.r, st.g, st.b) - Math.min(st.r, st.g, st.b);
  return luminance(st) <= BLACK_REL * lw && spread < BLACK_MAX_SPREAD && !(st.sd > STRIPES_MIN_SD);
}

/**
 * Green, judged against the locked white frame: each channel is scaled by what
 * the same channel read on white (the camera's white balance and the panel's
 * own tint cancel out), then green must lead clearly — and by a real margin in
 * raw values, so a dark, noisy frame cannot pass on ratios alone. The frame
 * must also be brighter than the black cut-off and keep at least
 * GREEN_MIN_REL_G of white's green: a dark green-tinted frame (the bezel, a
 * green mat) is black, never green.
 */
export function greenAgainstWhite(st: RegionStats, white: RegionStats): boolean {
  const lw = luminance(white);
  if (!(lw > 0) || !(luminance(st) > BLACK_REL * lw)) return false;
  const rN = st.r / Math.max(1, white.r);
  const gN = st.g / Math.max(1, white.g);
  const bN = st.b / Math.max(1, white.b);
  return (
    gN >= GREEN_MIN_REL_G &&
    gN >= GREEN_REL * Math.max(rN, bN) &&
    st.g - Math.max(st.r, st.b) >= GREEN_MIN_LEAD
  );
}

/**
 * What the camera says on a retry. Black is the colour glare defeats, and
 * holding steady does not change a reflection — tilting the phone does.
 */
export function retryHint(p: string): string {
  return p === "black" ? "Tilt the phone away from the light — trying black again" : `Trying ${p} again — hold steady`;
}

/** What the camera last saw of a colour it never matched. */
export type SweepMiss = { pattern: string; attempts: number; echoed: boolean; seen: RegionStats | null };
/** The numbers the sweep's cut-offs are tuned on: the locked white, and each miss. */
export type SweepStats = { white: RegionStats | null; misses: SweepMiss[] };

function cleanStats(raw: unknown): RegionStats | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const k of ["r", "g", "b", "sd"]) {
    const v = o[k];
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    out[k] = Math.min(255, Math.max(0, Math.round(v)));
  }
  return out as RegionStats;
}

/**
 * The sweep's calibration numbers as the /display route stores them: only
 * rounded, clamped numbers, a short pattern name, the tries and the echo — at
 * most 8 misses. Anything else in the body is dropped. Undefined when there is
 * nothing usable, so a sweep without them stores nothing.
 */
export function cleanSweepStats(raw: unknown): SweepStats | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const white = cleanStats(o.white);
  const misses: SweepMiss[] = (Array.isArray(o.misses) ? o.misses : [])
    .filter((m): m is Record<string, unknown> => !!m && typeof m === "object" && !Array.isArray(m))
    .slice(0, 8)
    .map((m) => ({
      pattern: String(m.pattern ?? "").slice(0, 12),
      attempts:
        typeof m.attempts === "number" && Number.isFinite(m.attempts) ? Math.min(10, Math.max(0, Math.round(m.attempts))) : 0,
      echoed: m.echoed === true,
      seen: cleanStats(m.seen),
    }));
  if (!white && !misses.length) return undefined;
  return { white, misses };
}

/**
 * The retry budget left for the colour about to start: what remains of
 * SWEEP_RETRY_BUDGET_MS since the lock, less one full try for every colour
 * still to come after it.
 *
 * Every colour always gets its first try, so retries taken early must not
 * push the colours behind them past the budget. Setting their first tries
 * aside keeps the whole sweep within the budget plus one try — about 68 s
 * after the lock — however many colours are missed. A sweep whose colours
 * show quickly leaves plenty for every retry it needs.
 */
export function retryBudgetLeftMs(
  elapsedMs: number,
  coloursAfter: number,
  tryMs = SWEEP_TRY_MS,
  budgetMs = SWEEP_RETRY_BUDGET_MS
): number {
  return budgetMs - elapsedMs - Math.max(0, coloursAfter) * tryMs;
}

export type SweepTiming = { echoMs: number; tryMs: number; budgetMs: number };

/**
 * The sweep's echo wait, try length and retry budget for this journey.
 *
 * The default journey (gradeAtEnd) sets cosmeticDone only AFTER the sweep, so
 * the phone keeps showing colours for as long as the sweep takes: the full
 * budget and the 4 s echo wait. With gradeAtEnd switched off, /cosmetic sets
 * cosmeticDone BEFORE the sweep (`cosmeticDoneAtMs`, on the same clock as
 * `lockAtMs`), and the phone leaves its pattern screen
 * PHONE_GRACE_AFTER_COSMETIC_MS after it sees it. There every first try keeps
 * 6aa0726's timing (a 2.6 s echo wait) and a retry is taken only if it ends
 * before that grace, less PHONE_GRACE_MARGIN_MS — so no sweep that finished in
 * time before the retries existed runs out of the phone's patterns now.
 */
export function sweepTiming(lockAtMs: number, cosmeticDoneAtMs: number | null): SweepTiming {
  if (cosmeticDoneAtMs == null) return { echoMs: SWEEP_ECHO_MS, tryMs: SWEEP_TRY_MS, budgetMs: SWEEP_RETRY_BUDGET_MS };
  const echoMs = SWEEP_ECHO_MS_BEFORE;
  const tryMs = echoMs + SWEEP_MATCH_MS;
  const deadline = cosmeticDoneAtMs + PHONE_GRACE_AFTER_COSMETIC_MS - PHONE_GRACE_MARGIN_MS;
  // A retry starts only while the budget lasts and is never cut short, so one
  // whole try is kept back: a retry that starts in time also ends in time.
  return { echoMs, tryMs, budgetMs: Math.min(SWEEP_RETRY_BUDGET_MS, deadline - lockAtMs - tryMs) };
}

export type SweepColourIo = {
  /** Ask the phone to show the colour. Sent on EVERY try, which also repairs a lost request. */
  post: () => Promise<void>;
  /** Wait up to `ms` for the phone to say it is showing the colour; true if it did. */
  waitEcho: (ms: number) => Promise<boolean>;
  /**
   * Look for up to `ms`; true once a frame showing the colour was captured.
   * `echoed` says whether the phone echoed the colour on this try — the camera
   * uses the relative rules only then (`matchesOnTry`).
   */
  look: (ms: number, echoed: boolean) => Promise<boolean>;
  /** The clock, in ms (performance.now in the camera, a fake one in tests). */
  now: () => number;
  /** Extra tries after the first (default SWEEP_RETRIES). */
  retries?: number;
  /** What is left of the sweep's retry budget when this colour starts, in ms. */
  budgetLeftMs: number;
  /** Called before each retry with its try number (2, 3…) — the camera updates its hint. */
  onRetry?: (attempt: number) => void;
  echoMs?: number;
  matchMs?: number;
};

export type SweepColourResult = {
  captured: boolean;
  /** Tries made, 1…1 + retries. */
  attempts: number;
  /** Did the phone echo the colour on any try? */
  echoed: boolean;
};

/**
 * One colour of the sweep: post it, wait for the echo, look — and if it was
 * not seen, try again on the same lock, up to `retries` more times, while the
 * sweep's retry budget lasts. A phone that never echoes still gets looked at
 * on every try (the echo can be lost while the screen is right).
 */
export async function sweepColour(io: SweepColourIo): Promise<SweepColourResult> {
  const retries = Math.max(0, io.retries ?? SWEEP_RETRIES);
  const echoMs = io.echoMs ?? SWEEP_ECHO_MS;
  const matchMs = io.matchMs ?? SWEEP_MATCH_MS;
  const t0 = io.now();
  let echoed = false;
  for (let attempt = 1; attempt <= 1 + retries; attempt++) {
    if (attempt > 1) {
      // A retry starts only while the budget lasts; the try in progress is
      // never cut short.
      if (io.now() - t0 >= io.budgetLeftMs) return { captured: false, attempts: attempt - 1, echoed };
      io.onRetry?.(attempt);
    }
    await io.post();
    const echoedNow = await io.waitEcho(echoMs);
    if (echoedNow) echoed = true;
    if (await io.look(matchMs, echoedNow)) return { captured: true, attempts: attempt, echoed };
  }
  return { captured: false, attempts: 1 + retries, echoed };
}

/** After the hold, how long the camera is given to settle before white is measured again. */
export const EXPOSURE_SETTLE_MS = 400;
/** The most the locked white's luminance may move under the hold before it is given back. */
export const EXPOSURE_MAX_SHIFT = 0.25;

/**
 * Did holding the exposure keep the white the sweep locked on?
 *
 * A held exposure is only worth having if the camera still sees the white the
 * relative rules are judged against. Some drivers do not keep it: Chrome on
 * Android turns auto-exposure off and carries over the last exposure time, but
 * the ISO can fall back to the camera's default — a jump of several stops the
 * moment the hold applies. `after` is the same box measured once the hold has
 * settled; it must still read as white and stay within EXPOSURE_MAX_SHIFT of
 * `before`.
 */
export function exposureHoldKept(before: RegionStats | null, after: RegionStats | null): boolean {
  if (!before || !after) return false;
  const lb = luminance(before);
  if (!(lb > 0)) return false;
  return matchesPattern(after, "white") && Math.abs(luminance(after) - lb) / lb <= EXPOSURE_MAX_SHIFT;
}

type Range = { min?: number; max?: number };

/**
 * The constraint that holds the exposure: manual, with the exposure time and
 * ISO the camera reports in force at the lock — where it reports them and they
 * are within its range. A manual mode with no values leaves the driver to pick
 * them, which is how the ISO falls back to its default.
 */
export function heldExposureConstraints(
  caps: { exposureTime?: Range; iso?: Range },
  settings: { exposureTime?: unknown; iso?: unknown }
): { exposureMode: "manual"; exposureTime?: number; iso?: number } {
  const out: { exposureMode: "manual"; exposureTime?: number; iso?: number } = { exposureMode: "manual" };
  const ok = (v: unknown, r?: Range): v is number =>
    typeof v === "number" &&
    Number.isFinite(v) &&
    v > 0 &&
    (typeof r?.min !== "number" || v >= r.min) &&
    (typeof r?.max !== "number" || v <= r.max);
  if (ok(settings.exposureTime, caps.exposureTime)) out.exposureTime = settings.exposureTime;
  if (ok(settings.iso, caps.iso)) out.iso = settings.iso;
  return out;
}

/**
 * Run the colours with the camera's exposure held, and always give it back —
 * even if the sweep throws. `hold` resolves true only when it actually held
 * the exposure; only then is `release` called.
 *
 * `verify`, when given, runs right after a hold: false (or a throw) means the
 * hold moved the white the sweep locked on (`exposureHoldKept`), so the
 * exposure is given back BEFORE the colours, which then run on auto — as they
 * did before the hold existed.
 */
export async function withHeldExposure<T>(
  hold: () => Promise<boolean>,
  release: () => Promise<void>,
  run: () => Promise<T>,
  verify?: () => Promise<boolean>
): Promise<T> {
  let held = await hold().catch(() => false);
  if (held && verify && !(await verify().catch(() => false))) {
    await release().catch(() => {});
    held = false;
  }
  try {
    return await run();
  } finally {
    if (held) await release().catch(() => {});
  }
}
