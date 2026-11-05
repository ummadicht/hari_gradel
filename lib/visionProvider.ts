import { getSetting } from "./settings";
import { INSPECTION_SCHEMA } from "./inspectionSchema";
import { refineLimitMs, refineStatus, type RefineStatus } from "./refineStatus";

/**
 * Vision-provider abstraction: one interface, several backends.
 *
 * The cascade used to call Gemini directly. That coupled the whole grading
 * pipeline to one vendor's free tier — and when that tier hit its quota (HTTP
 * 429) the cascade silently fell back to a made-up stub grade.
 *
 * Now the provider is a CONFIGURABLE SWITCH (`vision_provider` setting, or the
 * VISION_PROVIDER env): "gemini" (default, using Gemini 3.1 Pro) or "kimi"
 * (Kimi K3). The selected provider is tried first; the other acts as an
 * automatic fallback only for TRANSIENT failures (quota/network), so flipping
 * the switch is instant but a momentary outage still degrades gracefully. The
 * deterministic capture gate remains the always-on floor beneath both.
 *
 * A provider takes a text prompt + base64 image data URLs and returns parsed
 * JSON (both backends run in JSON mode) or null on any failure. Callers must
 * treat null as "the AI could not answer" — never as an implicit pass.
 */

export type VisionProvider = "gemini" | "kimi" | "openai";
export const DEFAULT_PROVIDER: VisionProvider = "gemini";

/**
 * Cost tier. "flash" is the cheap high-volume model for the bulk per-image
 * inspection; "pro" is the expensive, more-accurate model used only to resolve
 * borderline cases and the final grade. On Gemini these are genuinely different
 * models (3.6 Flash vs 3.1 Pro); on Kimi both map to K3 (no cheaper vision tier),
 * so escalating a Kimi flash pass to pro is a no-op and the cascade skips it.
 */
export type VisionTier = "flash" | "pro";

/**
 * OpenAI model ids are SETTINGS, not constants.
 *
 * The other two providers are pinned because we chose those exact models. For
 * OpenAI the useful id changes often enough — and differs by what an account is
 * actually entitled to — that hardcoding one here would silently 404 for
 * someone. Set `openai_model_flash` / `openai_model_pro` (or the matching env
 * vars) to whatever vision model this account should use; the defaults below
 * are only a starting point and should be confirmed against the account's
 * available models before relying on them.
 */
function openaiModel(tier: VisionTier): string {
  return tier === "pro"
    ? getSetting("openai_model_pro", "OPENAI_VISION_MODEL_PRO") || "gpt-5"
    : getSetting("openai_model_flash", "OPENAI_VISION_MODEL_FLASH") || "gpt-5-mini";
}

const MODELS: Record<VisionProvider, Record<VisionTier, string>> = {
  gemini: { flash: "gemini-3.6-flash", pro: "gemini-3.1-pro-preview" },
  kimi: { flash: "kimi-k3", pro: "kimi-k3" },
  // Resolved at call time from settings — see openaiModel(). These placeholders
  // exist only so the record is total; nothing reads them directly.
  openai: { flash: "", pro: "" },
};

/**
 * Gemini model ids: pinned defaults, overridable from settings.
 *
 * Google retires these on its own schedule — gemini-2.0-flash and then
 * gemini-2.5-pro both went 404 under us — and a pin that can only change by
 * redeploying turns every retirement into an outage. `gemini_model_flash` /
 * `gemini_model_pro` (or GEMINI_MODEL_FLASH / GEMINI_MODEL_PRO) swap the model
 * without touching code; unset, nothing changes.
 */
function geminiModel(tier: VisionTier): string {
  return tier === "pro"
    ? getSetting("gemini_model_pro", "GEMINI_MODEL_PRO") || MODELS.gemini.pro
    : getSetting("gemini_model_flash", "GEMINI_MODEL_FLASH") || MODELS.gemini.flash;
}

