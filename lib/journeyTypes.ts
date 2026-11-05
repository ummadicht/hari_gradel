/**
 * Journey config TYPES + DEFAULTS — pure, dependency-free, importable from
 * CLIENT components (V2Cam, V2Flow, the portal UI).
 *
 * The server-only half (read/write against the settings DB) lives in
 * lib/journeyConfig.ts. Client code must import from THIS file — importing
 * journeyConfig from a "use client" component drags better-sqlite3 into the
 * browser bundle and breaks the build.
 */

export type CaptureStep = {
  id: string;
  label: string;
  how: string;
  enabled: boolean;
};

// The employee-journey STATIONS (Pandas' /j/<journey>/s/<session> stops). Editable
// per client×channel in the portal like capture steps. identify / review /
// complete are the structural frame and can't be turned off (the runner and the
// offer need them); diagnostics and cosmetics are the operator's choice — a
// tenant might grade photos-only or run tests-only.
export type JourneyStationId = "identify" | "diagnostics" | "cosmetics" | "review" | "complete";
export const REQUIRED_STATIONS: JourneyStationId[] = ["identify", "review", "complete"];

export type JourneyStation = {
  id: JourneyStationId;
  label: string;
  blurb: string;
  enabled: boolean;
};

export const DEFAULT_STATIONS: JourneyStation[] = [
  { id: "identify", label: "Identify", blurb: "Scan the IMEI and confirm the device.", enabled: true },
  { id: "diagnostics", label: "Diagnostics", blurb: "Run the on-device functional tests.", enabled: true },
  { id: "cosmetics", label: "Photos & grade", blurb: "Capture every side; grade the condition.", enabled: true },
  { id: "review", label: "Review & offer", blurb: "Confirm the grade and the trade-in price.", enabled: true },
  { id: "complete", label: "Complete", blurb: "Record the trade-in and hand back the device.", enabled: true },
];

export type ChannelConfig = {
  captureSteps: CaptureStep[];
  /** Employee-journey stations for this channel (see DEFAULT_STATIONS). */
  stations: JourneyStation[];
  /**
   * Which screen test patterns the display sweep drives, in order.
   *
   * Was a hardcoded six in V2Cam, so a tenant could turn the whole sweep off but
   * not shorten it — and in practice only the patterns the camera could VERIFY
   * got captured, which on glary runs meant two of six and a display verdict of
   * "unknown". Making the list configurable lets a channel run a short, reliable
   * sweep (white + black catches most dead pixels and backlight bleed) instead
   * of a long one that half-fails.
   */
  displayPatterns: string[];
  /**
   * HOW the Settings screens are captured: by the seller taking photos, or by
   * filming for a fixed window.
   *
   * "film" grabs four frames on a timer while the seller holds the camera on
   * the other phone. It has two problems in the field. The timer decides when
   * to capture, so a frame lands whenever the window elapses — often before the
   * right screen is even open — and the seller has no way to say "this is the
   * one". And it made the step feel broken: the buttons only ended the loop,
   * so nothing visibly happened when they were pressed.
   *
   * "photo" hands that control back: the seller frames the About screen, taps
   * the shutter, does the same for Battery Health, and submits. Fewer, better
   * frames of the screens that actually matter.
   *
   * DEFAULT IS "photo", and absence means "photo" — so every stored config
   * written before this existed switches over with no migration. A tenant that
   * genuinely wants the old behaviour has to ask for it.
   */
  settingsCapture?: "photo" | "film";
  phases: {
    battery: boolean;
    functional: boolean;
    torchPass: boolean;
    displaySweep: boolean;
    settingsOcr: boolean;
    /**
     * Collect EVERYTHING before grading anything.
     *
     * The original order submitted the cosmetic photos the moment the rotation
     * finished — which graded the device, set cosmeticDone and released the
     * primary — and only then ran the display sweep and the Settings scan. So
     * the stored grade was computed from photos alone, and the LCD and battery
     * evidence arrived after the number had already been produced.
     *
     * With this on, the photo set is only VALIDATED at that point (the capture
     * gate still runs, so an unusable set is still rejected immediately and the
     * seller is not made to complete a whole sweep before finding out). The
     * grade is computed once, at the end, with the display and Settings
     * evidence already on the record.
     */
    gradeAtEnd: boolean;
  };
  copy: {
    introTitle: string;
    tagline: string;
  };
};

export type ClientJourney = {
  channels: Record<string, ChannelConfig>;
};

/** The channels every client starts with. More can be added per client later. */
// "retail" = the partner-vendor collection desk (/channel/retail) — store staff
// buying phones from walk-in customers, distinct from the client's own "store".
export const DEFAULT_CHANNELS = ["consumer", "store", "employee", "retail"] as const;

/**
 * The canonical six angles. V2Cam and the portal editor both import THIS list,
 * so the camera and the config screen can never drift apart.
 */
export const DEFAULT_CAPTURE_STEPS: CaptureStep[] = [
  { id: "front", label: "Front glass", how: "Screen toward you", enabled: true },
  { id: "back", label: "Back", how: "Rear glass & cameras", enabled: true },
  { id: "left", label: "Left side", how: "Left edge & buttons", enabled: true },
  { id: "right", label: "Right side", how: "Right edge", enabled: true },
  { id: "top", label: "Top edge", how: "Top edge", enabled: true },
  { id: "bottom", label: "Bottom / ports", how: "Port, speaker & mic", enabled: true },
];

/**
 * The capture gate needs at least 4 distinct views to accept a set, so a
 * channel can never be configured below that — otherwise every capture from
 * that tenant would be auto-rejected and the flow would soft-brick.
 */
export const MIN_ENABLED_STEPS = 4;

/**
 * Every pattern the sweep knows how to drive and verify.
 *
 * GREY IS RETIRED, and removing it from THIS list is what actually retires it:
 * `mergeChannel` filters each tenant's stored pattern list against this one, so
 * dropping it here strips it from configs that were saved with it (swapmore and
 * denovo both were) instead of only changing what new configs default to.
 *
 * Why it went: in theory a flat 50% field is the best reveal for driver-IC
 * lines and gray-scale mura. In the field it was the worst pattern we shipped —
 * a grey panel is the hardest thing for the camera to tell apart from skin and
 * a pale wall, so verification struggled and the grader kept marking the hand
 * holding the phone as a display defect. White and black cover dead pixels and
 * backlight bleed without that failure mode.
 *
 * To bring it back: re-add "gray" here. Nothing else needs to change.
 */
export const ALL_DISPLAY_PATTERNS = ["white", "red", "green", "blue", "black", "stripes"] as const;
export const DEFAULT_DISPLAY_PATTERNS: string[] = ["white", "black", "stripes", "red", "green", "blue"];

export function defaultChannelConfig(): ChannelConfig {
  return {
    captureSteps: DEFAULT_CAPTURE_STEPS.map((s) => ({ ...s })),
    stations: DEFAULT_STATIONS.map((s) => ({ ...s })),
    displayPatterns: [...DEFAULT_DISPLAY_PATTERNS],
    settingsCapture: "photo",
    phases: {
      battery: true,
      functional: true,
      torchPass: true,
      displaySweep: true,
      settingsOcr: true,
      gradeAtEnd: true,
    },
    copy: { introTitle: "", tagline: "" }, // empty = use the client theme's own
  };
}
