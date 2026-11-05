"use client";
import { useEffect, useState } from "react";
import { TX } from "@/lib/clientTheme";
import { resolveClient } from "@/lib/clients";

// ── "Welcome back" gate for the v2 flow.
// Sellers get interrupted — a call lands mid-capture, the tab dies, they come
// back an hour later. Pandas answers this with a gate instead of a silent
// restart, and so do we: show what they were doing, offer to resume, and keep
// "Start over" available but quiet.
//
// Progress lives in localStorage keyed PER CLIENT so two tenants sharing a
// browser (staff testing swapmore + gradeiq) never resume each other's session.

const KEY_PREFIX = "gradeiq:v2:";
/** A day-old journey is a different visit — prices and stock move, so restart clean. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type V2Progress = {
  sessionId: string;
  phase: string;
  model?: string;
  at: number;
};

function keyFor(clientId: string): string {
  // Derive the key from the SAME resolver the rest of the app routes tenancy on,
  // so the storage bucket can never disagree with the tenant the session is priced
  // as. V2Flow passes the raw `?client=` param through, so this has to absorb
  // case ("?client=SwapMore"), padding, and unknown ids — all of which
  // resolveClient folds to a real ClientId ("default" when unrecognised).
  return `${KEY_PREFIX}${resolveClient(clientId).id}`;
}

/** Runtime shape check — localStorage is user-writable and survives deploys. */
function isProgress(v: unknown): v is V2Progress {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.sessionId === "string" &&
    r.sessionId.length > 0 &&
    typeof r.phase === "string" &&
    r.phase.length > 0 &&
    typeof r.at === "number" &&
    Number.isFinite(r.at) &&
    (r.model === undefined || typeof r.model === "string")
  );
}

export function saveProgress(clientId: string, p: V2Progress): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(keyFor(clientId), JSON.stringify(p));
  } catch {
    /* Safari private mode throws on setItem, as does a full quota. Resume is a
       nicety — never let it break the flow. */
  }
}

export function clearProgress(clientId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(keyFor(clientId));
  } catch {
    /* see saveProgress */
  }
}

export function loadProgress(clientId: string): V2Progress | null {
  if (typeof window === "undefined") return null;
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(keyFor(clientId));
  } catch {
    return null; // storage unreadable → behave as if there's nothing to resume
  }
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    clearProgress(clientId);
    return null;
  }
  // Corrupt or stale entries are dropped, not just ignored, so the gate can't
  // reappear on the next visit.
  if (!isProgress(parsed)) {
    clearProgress(clientId);
    return null;
  }
  if (Date.now() - parsed.at > MAX_AGE_MS) {
    clearProgress(clientId);
    return null;
  }
  return parsed;
}

// Plain-language names for the v2 phases. Fallback de-slugs anything new so a
// future phase degrades to readable text instead of a raw key.
const PHASE_LABEL: Record<string, string> = {
  intro: "getting started",
  identify: "device details",
  identifying: "device details",
  method: "choosing a scan method",
  await2nd: "linking your second device",
  cosmetic: "cosmetic scan",
  grading: "cosmetic scan",
  battery: "battery health",
  functional: "function tests",
  offer: "your offer",
};
function phaseLabel(phase: string): string {
  return PHASE_LABEL[phase] ?? phase.replace(/[-_]+/g, " ");
}

/** Tiny relative formatter — no date library, and deliberately vague ("about"). */
function relativeTime(at: number, now: number): string {
  const secs = Math.max(0, Math.round((now - at) / 1000));
  if (secs < 45) return "a moment ago";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `about ${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `about ${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `about ${days} day${days === 1 ? "" : "s"} ago`;
}

type Props = {
  progress: V2Progress;
  onResume: () => void;
  onStartOver: () => void;
};

export default function SessionResume({ progress, onResume, onStartOver }: Props) {
  // Computed after mount only: Date.now() differs server↔client and would
  // otherwise trip a hydration mismatch. Re-ticks so a lingering gate stays honest.
  const [rel, setRel] = useState<string>("");
  useEffect(() => {
    const tick = () => setRel(relativeTime(progress.at, Date.now()));
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [progress.at]);

  return (
    <div
      className="flex min-h-[100svh] w-full items-center justify-center px-5 py-10"
      style={{ background: "var(--t-bg)", color: "var(--t-text)" }}
    >
      <div className="w-full max-w-[420px]">
        <div
          className="rounded-[24px] border p-6 shadow-sm"
          style={{ background: "var(--t-card)", borderColor: "var(--t-border)" }}
        >
          <span
            className={`${TX.eyebrow} inline-block rounded-full px-3 py-1.5`}
            style={{ background: "var(--t-accent-soft)", color: "var(--t-accent-ink)" }}
          >
            Picking up where you left off
          </span>

          <h1 className={`${TX.h1} mt-4`}>Welcome back</h1>
          <p className={TX.sub} style={{ color: "var(--t-muted)" }}>
            You started this trade-in earlier and didn&rsquo;t finish. Everything you did is still
            here &mdash; carry on, or start again from scratch.
          </p>

          <div
            className="mt-6 flex items-center gap-4 rounded-2xl border p-4"
            style={{ background: "var(--t-card-alt)", borderColor: "var(--t-border)" }}
          >
            <span
              className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl"
              style={{ background: "var(--t-accent-soft)", color: "var(--t-accent-ink)" }}
              aria-hidden="true"
            >
              <PhoneIcon />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-[16px] font-bold leading-tight">
                {progress.model ?? "Your device"}
                <span style={{ color: "var(--t-muted)" }}> &middot; {phaseLabel(progress.phase)}</span>
              </span>
              {/* Empty until the post-mount tick lands — reserves its line either way. */}
              <span className="mt-1 block text-[13px] leading-tight" style={{ color: "var(--t-muted)" }}>
                {rel || " "}
              </span>
            </span>
          </div>

          <button
            type="button"
            onClick={onResume}
            className={`${TX.cta} mt-6 min-h-[56px]`}
            style={{
              background: "var(--t-cta-bg)",
              color: "var(--t-cta-text)",
              borderRadius: "var(--t-cta-radius)",
            }}
          >
            Continue
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2.4}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-4 w-4"
              aria-hidden="true"
            >
              <path d="M5 12h13M13 6l6 6-6 6" />
            </svg>
          </button>

          <button
            type="button"
            onClick={onStartOver}
            className="mt-2 flex min-h-[56px] w-full items-center justify-center text-[15px] font-semibold"
            style={{ color: "var(--t-muted)", borderRadius: "var(--t-cta-radius)" }}
          >
            Start over
          </button>
        </div>
      </div>
    </div>
  );
}

function PhoneIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-7 w-7"
    >
      <rect x="6" y="2.5" width="12" height="19" rx="3" />
      <path d="M10.5 5.5h3" />
      <path d="M10.5 18.5h3" />
    </svg>
  );
}
