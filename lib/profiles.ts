// The configuration engine. A grading session is shaped by a PROFILE =
// segment (who/where) × demographic (who's tapping) × coverage × game mode.
// Everything downstream (which tests, skips allowed, target sizes, branding,
// data-wipe gating) is derived from here so GradeIQ scales C2B → enterprise
// without forking the UI.

import { FUNCTIONAL_TESTS } from "./tests";

export type Segment =
  | "retail"
  | "scout"
  | "wholesale"
  | "c2b"
  | "enterprise";

export type Demographic = "standard" | "kids" | "senior" | "techie";
export type Coverage = "strict" | "standard"; // strict = 100%, no skips
export type GameMode = "gauntlet" | "blitz";

export type Tuning = {
  targetScale: number; // multiplies game target sizes (senior = bigger)
  playful: boolean; // celebratory badges / confetti framing
  showDiagnostics: boolean; // techie: expose raw sensor values
  language: "simple" | "standard";
};

export type Profile = {
  id: string;
  segment: Segment;
  demographic: Demographic;
  label: string;
  blurb: string;
  emoji: string;
  tests: string[]; // subset of FUNCTIONAL_TESTS ids, in play order
  coverage: Coverage;
  mode: GameMode;
  selfServe: boolean; // kiosk/self vs staff-assisted
  requireWipe: boolean; // gate on a wiped/unlocked device before accepting
  timeLimitSec: number; // used by blitz
  photoTarget: number; // baseline cosmetic photos to capture (AI can ask for more)
  tuning: Tuning;
};

const ALL = FUNCTIONAL_TESTS.map((t) => t.id);
const CRITICAL = FUNCTIONAL_TESTS.filter((t) => t.critical).map((t) => t.id);

export const DEMOGRAPHICS: Record<Demographic, Tuning & { label: string }> = {
  standard: {
    label: "Standard",
    targetScale: 1,
    playful: true,
    showDiagnostics: false,
    language: "standard",
  },
  kids: {
    label: "Kids / Scout",
    targetScale: 1.15,
    playful: true,
    showDiagnostics: false,
    language: "simple",
  },
  senior: {
    label: "Senior / accessible",
    targetScale: 1.45,
    playful: false,
    showDiagnostics: false,
    language: "simple",
  },
  techie: {
    label: "Technician",
    targetScale: 1,
    playful: false,
    showDiagnostics: true,
    language: "standard",
  },
};

// Segment defaults. `mode`, `coverage`, `tests` etc. can be overridden per
// session, but these are the sensible starting points for each channel.
const SEGMENTS: Record<
  Segment,
  Omit<Profile, "id" | "demographic" | "tuning">
> = {
  retail: {
    segment: "retail",
    label: "Retail store (iPad)",
    blurb: "In-store trade-in on a counter iPad. Full check, self-serve.",
    emoji: "🏪",
    tests: ALL,
    coverage: "strict",
    mode: "gauntlet",
    selfServe: true,
    requireWipe: false,
    timeLimitSec: 90,
    photoTarget: 4,
  },
  scout: {
    segment: "scout",
    label: "Scout / field collector",
    blurb: "Buyer in the field grading fast on their own phone.",
    emoji: "🧭",
    tests: [...CRITICAL, "multitouch", "motion"],
    coverage: "standard",
    mode: "blitz",
    selfServe: false,
    requireWipe: false,
    timeLimitSec: 75,
    photoTarget: 4,
  },
  wholesale: {
    segment: "wholesale",
    label: "Wholesale lot",
    blurb: "High-throughput bulk grading — criticals only, speed first.",
    emoji: "📦",
    tests: CRITICAL,
    coverage: "standard",
    mode: "blitz",
    selfServe: false,
    requireWipe: false,
    timeLimitSec: 60,
    photoTarget: 3,
  },
  c2b: {
    segment: "c2b",
    label: "Consumer trade-in",
    blurb: "Customer self-tests at home or kiosk before selling to you.",
    emoji: "🙋",
    tests: ALL,
    coverage: "strict",
    mode: "gauntlet",
    selfServe: true,
    requireWipe: true,
    timeLimitSec: 90,
    photoTarget: 4,
  },
  enterprise: {
    segment: "enterprise",
    label: "Enterprise drop-box",
    blurb: "Unattended kiosk (Target/Amazon-box style). Wipe-gated, self-serve.",
    emoji: "🏢",
    tests: ALL,
    coverage: "strict",
    mode: "gauntlet",
    selfServe: true,
    requireWipe: true,
    timeLimitSec: 90,
    photoTarget: 4,
  },
};

export const SEGMENT_LIST = Object.values(SEGMENTS);

export function buildProfile(
  segment: Segment,
  demographic: Demographic,
  overrides: Partial<Profile> = {}
): Profile {
  const base = SEGMENTS[segment];
  const dem = DEMOGRAPHICS[demographic];
  return {
    id: `${segment}:${demographic}`,
    demographic,
    tuning: {
      targetScale: dem.targetScale,
      playful: dem.playful,
      showDiagnostics: dem.showDiagnostics,
      language: dem.language,
    },
    ...base,
    ...overrides,
  };
}

export const DEFAULT_PROFILE = buildProfile("retail", "standard");

// Sessions persist the profile as JSON; hydrate defensively.
export function parseProfile(json: string): Profile {
  try {
    const p = JSON.parse(json);
    if (p && p.segment && p.tests) return p as Profile;
  } catch {
    /* fall through */
  }
  return DEFAULT_PROFILE;
}