/**
 * FLASH FALLBACK MODEL. Flash is the floor — no breaker, no lower tier — so
 * when the Flash model is down (`unavailable`, after its one retry) or hung
 * (`timeout`), ONE other Gemini model gets the call before the other vendors
 * do: `gemini_model_flash_fallback` (or GEMINI_MODEL_FLASH_FALLBACK), default
 * gemini-2.5-flash. Skipped when it is the primary. Pro has no such chain: a
 * failed Pro already falls back to Flash.
 */
function geminiFlashFallback(): string {
  return getSetting("gemini_model_flash_fallback", "GEMINI_MODEL_FLASH_FALLBACK") || "gemini-2.5-flash";
}

/** The model id this provider uses at this tier. */
function modelFor(p: VisionProvider, tier: VisionTier): string {
  return p === "openai" ? openaiModel(tier) : p === "gemini" ? geminiModel(tier) : MODELS[p][tier];
}

/** True when the provider's flash and pro tiers are different models (worth escalating). */
export function hasDistinctTiers(p: VisionProvider): boolean {
  return modelFor(p, "flash") !== modelFor(p, "pro");
}

export type VisionOutcome = {
  json: any | null;
  /** Which provider actually answered, for diagnostics + honest reporting. */
  provider: VisionProvider | null;
  /** The exact model that produced the answer (e.g. "gemini-3.6-flash"). */
  model: string | null;
  /**
   * Why there is no json. "quota" and "auth" are operator problems worth
   * surfacing distinctly from an ordinary miss, exactly as extractImei does.
   *
   * "unavailable" is the provider answering 5xx — overloaded or down. It used to
   * be filed under "bad_response", which reads as "the model said something
   * unusable" when the truth is "the model never got to answer". On 2026-10-18
   * gemini-3.1-pro-preview returned 503 "high demand" for 11+ hours while Flash
   * answered normally; every Pro call in that window was a "bad response".
   *
   * "model_gone" is a 404: the model id no longer exists (gemini-2.0-flash and
   * gemini-2.5-pro were both retired this way). Permanent — never retried — and
   * fixed by pointing `gemini_model_*` at a current model, not by waiting.
   *
   * "timeout" is a call that did not answer within the tier's budget (see
   * callTimeoutMs). Not retried — the budget is already spent.
   */
  error: null | "no_key" | "quota" | "auth" | "bad_response" | "network" | "unavailable" | "model_gone" | "timeout";
  /** The HTTP status of a failed call, when there was one — diagnostics only. */
  status?: number;
};

/**
 * HOW LONG ONE CALL MAY TAKE.
 *
 * The fetch used to have no deadline at all, so a call Google accepted but
 * never answered held the request until Node's own 300 s socket limit — and a
 * lens check, which the seller watches, simply never came back. Observed live
 * on 2026-10-18 while Google was overloaded: a one-line prompt took 2–21 s,
 * and a three-photo lens check that normally answers in ~20 s was still open
 * after 200 s. Typical calls are 2–30 s; these budgets are several times that.
 * `vision_timeout_ms` (or VISION_TIMEOUT_MS) overrides both tiers.
 */
function callTimeoutMs(tier: VisionTier): number {
  const v = Number(getSetting("vision_timeout_ms", "VISION_TIMEOUT_MS"));
  if (Number.isFinite(v) && v > 0) return v;
  return tier === "pro" ? 150_000 : 90_000;
}

/**
 * The pause before a call's one retry (see guarded): RETRY_PAUSE_MS plus up to
 * RETRY_JITTER_MS, so retries from many callers do not land together.
 */
const RETRY_PAUSE_MS = 800;
const RETRY_JITTER_MS = 400;

/**
 * How long a session may claim `refining` before a reader shows its grading as
 * unfinished (SUP-63, lib/refineStatus.ts): the Pro call's timeout, its one
 * retry after the longest pause, and a margin. Follows `vision_timeout_ms`, so
 * an operator who lengthens the call budget lengthens this with it.
 */
export function refineUnfinishedAfterMs(): number {
  return refineLimitMs(callTimeoutMs("pro"), RETRY_PAUSE_MS + RETRY_JITTER_MS);
}

