/**
 * WHO MAY REWRITE A GRADE — the rules behind /grade-manual and /functional.
 *
 * Both routes are anonymous by design: the session id in the seller's QR (or in
 * SwapUp's camera link, or CounterIQ's) is the only key the phone, the store
 * tablet and the camera page have. That made the id a licence to rewrite the
 * record it grades. With nothing but the id, a seller could:
 *
 *   • replace an AI grade with "Premium", stored as conclusive at confidence 1
 *     — the passport then printed VERIFIED over the seller's own claim;
 *   • turn a failed test into a pass (or drop it with a non-merge write), which
 *     removes the repair deduction from the offer;
 *   • stamp a lens "checked by hand" as if an operator had looked at it;
 *   • change any of it after the offer was accepted and the payout gate passed.
 *
 * The rules here are MONOTONIC for anyone without a staff sign-in: an anonymous
 * caller can add evidence and can make a result worse, but cannot make a
 * recorded fault go away, cannot overrule the AI or a member of staff, and
 * cannot touch a session once money is committed against it. Staff (any portal
 * / Keycloak sign-in — see lib/sessionWriteAuth.ts) may do all of these, and
 * every such override is written to the session's event trail.
 *
 * Pure on purpose — no database, no request — so every rule is unit tested
 * without a server, and the routes stay thin.
 */

import { COSMETIC_TIERS } from "./grading";
import { testById } from "./tests";

export type FnValue = "pass" | "fail" | "skip";
export const FN_VALUES: readonly FnValue[] = ["pass", "fail", "skip"];

/** Lens states as stored on the camera record (see lib/lensVerify.ts StoredLens). */
const LENS_STATES = ["pass", "fail", "manual"] as const;
const LENS_BY = ["browser", "operator", "vision"] as const;

/**
 * Camera keys that only GradeIQ's own server routes write: frames
 * (/camera-frames), the optical assessment (/camera-assess) and the lens
 * photos (/lens-verify). /functional used to REPLACE the whole camera record
 * with whatever the page sent, so a stale or hand-made copy could erase a
 * "faulty lens" assessment. A /functional write never sets them; they are
 * dropped (not refused), because the report legitimately echoes back the copy
 * it rendered.
 */
export const SERVER_OWNED_CAMERA_KEYS = ["assessment", "frames", "lensShots"] as const;

/** Purchase states after which the device has been bought (lib/purchase.ts). */
const COMMITTED_PURCHASE = ["accepted", "cleared", "paying", "paid"];

type Bad = { ok: false; error: string };

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/**
 * The `functional` map from a request body.
 *
 * Only pass / fail / skip are results. Anything else used to be stored as-is,
 * and the passport then rendered a test state its own type does not allow.
 * A missing map is `{}` — the old behaviour, which a non-merge write turns
 * into "clear everything" (and the rules below then judge that).
 */
export function readFunctionalBody(raw: unknown): { ok: true; value: Record<string, FnValue> } | Bad {
  if (raw === undefined || raw === null) return { ok: true, value: {} };
  if (!isPlainObject(raw)) return { ok: false, error: "functional must be an object of test id → pass | fail | skip" };
  const keys = Object.keys(raw);
  if (keys.length > 64) return { ok: false, error: "too many tests in one write" };
  const badKey = keys.find((k) => !/^[A-Za-z0-9_.-]{1,64}$/.test(k));
  if (badKey !== undefined) return { ok: false, error: `bad test id "${badKey.slice(0, 64)}"` };
  const badValue = keys.filter((k) => !FN_VALUES.includes(raw[k] as FnValue));
  if (badValue.length) {
    return { ok: false, error: `results must be pass, fail or skip (bad: ${badValue.slice(0, 6).join(", ")})` };
  }
  return { ok: true, value: raw as Record<string, FnValue> };
}

