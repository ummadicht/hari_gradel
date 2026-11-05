import { getSetting, setSetting } from "./settings";
import { CLIENT_IDS, isClientId, type ClientId } from "./clients";
import {
  ALL_DISPLAY_PATTERNS,
  DEFAULT_CHANNELS,
  MIN_ENABLED_STEPS,
  defaultChannelConfig,
  DEFAULT_CAPTURE_STEPS,
  DEFAULT_STATIONS,
  REQUIRED_STATIONS,
  type CaptureStep,
  type ChannelConfig,
  type ClientJourney,
  type JourneyStation,
  type JourneyStationId,
} from "./journeyTypes";

// Server-only half: reads/writes the settings DB. Pure types + defaults live in
// journeyTypes.ts so client components can import them without dragging sqlite
// into the browser bundle.
export {
  DEFAULT_CHANNELS,
  MIN_ENABLED_STEPS,
  DEFAULT_CAPTURE_STEPS,
  defaultChannelConfig,
  type CaptureStep,
  type ChannelConfig,
  type ClientJourney,
};

/**
 * Per-client, per-channel JOURNEY configuration — GradeIQ's answer to Pandas
 * Studio. A client admin (or the super admin) edits, per channel:
 *
 *   • CAPTURE STEPS — which angles the camera walks through, their labels and
 *     order (toggle Top edge off, rename "Back" → "Rear glass", …)
 *   • PHASE BLOCKS  — which parts of the v2 flow run at all (battery screenshot,
 *     functional mini-games, torch pass, display sweep, Settings OCR)
 *   • COPY          — the intro title/tagline the seller sees
 *
 * The v2 flow and the second-device camera READ this at runtime, so an edit here
 * changes the live journey without a deploy — same engine, per-tenant shape.
 *
 * What is deliberately NOT configurable: the capture gate's thresholds, the
 * grading math, and the offer engine's hard stops. Those are the RULES, and a
 * tenant may not soften them; this file only shapes the experience around them.
 */

const KEY = (client: ClientId) => `journey:${client}`;

/** Read a client's stored journey, merged over defaults so new fields appear. */
export function journeyFor(clientId: string): ClientJourney {
  const id: ClientId = isClientId(clientId) ? clientId : "default";
  let stored: Partial<ClientJourney> = {};
  try {
    const raw = getSetting(KEY(id));
    if (raw) stored = JSON.parse(raw);
  } catch {
    /* corrupt config must never break the flow — fall back to defaults */
  }
  const channels: Record<string, ChannelConfig> = {};
  const names = new Set<string>([...DEFAULT_CHANNELS, ...Object.keys(stored.channels ?? {})]);
  for (const ch of names) {
    channels[ch] = mergeChannel(stored.channels?.[ch]);
  }
  return { channels };
}

/** One channel's effective config (unknown channel → consumer). */
export function channelConfig(clientId: string, channel: string): ChannelConfig {
  const j = journeyFor(clientId);
  return j.channels[channel] ?? j.channels.consumer ?? defaultChannelConfig();
}

/**
 * Persist a client's journey. Validates the shape defensively and re-enforces
 * MIN_ENABLED_STEPS so a malformed or hostile POST can't brick the tenant.
 */
export function saveJourney(clientId: ClientId, input: unknown): ClientJourney {
  const raw = (input ?? {}) as Partial<ClientJourney>;
  const channels: Record<string, ChannelConfig> = {};
  const names = new Set<string>([...DEFAULT_CHANNELS, ...Object.keys(raw.channels ?? {})]);
  for (const ch of names) {
    const clean = mergeChannel(raw.channels?.[ch]);
    // A channel below the gate's minimum re-enables steps from the top until
    // it's viable again — silently bricking a tenant is worse than overriding
    // an over-aggressive edit.
    let enabled = clean.captureSteps.filter((s) => s.enabled).length;
    for (const s of clean.captureSteps) {
      if (enabled >= MIN_ENABLED_STEPS) break;
      if (!s.enabled) {
        s.enabled = true;
        enabled++;
      }
    }
    channels[ch] = clean;
  }
  const journey: ClientJourney = { channels };
  setSetting(KEY(clientId), JSON.stringify(journey));
  return journey;
}