/** Where a session's grading stands right now (reads only; see lib/refineStatus.ts). */
export function refineStatusNow(cosmetic: unknown, updatedAt?: unknown): RefineStatus {
  return refineStatus(cosmetic, { now: Date.now(), limitMs: refineUnfinishedAfterMs(), updatedAt });
}

/** A failed fetch: our deadline, or the network. */
function errorForThrow(e: unknown): VisionOutcome["error"] {
  const name = (e as { name?: string } | null)?.name;
  return name === "TimeoutError" || name === "AbortError" ? "timeout" : "network";
}

/** An HTTP failure, mapped onto VisionOutcome's error vocabulary. */
function errorForStatus(status: number): VisionOutcome["error"] {
  if (status === 429) return "quota"; // rate / quota
  if (status === 401 || status === 403) return "auth"; // bad key
  if (status >= 500) return "unavailable"; // overloaded or down — transient
  if (status === 404) return "model_gone"; // retired / renamed model — permanent
  return "bad_response";
}

/**
 * PER-MODEL CIRCUIT BREAKER.
 *
 * A model that is 503ing does not fail fast: Gemini takes 4–8 s to say "high
 * demand". During the Pro outage every capture paid that on its background
 * refinement, every re-grade paid it twice (two settling passes), and the lens
 * check paid it while the seller waited — for an answer that was never coming.
 *
 * So after TRIP_AFTER consecutive CALLS fail on an overload a model is skipped
 * for COOL_MS: calls return "unavailable" immediately and the caller's existing
 * fallback runs at once instead of after the timeout. A call counts once, retry
 * included — one unlucky request (503, and 503 again a second later) must not
 * shut the model off for everyone; it takes a second, separate request failing
 * the same way. A call that runs out its time budget counts as overloaded too.
 * When the cool-down ends the next call goes through as a single
 * probe (no retry) — one success closes the breaker, one more failure re-opens
 * it. Only an OVERLOAD counts — 502/503, which is what
 * "high demand" is. A 500 or 504 can be provoked by one particular request
 * (an oversized payload, a prompt the model chokes on), and must not shut the
 * model off for everyone else; a 429 is a per-minute ceiling that clears on
 * its own, and a network error may well be ours. Those still get the retry.
 *
 * PRO TIER ONLY, AND NOT IN PRO-ONLY MODE. Normally every Pro call has somewhere
 * to go when Pro is skipped — the capture keeps its Flash grade, a re-grade
 * falls back to Flash, a lens check reports "unverified". Flash has nowhere to
 * go: it IS the floor, and a breaker on it would turn two back-to-back 503s
 * into a minute in which every seller's capture comes back ungraded — strictly
 * worse than letting each capture try for itself. With pro_only on, Pro is the
 * floor instead, so the same reasoning switches the breaker off there too. The
 * floor always gets its one retry.
 *
 * Kept on globalThis (as db.ts keeps its handle) so every route bundle in the
 * server process shares one view of which models are down.
 */
const TRIP_AFTER = 2;
// Short on purpose: while a model is skipped, a capture's background Pro
// refinement is skipped too and that capture keeps its Flash grade, so a long
// window after a brief blip would cost real refinements. One minute still turns
// a re-grade's second pass, a D corroboration and a bulk sweep into instant
// fallbacks, at the price of one probe per minute during a long outage.
const COOL_MS = 60_000;
type Breaker = { fails: number; openUntil: number };
const g = globalThis as unknown as { __gradeiq_vision_breakers?: Map<string, Breaker> };
const breakers: Map<string, Breaker> = (g.__gradeiq_vision_breakers ??= new Map());

function breakerOpen(id: string): boolean {
  return (breakers.get(id)?.openUntil ?? 0) > Date.now();
}

const isOverload = (o: VisionOutcome) => o.error === "unavailable" && (o.status === 502 || o.status === 503);

