// Did the phone that STARTED the session end up being the phone that was TESTED?
//
// A GradeIQ session legitimately involves two devices: the handset under test,
// and a second phone whose camera photographs it. So the three records on a
// session should read:
//
//   session started on          ─┐ the same handset
//   device under test (self-reported) ─┘
//   camera device                 a different one
//
// If rows 1 and 3 disagree, someone opened the session on one phone and ran the
// tests on another — which is the shape of a swap: quote the good handset, grade
// the bad one, or vice versa.
//
// WHY NOT IP. Two of the three records come from mobile networks, so their IPs
// differ by carrier NAT and mean nothing (one real session shows 166.198.x on
// the first and 107.116.x on the second — same person, same room). And the
// self-reported record has no IP at all; it never made its own request. IP
// cannot answer this question and using it would produce constant false alarms.
//
// So the comparison is on what identifies the HARDWARE and its software build:
// the model where the platform will tell us, the OS, the exact browser build,
// and the screen geometry.
//
// HONEST LIMIT, stated up front: two identical handsets on the same OS and
// browser build are indistinguishable here. This detects a swap to a DIFFERENT
// phone, not a swap to an identical one. Nothing available in a browser closes
// that gap, and claiming otherwise would be worse than the limitation.

export type DeviceSig = {
  /**
   * The per-browser token (lib/deviceToken.ts) — the one signal that can tell
   * two identical handsets apart. Absent on privacy-hardened browsers and on
   * every record captured before it existed.
   */
  token?: string;
  ua?: string;
  parsed?: { kind?: string; os?: string; browser?: string; model?: string };
  /** e.g. "412x960" — CSS viewport, self-reported by the device under test. */
  screen?: string;
  platform?: string;
  /** Model resolved from a Client Hint / viewport lookup rather than the UA. */
  model?: { label?: string } | null;
};

export type DeviceMatch = {
  verdict: "same" | "different" | "unknown";
  /** Human-readable evidence, strongest first. */
  reasons: string[];
};

const norm = (s?: string) => (s || "").trim().toLowerCase();

/** The hardware model, from whichever source has one. */
function modelOf(d?: DeviceSig): string {
  return norm(d?.parsed?.model || d?.model?.label || "");
}

/** Browser family + MAJOR version — one handset cannot run two builds at once. */
function browserOf(d?: DeviceSig): string {
  return norm(d?.parsed?.browser);
}

function osOf(d?: DeviceSig): string {
  return norm(d?.parsed?.os);
}

function screenOf(d?: DeviceSig): string {
  return norm(d?.screen).replace(/\s/g, "");
}

/**
 * Compare two device records.
 *
 * Any single hard disagreement is enough to call them different — these are
 * facts about one physical handset at one moment, so they cannot legitimately
 * conflict. Agreement is only claimed when at least one meaningful signal was
 * actually comparable; matching on "both are smartphones" is not evidence.
 */
export function compareDevices(a?: DeviceSig, b?: DeviceSig): DeviceMatch {
  if (!a || !b) return { verdict: "unknown", reasons: ["One of the two devices was never recorded."] };

  /* THE TOKEN OUTRANKS EVERYTHING — in ONE direction.
   *
   * A matching token means the same browser made both requests, which no
   * amount of identical user-agent strings could ever establish. It settles the
   * case the UA comparison had to give up on: two iPhones on the same iOS and
   * Safari build.
   *
   * A DIFFERING token is deliberately not treated as proof of a swap here. It
   * is also what private browsing, cleared site data, or opening the QR in a
   * second browser on the SAME phone produces. So it falls through to the
   * hardware comparison below and is reported as corroboration, not as the
   * verdict — the difference between "a different phone" and "a different
   * browser" is exactly the kind of thing this check must not blur. */
  const ta = String(a.token || "").trim();
  const tb = String(b.token || "").trim();
  if (ta && tb && ta === tb) {
    return {
      verdict: "same",
      reasons: ["same browser token — the same browser made both requests"],
    };
  }

  const reasons: string[] = [];
  let compared = 0;

  const pairs: { name: string; a: string; b: string; strong: boolean }[] = [
    { name: "model", a: modelOf(a), b: modelOf(b), strong: true },
    { name: "OS", a: osOf(a), b: osOf(b), strong: true },
    { name: "screen", a: screenOf(a), b: screenOf(b), strong: true },
    // A phone runs ONE browser build at a time, so differing majors mean two
    // installs — but it is listed last because a mid-session update, however
    // unlikely, is at least imaginable.
    { name: "browser", a: browserOf(a), b: browserOf(b), strong: false },
  ];

  const differing: string[] = [];
  for (const p of pairs) {
    if (!p.a || !p.b) continue;
    compared++;
    if (p.a !== p.b) differing.push(`${p.name}: ${p.a} vs ${p.b}`);
  }

  const tokensDiffer = !!ta && !!tb && ta !== tb;

  if (differing.length) {
    // Hardware disagrees. A differing token corroborates it; say so.
    return {
      verdict: "different",
      reasons: tokensDiffer ? [...differing, "different browser token"] : differing,
    };
  }

  /* Hardware is indistinguishable but the tokens differ. Two identical handsets
     is the obvious reading — and so is one phone whose browser data was
     cleared. Neither can be ruled out, so this is reported as unresolved rather
     than decided, with the ambiguity named. */
  if (tokensDiffer) {
    return {
      verdict: "unknown",
      reasons: [
        "different browser token, but every hardware signal matches",
        "either two identical handsets, or the same phone in a second browser / after clearing site data",
      ],
    };
  }
  if (compared === 0) {
    return { verdict: "unknown", reasons: ["Neither record carries a comparable signal."] };
  }
  for (const p of pairs) if (p.a && p.b) reasons.push(`${p.name} matches (${p.a})`);
  return { verdict: "same", reasons };
}

/**
 * The session-level check: rows 1 and 3 must be one handset, row 2 a different
 * one. Returns only what is genuinely determinable.
 */
export function checkSessionDevices(input: {
  origin?: DeviceSig;
  camera?: DeviceSig;
  reported?: DeviceSig;
}): {
  underTest: DeviceMatch;
  cameraSeparate: DeviceMatch;
  concern: boolean;
  summary: string;
} {
  const underTest = compareDevices(input.origin, input.reported);
  const cameraSeparate = compareDevices(input.origin, input.camera);

  // ONLY a proven mismatch between the starting phone and the tested phone is a
  // concern. "unknown" is not a finding — most sessions simply do not carry
  // enough signal, and flagging those would bury the real ones.
  const concern = underTest.verdict === "different";

  const summary = concern
    ? "The session was started on a different phone from the one that was tested."
    : underTest.verdict === "same"
      ? cameraSeparate.verdict === "same"
        ? "Started and tested on the same phone — but the camera device looks like that same phone too."
        : "Started and tested on the same phone, photographed by a second device."
      : "Not enough signal to confirm the phone that was tested is the one the session started on.";

  return { underTest, cameraSeparate, concern, summary };
}