function mergeChannel(c?: Partial<ChannelConfig>): ChannelConfig {
  const d = defaultChannelConfig();
  if (!c) return d;
  // Steps: honour stored order/labels/toggles for KNOWN ids; append any default
  // step the stored list is missing (i.e. steps added after the config saved).
  const byId = new Map(d.captureSteps.map((s) => [s.id, s]));
  const steps: CaptureStep[] = [];
  for (const s of Array.isArray(c.captureSteps) ? c.captureSteps : []) {
    const base = byId.get(String((s as any)?.id));
    if (!base) continue; // unknown step id — not a real angle, drop it
    byId.delete(base.id);
    steps.push({
      id: base.id,
      label: String((s as any).label || base.label).slice(0, 40),
      how: String((s as any).how || base.how).slice(0, 60),
      enabled: (s as any).enabled !== false,
    });
  }
  steps.push(...byId.values());

  // Stations (employee journey): honour stored labels/blurbs/toggles for known
  // ids, append any missing; then re-enable the structural frame (identify /
  // review / complete) so a saved config can never produce a journey with no
  // start, no offer or no finish.
  const stByDef = new Map(DEFAULT_STATIONS.map((s) => [s.id, s]));
  const stations: JourneyStation[] = [];
  for (const st of Array.isArray(c.stations) ? c.stations : []) {
    const base = stByDef.get(String((st as any)?.id) as JourneyStationId);
    if (!base) continue;
    stByDef.delete(base.id);
    stations.push({
      id: base.id,
      label: String((st as any).label || base.label).slice(0, 40),
      blurb: String((st as any).blurb || base.blurb).slice(0, 120),
      enabled: (st as any).enabled !== false,
    });
  }
  stations.push(...stByDef.values());
  for (const st of stations) if (REQUIRED_STATIONS.includes(st.id)) st.enabled = true;
  // Keep the canonical station order regardless of how they were stored.
  stations.sort((a, b) => DEFAULT_STATIONS.findIndex((d) => d.id === a.id) - DEFAULT_STATIONS.findIndex((d) => d.id === b.id));

  // Patterns: keep only ones the sweep can actually drive, in the stored order;
  // an empty list would silently disable the sweep while the toggle still said
  // "on", so it falls back to the defaults.
  const patterns = (Array.isArray(c.displayPatterns) ? c.displayPatterns : [])
    .map((p) => String(p).toLowerCase().trim())
    .filter((p, i, a) => (ALL_DISPLAY_PATTERNS as readonly string[]).includes(p) && a.indexOf(p) === i);

  return {
    captureSteps: steps,
    stations,
    displayPatterns: patterns.length ? patterns : d.displayPatterns,
    // Only an explicit "film" opts back into the timed capture. Anything else —
    // absent, misspelt, or written by an older build — resolves to "photo", so
    // every config saved before this field existed switches over without a
    // migration and no tenant is left on the timer by accident.
    settingsCapture: c.settingsCapture === "film" ? "film" : "photo",
    phases: {
      battery: c.phases?.battery !== false,
      functional: c.phases?.functional !== false,
      torchPass: c.phases?.torchPass !== false,
      displaySweep: c.phases?.displaySweep !== false,
      settingsOcr: c.phases?.settingsOcr !== false,
      gradeAtEnd: c.phases?.gradeAtEnd !== false,
    },
    copy: {
      introTitle: String(c.copy?.introTitle || "").slice(0, 80),
      tagline: String(c.copy?.tagline || "").slice(0, 120),
    },
  };
}

/**
 * The ENABLED stations for a client's journey channel, in canonical order —
 * what the employee-journey runner actually walks through. Config-driven: an
 * edit in the portal reshapes the live journey with no deploy.
 */
export function stationsFor(clientId: string, channel: string): JourneyStation[] {
  return channelConfig(clientId, channel).stations.filter((s) => s.enabled);
}

/** Every client's journey — for the super-admin overview. */
export function allJourneys(): Record<ClientId, ClientJourney> {
  const out = {} as Record<ClientId, ClientJourney>;
  for (const id of CLIENT_IDS) out[id] = journeyFor(id);
  return out;
}