/**
 * Record ONE call's result (after its retry). `overloaded`: some attempt hit
 * 502/503. A TIMEOUT is a strike too: "high demand" shows up as hangs as well
 * as 503s (a 3-photo lens check observed taking ~225 s), and only Pro calls —
 * each with somewhere to fall back to — are ever recorded here.
 */
function recordOutcome(id: string, out: VisionOutcome, overloaded: boolean) {
  const { error } = out;
  if ((error === "unavailable" && overloaded) || error === "timeout") {
    const b = breakers.get(id) ?? { fails: 0, openUntil: 0 };
    b.fails += 1;
    if (b.fails >= TRIP_AFTER) {
      b.openUntil = Date.now() + COOL_MS;
      console.warn(`[vision] ${id} unavailable ${b.fails}x in a row — skipping it for ${COOL_MS / 1000}s`);
    }
    breakers.set(id, b);
  } else if (error !== "network" && error !== "unavailable") {
    // Any other real HTTP answer — even a 4xx — proves the model is reachable.
    // A 500/504 or a network error neither trips nor clears: it says nothing
    // about load. (A timeout never reaches here — it is a strike, above.)
    breakers.delete(id);
  }
}

/** Models currently being skipped, for the admin console and logs. */
export function unavailableModels(): { model: string; until: string }[] {
  const now = Date.now();
  return [...breakers.entries()]
    .filter(([, b]) => b.openUntil > now)
    .map(([model, b]) => ({ model, until: new Date(b.openUntil).toISOString() }));
}

/**
 * One provider call behind the breaker, with ONE bounded retry on a transient
 * failure. Google's own 503 text says spikes "are usually temporary", and a
 * single short retry is what rides out the common case; it is deliberately not
 * a loop, because a long outage is the breaker's job, not the retry's.
 */
async function guarded(
  id: string,
  call: () => Promise<VisionOutcome>,
  useBreaker: boolean,
  timeoutMs: number,
): Promise<VisionOutcome> {
  if (useBreaker && breakerOpen(id)) return { json: null, provider: null, model: null, error: "unavailable" };
  // Half-open (cool-down just ended): this call is the probe — one attempt only,
  // and the ONLY one. Hold the breaker shut for as long as the probe may take,
  // so callers arriving meanwhile skip at once instead of each waiting out a
  // hang of their own; the probe's own result then closes or re-opens it.
  const b = useBreaker ? breakers.get(id) : undefined;
  const probing = !!b && b.fails >= TRIP_AFTER;
  if (b && probing) b.openUntil = Date.now() + timeoutMs + 5_000;
  let out = await call();
  let overloaded = isOverload(out);
  if ((out.error === "unavailable" || out.error === "network") && !probing && !(useBreaker && breakerOpen(id))) {
    await new Promise((r) => setTimeout(r, RETRY_PAUSE_MS + Math.floor(Math.random() * RETRY_JITTER_MS)));
    out = await call();
    overloaded = overloaded || isOverload(out);
  }
  if (useBreaker) recordOutcome(id, out, overloaded);
  return out;
}

type ImagePart = { mime: string; b64: string };

function splitDataUrl(dataUrl: string): ImagePart | null {
  const m = /^data:(image\/[a-z+]+);base64,(.*)$/i.exec(dataUrl);
  if (!m) return null;
  return { mime: m[1], b64: m[2] };
}

function parseLenient(text: string): any | null {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // Models occasionally wrap JSON in prose or a ```json fence despite JSON
    // mode; salvage the outermost object rather than discarding a good answer.
    const a = text.indexOf("{");
    const b = text.lastIndexOf("}");
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(text.slice(a, b + 1));
      } catch {
        /* fall through */
      }
    }
    return null;
  }
}

// ---- Kimi K3 (Moonshot), OpenAI-compatible ----
// https://platform.kimi.ai/docs/guide/use-kimi-vision-model
// kimi-latest was discontinued 2026-01-28; kimi-k3 is the current vision model.
const KIMI_URL = "https://api.moonshot.ai/v1/chat/completions";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