/**
 * The optional per-lens `camera` detail from a request body.
 *
 * Absent or not an object → null (ignored, as before). An array, or a lens
 * with a state or provenance outside the vocabulary, is refused: the report and
 * lib/lensVerify.ts both branch on those exact values.
 */
export function readCameraBody(raw: unknown): { ok: true; value: Record<string, unknown> | null } | Bad {
  if (raw === undefined || raw === null || typeof raw !== "object") return { ok: true, value: null };
  if (Array.isArray(raw)) return { ok: false, error: "camera must be an object" };
  const cam = raw as Record<string, unknown>;
  if (cam.lenses !== undefined) {
    if (!Array.isArray(cam.lenses) || cam.lenses.length > 12) return { ok: false, error: "camera.lenses must be a list" };
    for (const l of cam.lenses) {
      if (!isPlainObject(l) || typeof l.id !== "string" || !l.id || l.id.length > 40) {
        return { ok: false, error: "every lens needs an id" };
      }
      if (!LENS_STATES.includes(l.state as (typeof LENS_STATES)[number])) {
        return { ok: false, error: `lens ${l.id}: state must be pass, fail or manual` };
      }
      if (l.by !== undefined && !LENS_BY.includes(l.by as (typeof LENS_BY)[number])) {
        return { ok: false, error: `lens ${l.id}: unknown provenance` };
      }
    }
  }
  return { ok: true, value: cam };
}

/**
 * Why this session can no longer change, or null.
 *
 * GradeIQ has no separate "finalise" button: grading becomes final at the
 * moment money is committed against it — the seller accepted the offer and the
 * payout gate passed (/accept), or the retail purchase built on this check
 * moved past "offered" (lib/purchase.ts). A blocked accept is not a lock: the
 * seller may switch Find My off and try again.
 */
export function lockReason(input: {
  accepted?: number | boolean | null;
  verification?: Record<string, unknown> | null;
  purchaseStatus?: string | null;
}): string | null {
  if (Number(input.accepted) === 1 || input.accepted === true) return "accepted";
  const payout = (input.verification as { payout?: { passed?: unknown } } | null)?.payout;
  if (payout?.passed === true) return "payout";
  if (input.purchaseStatus && COMMITTED_PURCHASE.includes(input.purchaseStatus)) return `purchase-${input.purchaseStatus}`;
  return null;
}

export type CosmeticOwner = "ai" | "staff" | "seller" | null;

/**
 * Who produced the cosmetic grade on record.
 *
 *   ai      the vision pipeline graded the photos (Flash/Pro, incl. a staff
 *           re-grade). A stub — no model answered — leaves no grade, so it
 *           does not count: that is exactly when the seller needs the picker.
 *   staff   a signed-in member of staff picked it (this module's `by: "staff"`).
 *   seller  a manual pick without a sign-in — this module's provisional grade,
 *           or a manual grade written before `by` existed (who made those is
 *           unknowable, so they are not treated as authoritative).
 *   null    no grade yet (including a background grade still refining).
 */
export function cosmeticOwner(s: { cosmetic_grade?: string | null; cosmetic?: Record<string, unknown> | null }): CosmeticOwner {
  const c = (s.cosmetic || {}) as Record<string, unknown>;
  if (c.source === "manual") return c.by === "staff" ? "staff" : s.cosmetic_grade || c.grade ? "seller" : null;
  if (!s.cosmetic_grade) return null;
  if (c.tierUsed === "flash" || c.tierUsed === "pro" || c.source === "gemini") return "ai";
  return null;
}

export type Refusal = { ok: false; status: 403 | 409; code: string; error: string };

