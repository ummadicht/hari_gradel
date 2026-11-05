"use client";

import { useEffect, useMemo, useState } from "react";
import { withBase } from "@/lib/basePath";
import { OptionCard, StepShell } from "./StepChrome";

// ── MANUAL DEVICE PICKER — the escape hatch behind "Choose manually".
// IMEI lookup is the happy path; when it fails (bad scan, unknown TAC) or the
// seller won't hand it over, the flow still has to land on a REAL pricebook
// model id, because that id is what the offer engine prices from. So the list
// is never hardcoded: it's the client's own synced pricebook, the same book
// computeOffer() reads. A model we can't sell is a model we can't offer.
//
// Cascade: BRAND → MODEL → CAPACITY → COLOUR, one question per screen, with
// crumbs to jump back. Composes StepShell so it re-themes (light swapmore /
// dark GradeIQ) and behaves identically to every other step of the flow.

export type ManualPick = {
  modelId: string;
  model: string;
  brand: string;
  storage: string;
  color: string;
};

type BookModel = { id: string; brand: string; name: string };
/** Only the pricebook fields this screen needs — the rest of the book is offer math. */
type BookLite = { models: BookModel[]; capacities: string[]; defaultStorage: string };

const STEPS = ["brand", "model", "storage", "color"] as const;
type Step = (typeof STEPS)[number];

const COPY: Record<
  Step,
  { title: string; why: string; empty: string; help?: { label: string; body: string } }
> = {
  brand: {
    title: "Who makes your phone?",
    why: "Pick the brand on the back of the device — we'll shorten the list from there.",
    empty: "Select a brand to continue",
  },
  model: {
    title: "Which model is it?",
    why: "Not sure? Your model name is in Settings, or in the small print on the back.",
    empty: "Select a model to continue",
    help: {
      label: "Where do I find my model?",
      body: "iPhone: Settings ▸ General ▸ About ▸ Model Name. Android: Settings ▸ About phone ▸ Model. It's also printed in tiny text on the back of most phones.",
    },
  },
  storage: {
    title: "How much storage?",
    why: "Storage changes what your phone is worth, so it's worth getting right.",
    empty: "Select a storage size to continue",
    help: {
      label: "Where do I find my storage?",
      body: "iPhone: Settings ▸ General ▸ iPhone Storage — the total at the top. Android: Settings ▸ Storage. Round up to the nearest size listed here.",
    },
  },
  color: {
    title: "What colour is it?",
    why: "Last one. Colour doesn't move your offer — it just helps us match the device.",
    empty: "Select a colour to continue",
  },
};

// Colours are cosmetic metadata, not priced, so this is a short fixed list
// rather than a per-model catalogue the seller has to hunt through.
const COLORS = ["Black", "White", "Silver", "Gold", "Blue", "Green", "Red", "Purple", "Other"];

// A book can arrive without storageMultipliers; capacity is still asked because
// downstream pricing wants a storage string, so fall back to the usual ladder.
const FALLBACK_CAPACITIES = ["64GB", "128GB", "256GB", "512GB", "1TB"];

const SEARCH_THRESHOLD = 12; // past this many models, searching beats scrolling

/** "512GB" → comparable size, so 1TB sorts after 512GB whatever order the book used. */
function capacityRank(label: string): number {
  const m = /^\s*([\d.]+)\s*(TB|GB|MB)\s*$/i.exec(label);
  if (!m) return Number.MAX_SAFE_INTEGER; // unknown labels sort last, but are never dropped
  const unit = m[2].toUpperCase();
  return Number(m[1]) * (unit === "TB" ? 1024 * 1024 : unit === "GB" ? 1024 : 1);
}

/**
 * Narrow the /pricebook payload by hand. It crosses the network, so it stays
 * `unknown` until proven otherwise — a half-written book should land on the
 * retry screen, never crash the seller out of a trade-in.
 */