async function callKimi(key: string, model: string, prompt: string, images: ImagePart[], timeoutMs: number): Promise<VisionOutcome> {
  try {
    const content: any[] = images.map((im) => ({
      type: "image_url",
      image_url: { url: `data:${im.mime};base64,${im.b64}` },
    }));
    content.push({ type: "text", text: prompt });

    const res = await fetch(KIMI_URL, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        // temperature 0 = deterministic grade. A grader that returns a different
        // verdict each run on the same photos is not trustworthy.
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content }],
      }),
    });
    if (!res.ok) {
      // 429 = rate/quota, 401/403 = bad key, 5xx = overloaded — worth telling the operator apart.
      return { json: null, provider: null, model: null, error: errorForStatus(res.status), status: res.status };
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content ?? "";
    const json = parseLenient(typeof text === "string" ? text : "");
    return json
      ? { json, provider: "kimi", model, error: null }
      : { json: null, provider: null, model: null, error: "bad_response" };
  } catch (e) {
    return { json: null, provider: null, model: null, error: errorForThrow(e) };
  }
}

// ---- OpenAI (ChatGPT vision) ----
// Same wire format as Kimi (OpenAI-compatible /chat/completions with
// image_url parts and JSON mode), so this is the Kimi caller pointed at
// OpenAI's endpoint. Its value here is INDEPENDENCE: two samples of one model
// share that model's blind spots, so a second opinion from the same family
// corroborates little. A different vendor's model failing to see the same
// "shattered glass" is real evidence it was never there.
async function callOpenAI(key: string, model: string, prompt: string, images: ImagePart[], timeoutMs: number): Promise<VisionOutcome> {
  try {
    const content: any[] = images.map((im) => ({
      type: "image_url",
      image_url: { url: `data:${im.mime};base64,${im.b64}` },
    }));
    content.push({ type: "text", text: prompt });

    const res = await fetch(OPENAI_URL, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content }],
      }),
    });
    if (!res.ok) {
      return { json: null, provider: null, model: null, error: errorForStatus(res.status), status: res.status };
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content ?? "";
    const json = parseLenient(typeof text === "string" ? text : "");
    return json
      ? { json, provider: "openai", model, error: null }
      : { json: null, provider: null, model: null, error: "bad_response" };
  } catch (e) {
    return { json: null, provider: null, model: null, error: errorForThrow(e) };
  }
}

// ---- Gemini (3.6 Flash / 3.1 Pro) ----
// Gemini 3 is a reasoning model — it wants concise, direct prompts, not verbose
// prompt-engineering; the inspection catalog fragments are written accordingly.
async function callGemini(
  key: string,
  model: string,
  prompt: string,
  images: ImagePart[],
  schema: unknown,
  timeoutMs: number,
): Promise<VisionOutcome> {
  try {
    const parts: any[] = [{ text: prompt }];
    images.forEach((im, i) => {
      parts.push({ text: `Photo index ${i}:` });
      parts.push({ inline_data: { mime_type: im.mime, data: im.b64 } });
    });
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      {
        method: "POST",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig: {
            responseMimeType: "application/json",
            // Constrain the SHAPE, not just the syntax. Without this the parser
            // silently coerces off-vocabulary values — a "cracked" finding
            // becomes "scratch", a "high" severity becomes "minor" — which
            // downgrades real damage without leaving a trace. Gated so a
            // misbehaving schema is a settings flip, not a redeploy.
            // The schema is the CALLER's, not this module's. It used to be
            // hardcoded to INSPECTION_SCHEMA, which silently constrained every
            // other caller — the intake gate and the camera assessment expect
            // completely different top-level shapes, and were being forced into
            // the cosmetic one. A schema that does not match the prompt is
            // worse than no schema: the response validates and means nothing.
            ...(schemaEnabled() && schema ? { responseSchema: schema } : {}),
            temperature: 0,
            topP: 1,
            topK: 1,
            // A fixed seed is the strongest reproducibility lever the API gives
            // us. It is NOT a guarantee: Gemini 3 is a reasoning model, and two
            // runs can follow different internal reasoning paths and land on
            // different verdicts even at temperature 0. Observed live — the same
            // six photos graded B with two findings, then A with none. Anything
            // that must be stable is settled by consensus, not by config.
            seed: 7,
          },
        }),
      },
    );
    if (!res.ok) {
      return { json: null, provider: null, model: null, error: errorForStatus(res.status), status: res.status };
    }
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    const json = parseLenient(text);
    return json
      ? { json, provider: "gemini", model, error: null }
      : { json: null, provider: null, model: null, error: "bad_response" };
  } catch (e) {
    return { json: null, provider: null, model: null, error: errorForThrow(e) };
  }
}