/** May this caller set the cosmetic grade by hand? */
export function decideManualGrade(input: { owner: CosmeticOwner; lock: string | null; staff: boolean }): { ok: true } | Refusal {
  if (input.staff) return { ok: true };
  if (input.lock) {
    return {
      ok: false,
      status: 409,
      code: "final",
      error: "This check is final — the offer was accepted. Ask the store to change the grade.",
    };
  }
  if (input.owner === "ai") {
    return {
      ok: false,
      status: 409,
      code: "graded",
      error: "The photos already produced a grade. Retake the photos, or ask the store to confirm the condition.",
    };
  }
  if (input.owner === "staff") {
    return {
      ok: false,
      status: 409,
      code: "graded",
      error: "The store has already set this grade.",
    };
  }
  return { ok: true };
}

/**
 * The cosmetic record a manual pick writes.
 *
 * Without a sign-in it is PROVISIONAL: not conclusive, no confidence (nothing
 * measured it), so the passport reads PENDING rather than VERIFIED, and the
 * offer engine prices it at the LOWEST grade, showing what the pick is worth
 * once confirmed (lib/offer.ts) — priced at the pick, a seller could pick
 * "Premium", accept, and lock the session at the Premium price. A staff pick is
 * the operator's own judgement and stays conclusive. The staff member's
 * name is NOT written here — this record is served to anyone holding the
 * session link — it goes to the event trail instead.
 */
export function manualCosmetic(grade: string, staff: boolean, at: string): Record<string, unknown> {
  return staff
    ? {
        grade,
        confidence: 1,
        defects: [],
        notes: "Graded by hand by the store.",
        conclusive: true,
        provisional: false,
        source: "manual",
        by: "staff",
        at,
      }
    : {
        grade,
        confidence: 0,
        defects: [],
        notes: "Picked by the seller — provisional until the store checks the phone.",
        conclusive: false,
        provisional: true,
        source: "manual",
        by: "seller",
        at,
      };
}

export const isCosmeticTier = (g: string): boolean => (COSMETIC_TIERS as readonly string[]).includes(g);

type Lens = Record<string, unknown> & { id?: unknown; state?: unknown; by?: unknown; name?: unknown };

const lensList = (camera: Record<string, unknown> | null | undefined): Lens[] =>
  Array.isArray(camera?.lenses) ? (camera!.lenses as Lens[]).filter(isPlainObject) : [];

/** Worse → better, for the monotonic checks. */
const RANK: Record<string, number> = { fail: 0, skip: 1, pass: 2 };

/**
 * The camera result the lens record supports, or null with no lens list: any
 * faulty lens fails the camera, any lens still unproven caps it at "skip" —
 * the same rule DeviceTest and /lens-verify use to derive it.
 */
export function cameraCeiling(lenses: { state?: unknown }[]): FnValue | null {
  if (!lenses.length) return null;
  if (lenses.some((l) => l.state === "fail")) return "fail";
  if (lenses.some((l) => l.state === "manual")) return "skip";
  return "pass";
}

/** Only staff (operator) or /lens-verify (vision) decide a lens with these stamps. */
const isDecided = (by: unknown): by is "operator" | "vision" => by === "operator" || by === "vision";
const decidedBy = (by: "operator" | "vision") => (by === "operator" ? "a staff decision" : "the photo check's verdict");

/**
 * Why a caller without staff may not replace the stored lens `was` with `now`
 * (null = they may). For a trusted caller the same reasons are the overrides
 * written to the event trail.
 */
function lensChange(id: string, was: Lens | undefined, now: Lens): string | null {
  // A person at the counter (operator) or the photo check (vision) decided it:
  // only staff write the first, only /lens-verify the second.
  if (isDecided(now.by) && !(was && was.by === now.by && was.state === now.state)) return `lens ${id}: ${now.by} stamp`;
  if (!was) return null;
  if (was.state === "fail" && now.state !== "fail") return `lens ${id}: fail → ${String(now.state)}`;
  // A decided lens may only be reported worse — never better, never vaguer.
  if (isDecided(was.by) && now.state !== "fail" && (now.state !== was.state || now.by !== was.by)) {
    return `lens ${id}: changes ${decidedBy(was.by)}`;
  }
  // "manual" is a lens the browser could not open (a Pro iPhone exposes one
  // rear camera for three lenses). A browser stamp cannot pass it: only a lens
  // the browser itself measured before (by:"browser") may come back as a pass.
  if (was.state === "manual" && now.state === "pass" && was.by !== "browser") {
    return `lens ${id}: manual → pass (the browser cannot test this lens)`;
  }
  return null;
}

