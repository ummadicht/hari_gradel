import { db } from "./db";

// The device-program config a non-dev edits (via the chat Configurator) instead
// of touching profiles.ts / offer.ts. Stored as one JSON blob in `settings`,
// merged over the code defaults at runtime.
export type ProgramConfig = {
  pricing: {
    marketBase: Record<string, number>; // model → Grade-A wholesale $
    gradeFactors: Record<string, number>; // grade → resale multiplier
    repairCosts: Record<string, number>; // testId → repair $
    marginRate?: number; // dealer margin (0..1)
    promoBonus?: number; // flat $ added to every (unblocked) offer
  };
  segments: Record<
    string,
    {
      photoTarget?: number;
      mode?: "gauntlet" | "blitz";
      coverage?: "strict" | "standard";
      disabledTests?: string[];
    }
  >;
};

const KEY = "program_config";

export function emptyConfig(): ProgramConfig {
  return {
    pricing: { marketBase: {}, gradeFactors: {}, repairCosts: {} },
    segments: {},
  };
}

export function getProgramConfig(): ProgramConfig {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(KEY) as
    | { value: string }
    | undefined;
  if (!row) return emptyConfig();
  try {
    const c = JSON.parse(row.value);
    return {
      pricing: {
        marketBase: {},
        gradeFactors: {},
        repairCosts: {},
        ...(c.pricing ?? {}),
      },
      segments: c.segments ?? {},
    };
  } catch {
    return emptyConfig();
  }
}

export function saveProgramConfig(c: ProgramConfig) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(KEY, JSON.stringify(c));
}