function kimiKey(): string {
  return getSetting("kimi_key", "MOONSHOT_API_KEY") || getSetting("", "KIMI_API_KEY") || "";
}
function geminiKey(): string {
  return getSetting("gemini_key", "GEMINI_API_KEY") || getSetting("", "GOOGLE_API_KEY") || "";
}
function openaiKey(): string {
  return getSetting("openai_key", "OPENAI_API_KEY") || "";
}

/** Which providers actually have a key right now — drives the re-grade menu. */
export function availableProviders(): VisionProvider[] {
  const out: VisionProvider[] = [];
  if (geminiKey()) out.push("gemini");
  if (openaiKey()) out.push("openai");
  if (kimiKey()) out.push("kimi");
  return out;
}

/** The operator's chosen provider. Unset/unknown → the default (gemini). */
export function selectedProvider(): VisionProvider {
  const v = (getSetting("vision_provider", "VISION_PROVIDER") || "").toLowerCase().trim();
  return v === "kimi" ? "kimi" : v === "openai" ? "openai" : v === "gemini" ? "gemini" : DEFAULT_PROVIDER;
}

/**
 * PRO-ONLY MODE — the cheap tier is switched off entirely.
 *
 * Flash and Pro do not merely differ in cost, they disagree about the phone:
 * on production session 9016c5b4 four consecutive Pro runs found 2 findings and
 * graded D, while Flash found ZERO findings on the same six photos and graded
 * A. A pipeline that shows whichever tier happened to answer is a pipeline that
 * quotes two different prices for one device, so an operator may insist that
 * only the accurate grader is ever allowed to decide.
 *
 * When on:
 *   • capture grades on Pro (the seller waits for it — there is no instant
 *     Flash estimate to show first),
 *   • re-grade ignores a requested "flash" tier,
 *   • a failed Pro is reported as a failure rather than quietly downgraded.
 *
 * Off by default so nothing changes for anyone who hasn't asked for it.
 */
/** Response-schema enforcement. On unless explicitly disabled. */
export function schemaEnabled(): boolean {
  const v = (getSetting("vision_schema", "VISION_SCHEMA") || "").toLowerCase().trim();
  return v !== "false" && v !== "0" && v !== "off";
}

export function proOnly(): boolean {
  return (getSetting("pro_only", "PRO_ONLY") || "").toLowerCase().trim() === "true";
}

/** True when at least one vision provider is configured. */
export function visionConfigured(): boolean {
  return Boolean(kimiKey() || geminiKey() || openaiKey());
}

/**
 * Report the provider picture for the admin console: which is selected, which
 * have keys, and whether the selected one is actually usable.
 */
export function providerStatus() {
  const selected = selectedProvider();
  const keys: Record<VisionProvider, boolean> = {
    gemini: Boolean(geminiKey()),
    kimi: Boolean(kimiKey()),
    openai: Boolean(openaiKey()),
  };
  return {
    selected,
    keys,
    selectedReady: keys[selected],
    anyReady: keys.gemini || keys.kimi || keys.openai,
  };
}

/**
 * Run a vision prompt against the configured provider at a given cost tier.
 *
 * The `vision_provider` switch picks who goes FIRST. The other provider is a
 * fallback only when the first fails for a TRANSIENT reason (quota/network) — an
 * auth failure on the primary still lets the secondary try, but a clean answer
 * from the primary is always returned as-is. If every configured provider fails,
 * json is null and the caller must NOT treat that as a pass.
 *
 * `tier` selects the model within each provider (flash = cheap bulk, pro =
 * accurate escalation). The returned `model` says exactly what answered, so the
 * caller can decide whether escalating to pro would even reach a stronger model.
 */
