// The canonical functional-test catalog. Both the gamified gauntlet UI and the
// grading engine import from here so they never drift apart.

export type Platform = "all" | "android" | "ios";

export type FunctionalTest = {
  id: string;
  name: string;
  // The gamified framing shown to the tester.
  game: string;
  emoji: string;
  // Which Web API backs it (documented for honesty about coverage).
  api: string;
  // Hardware buttons / NFC etc. have no reliable web API — tester confirms.
  mode: "auto" | "confirm";
  // A failing critical test means the device is graded "Faulty" regardless of
  // how many other tests pass.
  critical: boolean;
  platform: Platform;
};

export const FUNCTIONAL_TESTS: FunctionalTest[] = [
  {
    id: "touch",
    name: "Touchscreen",
    game: "Clear every square",
    emoji: "▦",
    api: "Pointer Events",
    mode: "auto",
    critical: true,
    platform: "all",
  },
  {
    id: "multitouch",
    name: "Multi-touch",
    game: "Pinch the star",
    emoji: "⭐",
    api: "Touch Events",
    mode: "auto",
    critical: false,
    platform: "all",
  },
  {
    id: "display",
    name: "Display / dead pixels",
    game: "Spot the defect",
    emoji: "🎨",
    api: "Fullscreen color fills",
    mode: "confirm",
    critical: true,
    platform: "all",
  },
  {
    id: "motion",
    name: "Gyroscope / accelerometer",
    game: "Roll the ball home",
    emoji: "🎯",
    api: "DeviceOrientation",
    mode: "auto",
    critical: false,
    platform: "all",
  },
  {
    id: "mic",
    name: "Microphone",
    game: "Blow out the candles",
    emoji: "🕯️",
    api: "getUserMedia (audio)",
    mode: "auto",
    critical: true,
    platform: "all",
  },
  {
    id: "speaker",
    name: "Speaker",
    game: "Name that sound",
    emoji: "🔊",
    api: "Web Audio",
    mode: "confirm",
    critical: true,
    platform: "all",
  },
  {
    id: "voice",
    name: "Voice / microphone",
    game: "Say a phrase aloud",
    emoji: "🗣️",
    api: "getUserMedia (audio)",
    mode: "auto",
    critical: false,
    platform: "all",
  },
  {
    id: "camera",
    name: "Cameras (front + rear)",
    game: "Snap the target",
    emoji: "📸",
    api: "getUserMedia (video)",
    mode: "confirm",
    critical: true,
    platform: "all",
  },
  {
    id: "faceid",
    name: "Face ID",
    game: "Look to unlock",
    emoji: "🙂",
    api: "WebAuthn passkey (platform authenticator)",
    mode: "auto",
    critical: false,
    platform: "ios", // Face ID is iPhone-only — hidden on Android / Touch ID
  },
  {
    id: "vibration",
    name: "Vibration motor",
    game: "Feel the buzz",
    emoji: "📳",
    api: "Vibration API",
    mode: "confirm",
    critical: false,
    platform: "android",
  },
  {
    id: "buttons",
    name: "Hardware buttons",
    game: "Button combo",
    emoji: "🔘",
    api: "Manual (no web API)",
    mode: "confirm",
    critical: false,
    platform: "all",
  },
];

export function testById(id: string): FunctionalTest | undefined {
  return FUNCTIONAL_TESTS.find((t) => t.id === id);
}