function parseBook(raw: unknown): BookLite | null {
  if (typeof raw !== "object" || raw === null) return null;
  const book = (raw as { book?: unknown }).book;
  if (typeof book !== "object" || book === null) return null;
  const { models, storageMultipliers, defaultStorage } = book as {
    models?: unknown;
    storageMultipliers?: unknown;
    defaultStorage?: unknown;
  };
  if (!Array.isArray(models)) return null;

  const clean: BookModel[] = [];
  for (const entry of models) {
    if (typeof entry !== "object" || entry === null) continue;
    const { id, brand, name } = entry as { id?: unknown; brand?: unknown; name?: unknown };
    if (typeof id === "string" && typeof brand === "string" && typeof name === "string" && id && brand && name)
      clean.push({ id, brand, name });
  }
  if (!clean.length) return null; // an empty book is a failure, not an empty list

  const caps =
    typeof storageMultipliers === "object" && storageMultipliers !== null
      ? Object.keys(storageMultipliers as Record<string, unknown>)
      : [];
  const capacities = (caps.length ? caps : FALLBACK_CAPACITIES)
    .slice()
    .sort((a, b) => capacityRank(a) - capacityRank(b));

  return {
    models: clean,
    capacities,
    defaultStorage: typeof defaultStorage === "string" ? defaultStorage : "",
  };
}