export async function visionJSON(
  prompt: string,
  photos: string[],
  tier: VisionTier = "pro",
  /**
   * Force ONE provider for this call and do not fall back to any other.
   *
   * Used by "re-grade with <model>": the point of that action is a SECOND
   * OPINION from a named vendor, so silently answering with the provider that
   * already graded it would defeat it — the operator would be told ChatGPT
   * agreed with Gemini when Gemini answered twice. If the forced provider has
   * no key or cannot answer, this returns the error rather than substituting.
   */
  force?: VisionProvider,
  /**
   * Response schema for THIS call. Defaults to the cosmetic inspection schema
   * because that is what the overwhelming majority of calls want — but callers
   * with a different contract (the intake gate, the camera assessment) must
   * pass their own, or `null` to send none at all.
   */
  schema: unknown = INSPECTION_SCHEMA,
): Promise<VisionOutcome> {
  const images = photos.map(splitDataUrl).filter((x): x is ImagePart => x !== null);
  if (images.length === 0) return { json: null, provider: null, model: null, error: "bad_response" };

  const kk = kimiKey();
  const gk = geminiKey();
  const ok = openaiKey();
  if (!kk && !gk && !ok) return { json: null, provider: null, model: null, error: "no_key" };

  // Pro calls go through the breaker, keyed by provider+model, so a Pro model
  // that is down is skipped at once rather than awaited for its timeout. Flash
  // calls are never skipped — see the breaker's comment for why.
  const gm = modelFor("gemini", tier);
  const km = modelFor("kimi", tier);
  const om = modelFor("openai", tier);
  const brk = tier === "pro" && !proOnly();
  const ms = callTimeoutMs(tier);
  const gemini = (m: string) => guarded(`gemini:${m}`, () => callGemini(gk, m, prompt, images, schema, ms), brk, ms);
  const gfb = tier === "flash" ? geminiFlashFallback() : "";
  const run: Record<VisionProvider, (() => Promise<VisionOutcome>) | null> = {
    // Still Gemini, so a forced Gemini call takes the fallback model too; the
    // outcome's `model` says which one answered. If the fallback fails as well,
    // the primary's error is the story.
    gemini: gk
      ? async () => {
          const out = await gemini(gm);
          if (!gfb || gfb === gm || (out.error !== "unavailable" && out.error !== "timeout")) return out;
          const alt = await gemini(gfb);
          return alt.json ? alt : out;
        }
      : null,
    kimi: kk ? () => guarded(`kimi:${km}`, () => callKimi(kk, km, prompt, images, ms), brk, ms) : null,
    openai: ok ? () => guarded(`openai:${om}`, () => callOpenAI(ok, om, prompt, images, ms), brk, ms) : null,
  };

  // A forced provider is exactly that — no fallback, so the answer is honestly
  // attributable to the model the operator asked for.
  if (force) {
    const only = run[force];
    if (!only) return { json: null, provider: null, model: null, error: "no_key" };
    return await only();
  }

  // Otherwise: selected provider first, the others as transient-failure fallback.
  const sel = selectedProvider();
  const order: VisionProvider[] = [sel, ...(["gemini", "openai", "kimi"] as VisionProvider[]).filter((p) => p !== sel)];

  // The error that matters is the FIRST provider's — the one that was supposed
  // to answer. A later fallback's 429 or 401 used to overwrite it, so a Gemini
  // outage with an exhausted backup key was reported as "quota".
  let firstError: VisionOutcome["error"] = null;
  for (const p of order) {
    const attempt = run[p];
    if (!attempt) continue;
    const out = await attempt();
    if (out.json) return out;
    if (firstError === null) firstError = out.error;
  }
  return { json: null, provider: null, model: null, error: firstError ?? "no_key" };
}