/** Why leaving the stored lens out of a write matters (null = it does not). */
function lensDrop(id: string, was: Lens): string | null {
  if (was.state === "fail") return `lens ${id}: fail → removed`;
  if (isDecided(was.by)) return `lens ${id}: drops ${decidedBy(was.by)}`;
  if (was.state === "manual") return `lens ${id}: manual → removed`;
  return null;
}

const lensLabel = (l: Lens | undefined, id: string) => `${String(l?.name || id)} lens`;

/**
 * Judge one /functional write.
 *
 * Returns what to store (the merged results and camera record) or, only when
 * the session is final, why nothing may change. `trusted` is a staff sign-in
 * or SwapUp's server key: it may do anything, and what would have been kept
 * from anyone else comes back in `overrides` so the route can log it.
 *
 * For everyone else the write is judged PER RESULT, not as a whole. A refused
 * result keeps the stored value and everything else in the write saves — so a
 * self-test re-run, where one test that failed before now passes, still stores
 * every other result and the camera detail. What is kept is listed in
 * `refused` (and `kept`, in plain words, for the seller):
 *   • a recorded FAIL stays a fail: fail→pass, fail→skip, or the test dropped
 *     by a non-merge write. Skip is not milder than fail here — it removes the
 *     repair deduction just the same;
 *   • a failed lens stays failed;
 *   • a lens stamped "operator" or "vision" that the record does not already
 *     hold is not taken: the first is a person at the counter, the second only
 *     /lens-verify writes;
 *   • a lens staff or the photo check decided may only be reported faulty;
 *   • a "manual" lens (one the browser could not open) cannot become a pass
 *     unless the browser itself measured it before;
 *   • no lens on record is dropped — a write that leaves one out keeps it;
 *   • the camera result cannot be raised above what the lens record supports
 *     (a lens still unchecked caps it at "skip").
 * And 409 for any write once the session is final (accepted / payout / purchase
 * committed): nothing changes then.
 * New results, skip→pass, pass→fail and the phone's own browser measurements
 * all still save — that is the self-test.
 */