export default function ManualDevicePicker({
  clientId,
  onCancel,
  onPick,
}: {
  clientId: string;
  onCancel: () => void;
  onPick: (v: ManualPick) => void;
}) {
  const [book, setBook] = useState<BookLite | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [attempt, setAttempt] = useState(0); // bumping this re-runs the fetch — i.e. the retry button
  const [step, setStep] = useState<Step>("brand");
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<ManualPick>({ modelId: "", model: "", brand: "", storage: "", color: "" });

  useEffect(() => {
    const ac = new AbortController();
    setStatus("loading");
    fetch(withBase(`/api/clients/${encodeURIComponent(clientId)}/pricebook`), { signal: ac.signal })
      .then((r) => (r.ok ? (r.json() as Promise<unknown>) : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((raw) => {
        const parsed = parseBook(raw);
        if (!parsed) throw new Error("unusable pricebook");
        setBook(parsed);
        setStatus("ready");
      })
      .catch((err: unknown) => {
        // An abort is us (unmount or retry), not a failure — don't flash the error screen.
        if (err instanceof DOMException && err.name === "AbortError") return;
        setStatus("error");
      });
    return () => ac.abort();
  }, [clientId, attempt]);

  const brands = useMemo(() => {
    if (!book) return [];
    const counts = new Map<string, number>();
    for (const m of book.models) counts.set(m.brand, (counts.get(m.brand) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [book]);

  const brandModels = useMemo(
    () => (book && draft.brand ? book.models.filter((m) => m.brand === draft.brand) : []),
    [book, draft.brand],
  );

  const shownModels = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return brandModels;
    return brandModels.filter((m) => m.name.toLowerCase().includes(q));
  }, [brandModels, query]);

  const goTo = (next: Step) => {
    setStep(next);
    setQuery(""); // a stale filter would hide the list you just came back to
  };
  const advance = () => {
    const i = STEPS.indexOf(step);
    if (i > -1 && i < STEPS.length - 1) goTo(STEPS[i + 1]);
  };
  const back = () => {
    const i = STEPS.indexOf(step);
    if (i <= 0) onCancel(); // backing out of question one leaves the picker entirely
    else goTo(STEPS[i - 1]);
  };

  // Answering auto-advances — fewer taps, and the crumbs make it reversible.
  // Colour is the exception: it arms Confirm rather than moving on.
  const pickBrand = (brand: string) => {
    // A different brand invalidates the model chosen under the old one.
    setDraft((d) => (d.brand === brand ? d : { ...d, brand, modelId: "", model: "" }));
    advance();
  };
  const pickModel = (m: BookModel) => {
    setDraft((d) => ({ ...d, modelId: m.id, model: m.name }));
    advance();
  };
  const pickStorage = (storage: string) => {
    setDraft((d) => ({ ...d, storage }));
    advance();
  };

  const crumbs = useMemo(() => {
    const out: { step: Step; value: string }[] = [];
    if (draft.brand) out.push({ step: "brand", value: draft.brand });
    if (draft.model) out.push({ step: "model", value: draft.model });
    if (draft.storage) out.push({ step: "storage", value: draft.storage });
    if (draft.color) out.push({ step: "color", value: draft.color });
    return out.filter((c) => c.step !== step); // don't echo the question you're standing on
  }, [draft, step]);

  // The retry screen owns the whole shell: showing "Who makes your phone?" above
  // a load failure would be asking a question we can't take an answer to.
  if (status === "error")
    return (
      <StepShell
        eyebrow="Choose manually"
        title="We couldn’t load the device list"
        sub="Check your connection and try once more — nothing you’ve entered is lost."
        onBack={onCancel}
        cta={{ label: "Try again", enabled: true, onClick: () => setAttempt((n) => n + 1) }}
      />
    );

  const complete = Boolean(draft.brand && draft.modelId && draft.storage && draft.color);
  const stepValue =
    step === "brand" ? draft.brand : step === "model" ? draft.modelId : step === "storage" ? draft.storage : draft.color;
  const isLast = step === "color";
  const ready = status === "ready" && book !== null;
  // Confirm is only live once all four answers exist; earlier steps just need their own.
  const canContinue = ready && (isLast ? complete : Boolean(stepValue));
  const copy = COPY[step];

  return (
    <StepShell
      eyebrow="Choose manually"
      title={copy.title}
      sub={copy.why}
      onBack={back}
      help={copy.help}
      progress={{ step: STEPS.indexOf(step) + 1, total: STEPS.length }}
      // No illustration here on purpose: these screens are long lists, and art
      // above the fold would push the options the seller came to tap off-screen.
      cta={{
        label: isLast ? "Confirm device" : "Continue",
        disabledLabel: ready ? copy.empty : "Loading your device list…",
        enabled: canContinue,
        onClick: () => (isLast ? onPick(draft) : advance()),
      }}
    >
      {crumbs.length > 0 && (
        // Crumbs sit at 44px rather than the flow's 56px tap floor: they're a
        // secondary "go fix that" affordance, and the list has to stay reachable.
        <div className="mb-4 flex flex-wrap items-center gap-1.5">
          {crumbs.map((c) => (
            <button
              key={c.step}
              type="button"
              onClick={() => goTo(c.step)}
              className="min-h-[44px] rounded-full border px-3 text-[13px] font-semibold transition active:scale-[0.98]"
              style={{
                background: "var(--t-accent-soft)",
                borderColor: "var(--t-accent)",
                color: "var(--t-accent-ink)",
              }}
            >
              {c.value}
            </button>
          ))}
        </div>
      )}

      {!ready || !book ? (
        <ListSkeleton />
      ) : (
        <div className="flex flex-col gap-3">
          {step === "brand" &&
            brands.map(([brand, count]) => (
              <OptionCard
                key={brand}
                title={brand}
                body={count === 1 ? "1 model" : `${count} models`}
                selected={draft.brand === brand}
                onSelect={() => pickBrand(brand)}
              />
            ))}

          {step === "model" && (
            <>
              {brandModels.length > SEARCH_THRESHOLD && (
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={`Search ${draft.brand} models`}
                  inputMode="search"
                  autoComplete="off"
                  aria-label={`Search ${draft.brand} models`}
                  // 16px is deliberate — anything smaller makes iOS Safari zoom on focus.
                  className="min-h-[56px] w-full rounded-2xl border px-4 text-[16px] outline-none placeholder:text-[color:var(--t-muted)]"
                  style={{ background: "var(--t-card)", borderColor: "var(--t-border)", color: "var(--t-text)" }}
                />
              )}

              {shownModels.map((m) => (
                <OptionCard
                  key={m.id}
                  title={m.name}
                  body={m.brand}
                  selected={draft.modelId === m.id}
                  onSelect={() => pickModel(m)}
                />
              ))}

              {shownModels.length === 0 && (
                <div className="py-6 text-center">
                  <p className="text-[15px] font-semibold">No models match “{query.trim()}”</p>
                  <button
                    type="button"
                    onClick={() => setQuery("")}
                    className="mt-2 min-h-[44px] text-[14px] font-bold underline"
                    style={{ color: "var(--t-accent-ink)" }}
                  >
                    Clear search
                  </button>
                </div>
              )}
            </>
          )}

          {step === "storage" &&
            book.capacities.map((cap) => (
              <OptionCard
                key={cap}
                title={cap}
                // Only the book's own default earns a helper line; repeating one on
                // every row would be noise, so the rest pass nothing.
                body={cap === book.defaultStorage ? "Most common" : undefined}
                selected={draft.storage === cap}
                onSelect={() => pickStorage(cap)}
              />
            ))}

          {step === "color" &&
            COLORS.map((c) => (
              <OptionCard
                key={c}
                title={c}
                body={c === "Other" ? "Two-tone, or not listed here" : undefined}
                selected={draft.color === c}
                onSelect={() => setDraft((d) => ({ ...d, color: c }))}
              />
            ))}
        </div>
      )}
    </StepShell>
  );
}

/** Placeholder rows while the book loads — keeps the list from jumping in under it. */
function ListSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <div
          key={i}
          className="h-[72px] animate-pulse rounded-2xl border"
          style={{ background: "var(--t-card-alt)", borderColor: "var(--t-border)" }}
        />
      ))}
    </div>
  );
}

