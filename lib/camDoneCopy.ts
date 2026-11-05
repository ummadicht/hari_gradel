/**
 * The words on the camera page's done screen (app/components/V2Cam.tsx, the
 * full pass) — SUP-265.
 *
 * GradeIQ's own two-phone wording sends the person back to "the first phone".
 * At a SwapUp counter that is the customer's phone, while the advisor's next
 * step is the trade-in in SwapUp Store — so a SwapUp session says that
 * instead. Which sessions are SwapUp's is recorded at create time as
 * `profile.app = "swapup"`, and only a create carrying GradeIQ's server key can
 * set it (app/api/sessions/route.ts). Every other session keeps today's words
 * exactly.
 *
 * A SwapUp session also says how the screen sweep went. This is the one screen
 * the advisor sees while still holding the phone, so a green ✓ must never
 * stand over a sweep that saw fewer colours than it asked for: SwapUp's report
 * then marks the screen as not (fully) camera-checked and asks the advisor to
 * look at it, and this screen says so first, in amber.
 */
export type CamDoneCopy = { title: string; body: string; tone: "ok" | "warn" };

export const CAM_DONE_DEFAULT: CamDoneCopy = {
  title: "Captures sent",
  body: "You can close this tab and return to the first phone to finish.",
  tone: "ok",
};

export const CAM_DONE_SWAPUP: CamDoneCopy = {
  title: "Done — back to SwapUp Store",
  body: "You can close this tab.",
  tone: "ok",
};

/** The sweep confirmed none of its colours (never locked on, or the phone never echoed). */
export const CAM_DONE_SWAPUP_UNSEEN: CamDoneCopy = {
  title: "Done — back to SwapUp Store",
  body: "The camera couldn't see the screen colours, so the report will ask you to look at the screen.",
  tone: "warn",
};

/** The sweep confirmed some of its colours, not all. */
export const CAM_DONE_SWAPUP_PARTIAL: CamDoneCopy = {
  title: "Done — back to SwapUp Store",
  body: "The camera couldn't confirm every screen colour, so the report will ask you to look at the screen.",
  tone: "warn",
};

/** How the screen sweep went: colours verified (null = no sweep ran) out of those asked for. */
export type SweepOutcome = { seen: number | null; requested: number };

/**
 * `app` is the session's `profile.app`, as read by the camera page (or
 * nothing); `sweep` is what this visit's screen sweep verified, if one ran.
 */
export function camDoneCopy(app: unknown, sweep?: SweepOutcome | null): CamDoneCopy {
  if (app !== "swapup") return CAM_DONE_DEFAULT;
  if (!sweep || sweep.seen == null || !(sweep.requested > 0) || sweep.seen >= sweep.requested) return CAM_DONE_SWAPUP;
  return sweep.seen <= 0 ? CAM_DONE_SWAPUP_UNSEEN : CAM_DONE_SWAPUP_PARTIAL;
}