export function checkFunctionalWrite(input: {
  stored: Record<string, string>;
  storedCamera: Record<string, unknown> | null;
  incoming: Record<string, FnValue>;
  merge: boolean;
  camera: Record<string, unknown> | null;
  trusted: boolean;
  lock: string | null;
}):
  | {
      ok: true;
      results: Record<string, string>;
      camera: Record<string, unknown>;
      overrides: string[];
      refused: string[];
      kept: string[];
      ignored: string[];
    }
  | (Refusal & { changes: string[] }) {
  const stored = input.stored || {};
  const storedCamera = input.storedCamera || {};
  const trusted = input.trusted;

  if (!trusted && input.lock) {
    return {
      ok: false,
      status: 409,
      code: "final",
      error: "This check is final — the offer was accepted. Ask the store to change a result.",
      changes: [`final (${input.lock})`],
    };
  }

  const results: Record<string, string> = input.merge ? { ...stored, ...input.incoming } : { ...input.incoming };
  /** Trusted: what was overridden. Anyone else: what was kept as it was. */
  const changes: string[] = [];
  const kept: string[] = [];
  const note = (change: string, label: string) => {
    changes.push(change);
    if (!kept.includes(label)) kept.push(label);
  };

  const testLabel = (k: string) => testById(k)?.name || k;
  for (const [k, v] of Object.entries(stored)) {
    if (v !== "fail" || results[k] === "fail") continue;
    const why = `${k}: fail → ${results[k] ?? "removed"}`;
    if (trusted) changes.push(why);
    else {
      note(why, testLabel(k));
      results[k] = "fail";
    }
  }

  const ignored: string[] = [];
  let camera: Record<string, unknown> = { ...storedCamera };
  if (input.camera) {
    const inc = { ...input.camera };
    // Dropped for staff too: the report re-sends the copy it rendered, and a
    // stale copy must not overwrite an assessment that landed since.
    for (const k of SERVER_OWNED_CAMERA_KEYS) {
      if (k in inc) {
        delete inc[k];
        ignored.push(`camera.${k}`);
      }
    }
    // MERGE, never replace: /camera-frames and /camera-assess write into the
    // same record, and whichever lands second must not erase the other.
    camera = { ...storedCamera, ...inc };

    if (Array.isArray(input.camera.lenses)) {
      const before = lensList(storedCamera);
      const byId = new Map(before.map((l) => [String(l.id), l]));
      const incoming = lensList(input.camera);
      const seen = new Set<string>();
      const lenses: Lens[] = [];
      for (const now of incoming) {
        const id = String(now.id);
        if (seen.has(id)) continue; // one entry per lens
        seen.add(id);
        const was = byId.get(id);
        const why = lensChange(id, was, now);
        if (!why) {
          // An unchanged decided lens keeps the stored entry whole (its reason
          // and findings — the report re-sends a copy without them); anything
          // else is the new reading.
          lenses.push(was && isDecided(was.by) && was.by === now.by && was.state === now.state ? was : now);
        } else if (trusted) {
          changes.push(why);
          lenses.push(now);
        } else {
          note(why, lensLabel(was ?? now, id));
          if (was) lenses.push(was);
        }
      }
      for (const was of before) {
        const id = String(was.id);
        if (seen.has(id)) continue;
        const why = lensDrop(id, was);
        if (trusted) {
          if (why) changes.push(why); // staff may drop it: their list stands
        } else {
          if (why) note(why, lensLabel(was, id));
          lenses.push(was); // nothing on record is dropped without staff
        }
      }
      camera.lenses = lenses;
    }
    if (Array.isArray(camera.lenses)) {
      // Counts follow the lenses actually stored — never a client's tally.
      const ls = lensList(camera);
      camera.expected = ls.length;
      camera.verified = ls.filter((l) => l.state === "pass").length;
      camera.manual = ls.filter((l) => l.state === "manual").length;
      camera.failed = ls.filter((l) => l.state === "fail").length;
    }
  }

  // The camera result follows the lens record: a seller cannot mark "camera
  // working" while a lens is still unchecked (the same bypass as passing the
  // lens itself). Only a CHANGE is judged — re-sending the stored value is not.
  const want = results.camera;
  const ceiling = cameraCeiling(lensList(camera));
  if (
    !trusted &&
    want !== undefined &&
    want !== stored.camera &&
    ceiling &&
    RANK[want] > RANK[ceiling] &&
    (stored.camera === undefined || RANK[want] > RANK[stored.camera])
  ) {
    const keep = stored.camera ?? ceiling;
    note(`camera: ${want} → ${keep} (${ceiling === "fail" ? "a lens is faulty" : "lenses not all verified"})`, testLabel("camera"));
    results.camera = keep;
  }

  return {
    ok: true,
    results,
    camera,
    overrides: trusted ? [...(input.lock ? [`final (${input.lock})`] : []), ...changes] : [],
    refused: trusted ? [] : changes,
    kept: trusted ? [] : kept,
    ignored,
  };
}

/** What the seller is told when part of a write was kept as it was (plain words). */
export function keptNotice(kept: string[]): string | null {
  if (!kept.length) return null;
  const list = kept.length === 1 ? kept[0] : `${kept.slice(0, -1).join(", ")} and ${kept[kept.length - 1]}`;
  return `Saved — except ${list}, kept as recorded before. Only the store can change ${kept.length === 1 ? "that result" : "those results"}.`;
}