// ── DEVICE ID FAILED — the screen that OFFERS the manual picker.
// Three exits, ranked by the data we'd rather have: retry the lookup (best),
// pick manually (good), continue unidentified (only when the caller says an
// unidentified device is still tradeable, by passing onSkip).
export function DeviceIdFailed({
  title = "Device couldn't be identified",
  body = "We weren't able to look up this IMEI. You can try again, choose your device manually, or continue without identifying it.",
  onRetry,
  onManual,
  onSkip,
}: {
  title?: string;
  body?: string;
  onRetry: () => void;
  onManual: () => void;
  onSkip?: () => void;
}) {
  return (
    <StepShell
      eyebrow="Identity"
      title={title}
      sub={body}
      illustration={<UnknownDeviceArt />}
      // StepShell docks exactly one primary CTA, so the fallbacks live in the
      // body directly under it — retrying is what we want tapped most.
      cta={{ label: "Try again", enabled: true, onClick: onRetry }}
    >
      <div className="flex flex-col gap-3">
        <button
          type="button"
          onClick={onManual}
          className="min-h-[56px] w-full border text-[16px] font-bold transition active:scale-[0.99]"
          style={{
            background: "var(--t-card)",
            borderColor: "var(--t-border)",
            color: "var(--t-text)",
            borderRadius: "var(--t-cta-radius)",
          }}
        >
          Choose manually
        </button>

        {onSkip && (
          <button
            type="button"
            onClick={onSkip}
            className="min-h-[56px] w-full text-[15px] font-semibold underline"
            style={{ color: "var(--t-muted)" }}
          >
            Continue anyway
          </button>
        )}
      </div>
    </StepShell>
  );
}

/** Phone outline with a question mark — the one illustration on the failure screen. */
function UnknownDeviceArt() {
  return (
    <svg viewBox="0 0 120 160" width="120" height="160" fill="none" aria-hidden="true">
      <rect x="12" y="6" width="96" height="148" rx="18" fill="var(--t-card)" stroke="var(--t-border)" strokeWidth="2" />
      <rect x="46" y="14" width="28" height="5" rx="2.5" fill="var(--t-border)" />
      <circle cx="60" cy="82" r="30" fill="var(--t-accent-soft)" />
      <text
        x="60"
        y="82"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize="34"
        fontWeight="800"
        fill="var(--t-accent-ink)"
      >
        ?
      </text>
      <rect x="34" y="126" width="52" height="6" rx="3" fill="var(--t-border)" />
    </svg>
  );
}
