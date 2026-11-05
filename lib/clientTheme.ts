import type { CSSProperties } from "react";
import { resolveClient, type ClientId } from "./clients";

/**
 * PER-CLIENT THEME — the white-label layer for the v2 trade-in flow, the same way
 * Pandas themes each customer journey (accent + button colour/radius + copy) from
 * config instead of code. The flow root spreads `themeVars(theme)` and every screen
 * paints from those CSS custom properties, so a new tenant is a data change.
 *
 * `swapmore` renders LIGHT + SwapMore-branded (it's embedded in swapmore.com/buyback);
 * the default GradeIQ client keeps the dark look. Pairs with lib/clients.ts, which
 * already routes pricing per client.
 */

export type ClientTheme = {
  mode: "light" | "dark";
  /** surfaces */
  bg: string;
  bgSoft: string;
  card: string;
  cardAlt: string;
  border: string;
  /** ink */
  text: string;
  muted: string;
  /** brand accent (active states, chips, progress) */
  accent: string;
  accentSoft: string;
  accentInk: string;
  /** primary CTA */
  ctaBg: string;
  ctaText: string;
  ctaRadius: number;
  /** status */
  ok: string;
  warn: string;
  bad: string;
  /** branding + copy */
  brandName: string;
  logoUrl: string;
  tagline: string;
};

const SWAPMORE: ClientTheme = {
  mode: "light",
  bg: "#f5f4f7",
  bgSoft: "#ecebf1",
  card: "#ffffff",
  cardAlt: "#faf9fc",
  border: "rgba(20,16,24,0.10)",
  text: "#141018",
  muted: "rgba(20,16,24,0.58)",
  accent: "#7400d4",
  accentSoft: "rgba(116,0,212,0.10)",
  accentInk: "#7400d4",
  ctaBg: "#7400d4",
  ctaText: "#ffffff",
  ctaRadius: 20,
  ok: "#16a34a",
  warn: "#d97706",
  bad: "#dc2626",
  brandName: "SwapMore",
  logoUrl: "https://swapmore.com/logo.png",
  tagline: "It only takes a couple of minutes.",
};

const GRADEIQ: ClientTheme = {
  mode: "dark",
  bg: "#0b0f14",
  bgSoft: "rgba(255,255,255,0.05)",
  card: "rgba(255,255,255,0.05)",
  cardAlt: "rgba(255,255,255,0.03)",
  border: "rgba(255,255,255,0.12)",
  text: "#ffffff",
  muted: "rgba(255,255,255,0.60)",
  accent: "#12b0a0",
  accentSoft: "rgba(18,176,160,0.16)",
  accentInk: "#12b0a0",
  ctaBg: "#12b0a0",
  ctaText: "#ffffff",
  ctaRadius: 20,
  ok: "#34d399",
  warn: "#fbbf24",
  bad: "#f87171",
  brandName: "GradeIQ",
  logoUrl: "",
  tagline: "It only takes about 90 seconds.",
};

// SwapMore India shares the US brand system for now — its admin can restyle it
// from the super-admin portal (theme overrides live in journeyConfig, layered on
// top of these bases). DeNovo runs the dark GradeIQ base until it gets its own.
// Gadget Rebirth (Inzmam, Mumbai) — light, teal-accented like their vendor
// portal on swapmore.vercel.app. India-exclusive retail client.
const INZMAN: ClientTheme = {
  ...SWAPMORE,
  accent: "#0d9488",
  accentSoft: "rgba(13,148,136,0.10)",
  accentInk: "#0d9488",
  ctaBg: "#0d9488",
  ctaText: "#ffffff",
  brandName: "Gadget Rebirth",
  logoUrl: "",
  tagline: "90-second check — grade it on the spot.",
};

export const THEMES: Record<ClientId, ClientTheme> = {
  swapmore: SWAPMORE,
  "swapmore-in": { ...SWAPMORE, brandName: "SwapMore India" },
  denovo: { ...GRADEIQ, brandName: "DeNovo" },
  inzman: INZMAN,
  default: GRADEIQ,
};

export function themeFor(clientId?: string | null): ClientTheme {
  return THEMES[resolveClient(clientId).id] ?? GRADEIQ;
}

/** Spread on the flow root — every screen paints from these. */
export function themeVars(t: ClientTheme): CSSProperties {
  return {
    "--t-bg": t.bg,
    "--t-bg-soft": t.bgSoft,
    "--t-card": t.card,
    "--t-card-alt": t.cardAlt,
    "--t-border": t.border,
    "--t-text": t.text,
    "--t-muted": t.muted,
    "--t-accent": t.accent,
    "--t-accent-soft": t.accentSoft,
    "--t-accent-ink": t.accentInk,
    "--t-cta-bg": t.ctaBg,
    "--t-cta-text": t.ctaText,
    "--t-cta-radius": `${t.ctaRadius}px`,
    "--t-ok": t.ok,
    "--t-warn": t.warn,
    "--t-bad": t.bad,
    background: t.bg,
    color: t.text,
  } as CSSProperties;
}

/** Shared class strings so every screen composes identically. */
export const TX = {
  eyebrow: "text-[12px] font-bold uppercase tracking-[0.16em]",
  h1: "text-[30px] font-extrabold leading-[1.12] tracking-tight",
  sub: "mt-2 text-[15px] leading-relaxed",
  card: "rounded-2xl border p-4 text-left transition",
  cta: "flex w-full items-center justify-center gap-2 py-4 text-[16px] font-bold disabled:opacity-50",
} as const;
