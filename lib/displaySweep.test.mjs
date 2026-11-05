// SUP-264 — the screen sweep tries a missed colour again, and judges black and
// green against the white frame it locked on.
//
// Field test 25 Oct (SU-AND-00048): 4 of 6 colours confirmed, black and green
// missing; 7 of the 9 SwapUp sweeps since 17 Oct were incomplete. These tests
// pin lib/displaySweep.ts:
//   • glare on a black screen (every channel lifted well above the absolute 95)
//     and a dim green screen now match against white, while stripes, white, a
//     tinted frame, blue and red never count as black, and no frame dark enough
//     to be black ever counts as green;
//   • the relative rules apply only on a try whose echo arrived — the phone said
//     it was showing that colour;
//   • with no white reference every pattern matches exactly as it always did;
//   • sweepColour retries up to twice on the same lock, inside the budget, and
//     still looks when the phone's echo never comes;
//   • what the camera saw of a missed colour is kept, cleaned, for calibration.

import assert from "node:assert/strict";

const {
  matchesPattern,
  matchesOnTry,
  blackAgainstWhite,
  greenAgainstWhite,
  retryHint,
  cleanSweepStats,
  exposureHoldKept,
  heldExposureConstraints,
  EXPOSURE_SETTLE_MS,
  EXPOSURE_MAX_SHIFT,
  sweepColour,
  retryBudgetLeftMs,
  sweepTiming,
  withHeldExposure,
  luminance,
  SWEEP_WHITE_ECHO_MS,
  SWEEP_ECHO_MS,
  SWEEP_MATCH_MS,
  SWEEP_RETRIES,
  SWEEP_RETRY_BUDGET_MS,
  SWEEP_TRY_MS,
  SWEEP_ECHO_MS_BEFORE,
  PHONE_GRACE_AFTER_COSMETIC_MS,
  PHONE_GRACE_MARGIN_MS,
  BLACK_REL,
  BLACK_MAX_SPREAD,
  STRIPES_MIN_SD,
  GREEN_REL,
  GREEN_MIN_LEAD,
  GREEN_MIN_REL_G,
} = await import("./displaySweep.ts");

let pass = 0;
const t = async (name, fn) => {
  try {
    await fn();
    console.log("  ok  ", name);
    pass++;
  } catch (e) {
    console.log("  FAIL", name, "\n       ", e.stack || e.message);
    process.exitCode = 1;
  }
};

const rgb = (r, g, b, sd = 4) => ({ r, g, b, sd });
const BRIGHT_WHITE = rgb(250, 252, 255);
const DIM_WHITE = rgb(230, 200, 220);

/** The absolute rules exactly as V2Cam had them at 6aa0726 (V2Cam.tsx:271-286). */
function before(st, p) {
  const { r, g, b, sd } = st;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  switch (p) {
    case "white":  return mn > 130 && mx - mn < 70;
    case "gray":   return mn > 60 && mx < 200 && mx - mn < 50;
    case "red":    return r > g + 35 && r > b + 35;
    case "green":  return g > r + 30 && g > b + 30;
    case "blue":   return b > r + 30 && b > g + 30;
    case "black":  return mx < 95;
    case "stripes": return sd > 32;
    default: return true;
  }
}

console.log("the constants");

await t("timings and thresholds are the ones the issue sets", () => {
  assert.equal(SWEEP_WHITE_ECHO_MS, 4000);
  assert.equal(SWEEP_ECHO_MS, 4000);
  assert.equal(SWEEP_MATCH_MS, 4000);
  assert.equal(SWEEP_RETRIES, 2);
  assert.equal(SWEEP_RETRY_BUDGET_MS, 60000);
  assert.equal(SWEEP_TRY_MS, 8000);
  assert.equal(BLACK_REL, 0.48);
  assert.equal(BLACK_MAX_SPREAD, 40);
  assert.equal(STRIPES_MIN_SD, 32);
  assert.equal(GREEN_REL, 1.15);
  assert.equal(GREEN_MIN_LEAD, 10);
  assert.equal(GREEN_MIN_REL_G, 0.35);
});

console.log("black against the white frame");

await t("neutral glare on black: every channel above 95 fails the absolute rule, passes against white", () => {
  // Glare lifts all three channels of a black screen together. The rule at
  // a8689dc (luminance <= 0.35 x white) could never pass these: its cut-off is
  // at most 89 and the luminance of a frame is never below its smallest channel.
  const glare = [
    [rgb(110, 110, 110), rgb(235, 235, 235)],
    [rgb(110, 108, 112), BRIGHT_WHITE],
    [rgb(96, 96, 96), rgb(255, 255, 255)],
    [rgb(100, 100, 100), rgb(250, 250, 250)],
    [rgb(92, 94, 99), rgb(255, 255, 255)],
    [rgb(120, 118, 125), rgb(255, 255, 255)],
  ];
  for (const [frame, white] of glare) {
    assert.ok(Math.min(frame.r, frame.g, frame.b) >= 92, "a lifted frame");
    assert.equal(matchesPattern(frame, "black"), false, `${JSON.stringify(frame)} absolute`);
    assert.equal(before(frame, "black"), false);
    assert.equal(matchesPattern(frame, "black", white), true, `${JSON.stringify(frame)} vs ${JSON.stringify(white)}`);
  }
});

await t("a red-cast dark frame (one channel above 95) passes against white", () => {
  const frame = rgb(98, 80, 78);
  assert.ok(Math.abs(luminance(BRIGHT_WHITE) - 251.7) < 0.1);
  assert.ok(luminance(frame) < BLACK_REL * luminance(BRIGHT_WHITE));
  assert.equal(matchesPattern(frame, "black"), false);
  assert.equal(before(frame, "black"), false);
  assert.equal(matchesPattern(frame, "black", BRIGHT_WHITE), true);
});

await t("stripes, a mid grey and the white itself are never black against white", () => {
  for (const white of [rgb(235, 235, 235), BRIGHT_WHITE, rgb(255, 255, 255), DIM_WHITE]) {
    // Bands: the mean sits near half of white, but the box holds contrast.
    assert.equal(matchesPattern(rgb(110, 110, 110, 40), "black", white), false, `stripes vs ${JSON.stringify(white)}`);
    assert.equal(matchesPattern(rgb(100, 100, 100, STRIPES_MIN_SD + 1), "black", white), false);
    // The phone's #808080 reads at about half of its white.
    assert.equal(matchesPattern(rgb(128, 128, 128), "black", white), false, `grey vs ${JSON.stringify(white)}`);
    assert.equal(matchesPattern(white, "black", white), false);
  }
});

await t("a tinted frame is not black against white (the spread guard)", () => {
  assert.equal(matchesPattern(rgb(120, 100, 70), "black", rgb(255, 255, 255)), false);
  assert.equal(matchesPattern(rgb(70, 100, 120), "black", rgb(255, 255, 255)), false);
});

await t("a blue frame and a red frame are never black (the spread guard)", () => {
  for (const frame of [rgb(40, 60, 200), rgb(200, 40, 40)]) {
    // Both are dark enough on luminance alone — the channel spread is what refuses them.
    assert.ok(luminance(frame) <= BLACK_REL * luminance(BRIGHT_WHITE));
    assert.equal(matchesPattern(frame, "black", BRIGHT_WHITE), false);
    assert.equal(matchesPattern(frame, "black", DIM_WHITE), false);
    assert.equal(matchesPattern(frame, "black"), false);
  }
});

await t("white and a mid grey are not black against white", () => {
  assert.equal(matchesPattern(BRIGHT_WHITE, "black", BRIGHT_WHITE), false);
  assert.equal(matchesPattern(rgb(128, 128, 128), "black", BRIGHT_WHITE), false);
});

await t("a white reference with no light in it never makes anything black", () => {
  assert.equal(matchesPattern(rgb(120, 118, 119), "black", rgb(0, 0, 0)), false);
});

console.log("green against the white frame");

await t("dim green: fails the absolute rule, passes against white", () => {
  const frame = rgb(110, 150, 120);
  assert.equal(matchesPattern(frame, "green"), false);
  assert.equal(before(frame, "green"), false);
  assert.equal(matchesPattern(frame, "green", DIM_WHITE), true);
});

await t("not green: the white frame itself, and a dark noisy frame", () => {
  assert.equal(matchesPattern(DIM_WHITE, "green", DIM_WHITE), false);
  assert.equal(matchesPattern(BRIGHT_WHITE, "green", BRIGHT_WHITE), false);
  const noisy = rgb(30, 38, 32);
  assert.equal(matchesPattern(noisy, "green", DIM_WHITE), false);
  assert.equal(matchesPattern(noisy, "green", BRIGHT_WHITE), false);
});

await t("blue and red are not green against white", () => {
  assert.equal(matchesPattern(rgb(40, 60, 200), "green", DIM_WHITE), false);
  assert.equal(matchesPattern(rgb(200, 40, 40), "green", DIM_WHITE), false);
});

await t("a dark frame is never green against white — it is black, not green", () => {
  // A green-tinted dark frame (the phone's bezel, a green mat under a held
  // exposure) read at 14-22% of white's green; a8689dc counted all three as
  // green AND black.
  const white = rgb(230, 235, 232, 3);
  for (const frame of [rgb(20, 45, 30), rgb(40, 52, 40), rgb(20, 32, 20)]) {
    assert.equal(matchesPattern(frame, "green", white), false, `${JSON.stringify(frame)} green`);
    assert.equal(matchesPattern(frame, "black", white), true, `${JSON.stringify(frame)} black`);
  }
});

await t("no frame counts as black and green against the same white", () => {
  const whites = [BRIGHT_WHITE, DIM_WHITE, rgb(255, 255, 255), rgb(235, 238, 240), rgb(200, 205, 210), rgb(150, 145, 140)];
  let checked = 0;
  for (const white of whites) {
    const cut = BLACK_REL * luminance(white);
    for (let r = 0; r <= 255; r += 5) for (let g = 0; g <= 255; g += 5) for (let b = 0; b <= 255; b += 5) {
      const f = rgb(r, g, b);
      const green = greenAgainstWhite(f, white);
      if (green) assert.ok(luminance(f) > cut, `${JSON.stringify(f)} is green at or below the black cut-off`);
      assert.equal(green && blackAgainstWhite(f, white), false, `${JSON.stringify(f)} vs ${JSON.stringify(white)}`);
      checked++;
    }
  }
  assert.ok(checked > 100000);
});

await t("green against white always reads at least 35% of white's green", () => {
  const whites = [rgb(230, 235, 232, 3), BRIGHT_WHITE, DIM_WHITE, rgb(150, 145, 140), rgb(120, 255, 120)];
  for (const white of whites) {
    for (let r = 0; r <= 255; r += 5) for (let g = 0; g <= 255; g += 5) for (let b = 0; b <= 255; b += 5) {
      const f = rgb(r, g, b);
      if (greenAgainstWhite(f, white)) assert.ok(g / white.g >= GREEN_MIN_REL_G, `${JSON.stringify(f)} vs ${JSON.stringify(white)}`);
    }
  }
});

console.log("the relative rules only on an echoed try");

await t("matchesOnTry: the relative rules apply only when the phone echoed this colour", () => {
  const glare = rgb(110, 110, 110);
  const white = rgb(235, 235, 235);
  assert.equal(matchesOnTry(glare, "black", white, true), true);
  assert.equal(matchesOnTry(glare, "black", white, false), false);
  const dimGreen = rgb(110, 150, 120);
  assert.equal(matchesOnTry(dimGreen, "green", DIM_WHITE, true), true);
  assert.equal(matchesOnTry(dimGreen, "green", DIM_WHITE, false), false);
  // The absolute rules hold whatever the echo did.
  assert.equal(matchesOnTry(rgb(20, 20, 20), "black", white, false), true);
  assert.equal(matchesOnTry(rgb(60, 200, 60), "green", white, false), true);
  assert.equal(matchesOnTry(white, "white", white, false), true);
});

console.log("the hint on a retry");

await t("a black retry says how to beat the glare; other colours say hold steady", () => {
  assert.equal(retryHint("black"), "Tilt the phone away from the light — trying black again");
  assert.equal(retryHint("green"), "Trying green again — hold steady");
  assert.equal(retryHint("stripes"), "Trying stripes again — hold steady");
});

console.log("nothing that matched before stops matching");

const CASES = [
  rgb(255, 255, 255), rgb(200, 190, 180), rgb(140, 135, 131), rgb(250, 252, 255),
  rgb(128, 128, 128), rgb(70, 70, 70), rgb(190, 195, 199),
  rgb(210, 60, 60), rgb(160, 120, 120), rgb(200, 40, 40),
  rgb(60, 200, 60), rgb(110, 150, 120), rgb(90, 125, 94),
  rgb(40, 60, 200), rgb(60, 70, 150), rgb(20, 20, 20), rgb(94, 90, 92), rgb(98, 80, 78), rgb(30, 38, 32),
  rgb(128, 128, 128, 40), rgb(128, 128, 128, 10), rgb(0, 0, 0, 0),
];
const PATTERNS = ["white", "gray", "red", "green", "blue", "black", "stripes", "checker"];

await t("with no white reference, every pattern matches exactly as before", () => {
  for (const st of CASES) {
    for (const p of PATTERNS) {
      assert.equal(matchesPattern(st, p), before(st, p), `${p} on ${JSON.stringify(st)}`);
      assert.equal(matchesPattern(st, p, null), before(st, p), `${p} on ${JSON.stringify(st)} (null ref)`);
    }
  }
});

await t("with a white reference, an earlier match is never lost — and only black/green can gain", () => {
  for (const white of [BRIGHT_WHITE, DIM_WHITE]) {
    for (const st of CASES) {
      for (const p of PATTERNS) {
        const was = before(st, p);
        const now = matchesPattern(st, p, white);
        if (was) assert.equal(now, true, `${p} on ${JSON.stringify(st)} lost against ${JSON.stringify(white)}`);
        if (p !== "black" && p !== "green") assert.equal(now, was, `${p} changed on ${JSON.stringify(st)}`);
      }
    }
  }
});

console.log("sweepColour (fake clock)");

/** A scripted sweep: `looks` answers each look in turn; the clock advances by what each wait used. */
function scripted({ looks, echo = true, budgetLeftMs = SWEEP_RETRY_BUDGET_MS, retries }) {
  let clock = 0;
  const log = [];
  let n = 0;
  const io = {
    now: () => clock,
    post: async () => {
      log.push("post");
    },
    waitEcho: async (ms) => {
      log.push(`echo:${ms}`);
      clock += echo ? 300 : ms;
      return echo;
    },
    look: async (ms) => {
      const hit = looks[n++] ?? false;
      log.push(`look:${ms}:${hit ? "hit" : "miss"}`);
      clock += hit ? 500 : ms;
      return hit;
    },
    onRetry: (attempt) => log.push(`retry:${attempt}`),
    budgetLeftMs,
    ...(retries === undefined ? {} : { retries }),
  };
  return { io, log, clock: () => clock };
}

await t("each look is told whether that try's echo arrived", async () => {
  let n = 0;
  const echoes = [false, true, false];
  const seen = [];
  const r = await sweepColour({
    now: () => 0,
    post: async () => {},
    waitEcho: async () => echoes[n++],
    look: async (ms, echoed) => (seen.push(echoed), false),
    budgetLeftMs: SWEEP_RETRY_BUDGET_MS,
  });
  assert.deepEqual(seen, [false, true, false]);
  assert.deepEqual(r, { captured: false, attempts: 3, echoed: true });
});

await t("seen on the first try: one post, one look", async () => {
  const s = scripted({ looks: [true] });
  const r = await sweepColour(s.io);
  assert.deepEqual(r, { captured: true, attempts: 1, echoed: true });
  assert.deepEqual(s.log, ["post", "echo:4000", "look:4000:hit"]);
});

await t("miss, miss, hit → captured on the 3rd try, with 3 posts", async () => {
  const s = scripted({ looks: [false, false, true] });
  const r = await sweepColour(s.io);
  assert.deepEqual(r, { captured: true, attempts: 3, echoed: true });
  assert.equal(s.log.filter((x) => x === "post").length, 3);
  assert.deepEqual(s.log, [
    "post", "echo:4000", "look:4000:miss",
    "retry:2", "post", "echo:4000", "look:4000:miss",
    "retry:3", "post", "echo:4000", "look:4000:hit",
  ]);
});

await t("never seen: three tries, then it gives up", async () => {
  const s = scripted({ looks: [false, false, false, true] });
  const r = await sweepColour(s.io);
  assert.deepEqual(r, { captured: false, attempts: 3, echoed: true });
  assert.equal(s.log.filter((x) => x.startsWith("look")).length, 3);
});

await t("a spent budget → one try only", async () => {
  for (const left of [0, -5000]) {
    const s = scripted({ looks: [false, true], budgetLeftMs: left });
    const r = await sweepColour(s.io);
    assert.deepEqual(r, { captured: false, attempts: 1, echoed: true });
    assert.deepEqual(s.log, ["post", "echo:4000", "look:4000:miss"]);
  }
});

await t("the budget runs out mid-colour: the try under way finishes, no new one starts", async () => {
  // 5 s left: the first try (0.3 s echo + 4 s look) leaves 0.7 s, so one
  // retry starts; after it 8.6 s have gone, so there is no third.
  const s = scripted({ looks: [false, false, true], budgetLeftMs: 5000 });
  const r = await sweepColour(s.io);
  assert.deepEqual(r, { captured: false, attempts: 2, echoed: true });
  assert.equal(s.log.filter((x) => x === "post").length, 2);
});

await t("an echo that never comes → it still looks on every try, and returns false", async () => {
  const s = scripted({ looks: [false, false, false], echo: false });
  const r = await sweepColour(s.io);
  assert.deepEqual(r, { captured: false, attempts: 3, echoed: false });
  assert.equal(s.log.filter((x) => x.startsWith("look")).length, 3);
  assert.equal(s.log.filter((x) => x === "echo:4000").length, 3);
});

await t("no echo but the screen is right → captured", async () => {
  const s = scripted({ looks: [true], echo: false });
  assert.deepEqual(await sweepColour(s.io), { captured: true, attempts: 1, echoed: false });
});

await t("retries: 0 is today's single try", async () => {
  const s = scripted({ looks: [false, true], retries: 0 });
  assert.deepEqual(await sweepColour(s.io), { captured: false, attempts: 1, echoed: true });
});

/** A whole sweep the way V2Cam runs it; `hitAt[i]` = the try colour i is seen on (0 = never). */
async function wholeSweep(hitAt, { echoMs = 300, hitMs = 500 } = {}) {
  let clock = 0;
  const lockAt = clock;
  const tries = [];
  for (let i = 0; i < hitAt.length; i++) {
    let n = 0;
    const r = await sweepColour({
      now: () => clock,
      post: async () => {},
      waitEcho: async (ms) => ((clock += hitAt[i] ? echoMs : ms), !!hitAt[i]),
      look: async (ms) => {
        n++;
        const hit = hitAt[i] === n;
        clock += hit ? hitMs : ms;
        return hit;
      },
      budgetLeftMs: retryBudgetLeftMs(clock - lockAt, hitAt.length - i - 1),
    });
    tries.push(r.attempts);
  }
  return { ms: clock, tries };
}

await t("worst case for a six-colour sweep stays within about 68 s of the lock", async () => {
  const { ms } = await wholeSweep([0, 0, 0, 0, 0, 0]);
  assert.ok(ms <= SWEEP_RETRY_BUDGET_MS + SWEEP_TRY_MS, `took ${ms} ms`);
  assert.ok(ms >= 6 * SWEEP_TRY_MS, `took ${ms} ms — every colour gets its first try`);
});

await t("a quick sweep with black and green missed at first retries both of them", async () => {
  // white, black (3rd try), stripes, red, green (2nd try), blue — the SU-AND-00048 order.
  const { ms, tries } = await wholeSweep([1, 3, 1, 1, 2, 1]);
  assert.deepEqual(tries, [1, 3, 1, 1, 2, 1]);
  assert.ok(ms < SWEEP_RETRY_BUDGET_MS, `took ${ms} ms`);
});

await t("retryBudgetLeftMs keeps a first try back for each colour still to come", () => {
  assert.equal(retryBudgetLeftMs(0, 0), 60000);
  assert.equal(retryBudgetLeftMs(10000, 0), 50000);
  assert.equal(retryBudgetLeftMs(1000, 4), 60000 - 1000 - 4 * 8000);
  assert.equal(retryBudgetLeftMs(1000, -1), 59000);
  assert.ok(retryBudgetLeftMs(70000, 0) < 0);
});

console.log("cosmeticDone before the sweep (gradeAtEnd off): the phone's 30 s grace");

await t("sweepTiming: the deferred journey keeps the full budget and the 4 s echo", () => {
  assert.deepEqual(sweepTiming(12345, null), { echoMs: SWEEP_ECHO_MS, tryMs: SWEEP_TRY_MS, budgetMs: SWEEP_RETRY_BUDGET_MS });
});

await t("sweepTiming: with cosmeticDone already set, 6aa0726's echo and retries only inside the grace", () => {
  assert.equal(PHONE_GRACE_AFTER_COSMETIC_MS, 30000);
  assert.equal(PHONE_GRACE_MARGIN_MS, 3000);
  assert.equal(SWEEP_ECHO_MS_BEFORE, 2600);
  // cosmeticDone at 0, lock at 3 s: the phone leaves at 30 s; keep 3 s back
  // and one whole try, so a retry that starts in time also ends in time.
  assert.deepEqual(sweepTiming(3000, 0), { echoMs: 2600, tryMs: 6600, budgetMs: 30000 - 3000 - 3000 - 6600 });
  // A late lock leaves no room: no retries at all.
  assert.ok(sweepTiming(25000, 0).budgetMs < 0);
});

/**
 * A whole sweep on a fake clock. `hitAt[i]` = the try colour i is seen on (0 =
 * never); the phone stops showing colours at `phoneLeavesAt`, after which
 * nothing is seen. `timing` null = 6aa0726: one try, a 2.6 s echo wait.
 * `echoOnMiss` false = the echo comes only on the try that sees the colour
 * (a late echo is why the others missed), so each missed try costs its full
 * echo wait.
 */
async function graceSweep(hitAt, { lockAt, phoneLeavesAt, timing, echoOnMiss = true }) {
  let clock = lockAt;
  const seen = [];
  for (let i = 0; i < hitAt.length; i++) {
    let n = 0;
    const r = await sweepColour({
      now: () => clock,
      post: async () => {},
      waitEcho: async (ms) => {
        const echo = !!hitAt[i] && (echoOnMiss || hitAt[i] === n + 1) && clock < phoneLeavesAt;
        clock += echo ? 300 : ms;
        return echo;
      },
      look: async (ms) => {
        n++;
        const hit = hitAt[i] === n && clock < phoneLeavesAt;
        clock += hit ? 500 : ms;
        return hit;
      },
      ...(timing
        ? {
            echoMs: timing.echoMs,
            budgetLeftMs: retryBudgetLeftMs(clock - lockAt, hitAt.length - i - 1, timing.tryMs, timing.budgetMs),
          }
        : { echoMs: 2600, retries: 0, budgetLeftMs: 0 }),
    });
    if (r.captured) seen.push(i);
  }
  return { end: clock, seen };
}

await t("the reviewer's case: black and stripes missed twice — the sweep now ends inside the grace", async () => {
  const cosmeticDoneAt = 0;
  const phoneLeavesAt = cosmeticDoneAt + PHONE_GRACE_AFTER_COSMETIC_MS;
  const hitAt = [1, 3, 3, 1, 1, 1];
  const lockAt = 3000;
  const opts = { lockAt, phoneLeavesAt, echoOnMiss: false };
  const now = await graceSweep(hitAt, { ...opts, timing: sweepTiming(lockAt, cosmeticDoneAt) });
  assert.ok(now.end <= phoneLeavesAt - PHONE_GRACE_MARGIN_MS, `ended at ${now.end}`);
  // Every colour that shows on its first try is still caught: white, red, green, blue.
  for (const i of [0, 3, 4, 5]) assert.ok(now.seen.includes(i), `colour ${i} lost`);
  // With a8689dc's timing (the deferred budget) the same sweep runs past the
  // grace: the phone has gone, and red, green and blue are lost.
  const full = await graceSweep(hitAt, { ...opts, timing: sweepTiming(lockAt, null) });
  assert.ok(full.end > phoneLeavesAt, `ended at ${full.end}`);
  assert.ok(full.seen.length < now.seen.length, `${full.seen} vs ${now.seen}`);
});

await t("every sweep that finished inside the grace at 6aa0726 still does, and loses no colour", async () => {
  const cosmeticDoneAt = 0;
  const phoneLeavesAt = PHONE_GRACE_AFTER_COSMETIC_MS;
  let compared = 0;
  for (const lockAt of [1000, 4000, 9000]) {
    const timing = sweepTiming(lockAt, cosmeticDoneAt);
    for (const echoOnMiss of [true, false]) {
      for (let code = 0; code < 4 ** 6; code++) {
        const hitAt = Array.from({ length: 6 }, (_, i) => Math.floor(code / 4 ** i) % 4);
        const old = await graceSweep(hitAt, { lockAt, phoneLeavesAt, echoOnMiss, timing: null });
        if (old.end > phoneLeavesAt) continue;
        const now = await graceSweep(hitAt, { lockAt, phoneLeavesAt, echoOnMiss, timing });
        assert.ok(now.end <= Math.max(old.end, phoneLeavesAt - PHONE_GRACE_MARGIN_MS), `${hitAt} ended ${now.end} vs ${old.end}`);
        for (const i of old.seen) assert.ok(now.seen.includes(i), `${hitAt}: colour ${i} lost`);
        compared++;
      }
    }
  }
  assert.ok(compared > 100, `only ${compared} sweeps compared`);
});

await t("retryBudgetLeftMs takes the try length and the budget of the timing in force", () => {
  assert.equal(retryBudgetLeftMs(1000, 2, 6600, 20000), 20000 - 1000 - 2 * 6600);
  assert.equal(retryBudgetLeftMs(1000, 2), SWEEP_RETRY_BUDGET_MS - 1000 - 2 * SWEEP_TRY_MS);
});

console.log("what the camera saw of a missed colour (calibration)");

await t("cleanSweepStats keeps rounded numbers, the pattern, the tries and the echo", () => {
  const out = cleanSweepStats({
    white: { r: 234.6, g: 236.2, b: 239.9, sd: 3.14 },
    misses: [{ pattern: "black", attempts: 3, echoed: true, seen: { r: 110.4, g: 108.6, b: 112, sd: 6.5 } }],
  });
  assert.deepEqual(out, {
    white: { r: 235, g: 236, b: 240, sd: 3 },
    misses: [{ pattern: "black", attempts: 3, echoed: true, seen: { r: 110, g: 109, b: 112, sd: 7 } }],
  });
});

await t("cleanSweepStats: out-of-range numbers are clamped, junk is dropped, the list is capped", () => {
  const out = cleanSweepStats({
    white: { r: 999, g: -4, b: "x", sd: 1 },
    misses: [
      ...Array.from({ length: 12 }, () => ({ pattern: "a-very-long-pattern-name", attempts: 99, echoed: "yes", seen: null })),
      "junk",
      null,
    ],
    extra: "dropped",
  });
  assert.equal(out.white, null, "a white with a non-number channel is not kept");
  assert.equal(out.misses.length, 8);
  assert.deepEqual(out.misses[0], { pattern: "a-very-long-", attempts: 10, echoed: false, seen: null });
  assert.equal("extra" in out, false);
  assert.deepEqual(cleanSweepStats({ white: { r: 999, g: -4, b: 10, sd: 1 }, misses: [] }).white, { r: 255, g: 0, b: 10, sd: 1 });
});

await t("cleanSweepStats: nothing usable → undefined", () => {
  for (const raw of [undefined, null, "x", 3, [], {}, { misses: "x" }, { white: null, misses: [] }]) {
    assert.equal(cleanSweepStats(raw), undefined, JSON.stringify(raw));
  }
});

console.log("exposure held during the colours");

await t("held → the colours run, then the exposure is given back", async () => {
  const log = [];
  const r = await withHeldExposure(
    async () => (log.push("hold"), true),
    async () => void log.push("release"),
    async () => (log.push("run"), 6)
  );
  assert.equal(r, 6);
  assert.deepEqual(log, ["hold", "run", "release"]);
});

await t("given back even when the sweep throws", async () => {
  const log = [];
  await assert.rejects(
    withHeldExposure(async () => true, async () => void log.push("release"), async () => {
      throw new Error("camera gone");
    }),
    /camera gone/
  );
  assert.deepEqual(log, ["release"]);
});

await t("not held (iOS Safari, no exposure API) → nothing to give back", async () => {
  const log = [];
  await withHeldExposure(async () => false, async () => void log.push("release"), async () => log.push("run"));
  assert.deepEqual(log, ["run"]);
});

console.log("the hold is checked against the locked white, and given back if it moved it");

await t("the hold's settle time and its allowed shift", () => {
  assert.equal(EXPOSURE_SETTLE_MS, 400);
  assert.equal(EXPOSURE_MAX_SHIFT, 0.25);
});

await t("exposureHoldKept: white still white and within 25% → kept", () => {
  const white = rgb(235, 235, 235);
  assert.equal(exposureHoldKept(white, white), true);
  assert.equal(exposureHoldKept(white, rgb(200, 202, 205)), true);
  assert.equal(exposureHoldKept(white, rgb(255, 255, 255)), true);
});

await t("exposureHoldKept: the driver's default ISO darkens white → not kept", () => {
  const white = rgb(235, 235, 235);
  // ~4x darker: no longer white at all.
  assert.equal(exposureHoldKept(white, rgb(70, 70, 72)), false);
  // Still reads as white, but 30% darker: the relative rules would be off.
  assert.equal(exposureHoldKept(white, rgb(160, 162, 165)), false);
  // Brighter by more than a quarter.
  assert.equal(exposureHoldKept(rgb(150, 150, 150), rgb(200, 200, 200)), false);
  // Nothing to compare.
  assert.equal(exposureHoldKept(white, null), false);
  assert.equal(exposureHoldKept(null, white), false);
  assert.equal(exposureHoldKept(rgb(0, 0, 0), white), false);
});

await t("verified → the colours run held, then the exposure is given back", async () => {
  const log = [];
  const r = await withHeldExposure(
    async () => (log.push("hold"), true),
    async () => void log.push("release"),
    async () => (log.push("run"), 6),
    async () => (log.push("verify"), true)
  );
  assert.equal(r, 6);
  assert.deepEqual(log, ["hold", "verify", "run", "release"]);
});

await t("the hold moved white → given back BEFORE the colours, which run on auto", async () => {
  const log = [];
  const r = await withHeldExposure(
    async () => (log.push("hold"), true),
    async () => void log.push("release"),
    async () => (log.push("run"), 4),
    async () => (log.push("verify"), false)
  );
  assert.equal(r, 4);
  assert.deepEqual(log, ["hold", "verify", "release", "run"]);
});

await t("a verify that throws counts as moved", async () => {
  const log = [];
  await withHeldExposure(
    async () => true,
    async () => void log.push("release"),
    async () => log.push("run"),
    async () => {
      throw new Error("camera gone");
    }
  );
  assert.deepEqual(log, ["release", "run"]);
});

await t("not held → nothing is verified", async () => {
  const log = [];
  await withHeldExposure(
    async () => false,
    async () => void log.push("release"),
    async () => log.push("run"),
    async () => (log.push("verify"), true)
  );
  assert.deepEqual(log, ["run"]);
});

await t("heldExposureConstraints: manual, with the exposure time and ISO in force at the lock", () => {
  const caps = { exposureMode: ["continuous", "manual"], exposureTime: { min: 1, max: 10000 }, iso: { min: 50, max: 3200 } };
  assert.deepEqual(heldExposureConstraints(caps, { exposureTime: 166.6, iso: 400 }), {
    exposureMode: "manual",
    exposureTime: 166.6,
    iso: 400,
  });
});

await t("heldExposureConstraints: a value the camera can't take, or doesn't report, is left out", () => {
  const caps = { exposureMode: ["manual"], exposureTime: { min: 1, max: 100 }, iso: { min: 50, max: 800 } };
  assert.deepEqual(heldExposureConstraints(caps, { exposureTime: 500, iso: 1600 }), { exposureMode: "manual" });
  assert.deepEqual(heldExposureConstraints(caps, {}), { exposureMode: "manual" });
  assert.deepEqual(heldExposureConstraints(caps, { exposureTime: "fast", iso: NaN }), { exposureMode: "manual" });
  assert.deepEqual(heldExposureConstraints({ exposureMode: ["manual"] }, { exposureTime: 30, iso: 0 }), {
    exposureMode: "manual",
    exposureTime: 30,
  });
});

await t("a hold or a release that throws never stops the sweep", async () => {
  const r = await withHeldExposure(
    async () => {
      throw new Error("applyConstraints refused");
    },
    async () => {
      throw new Error("never called");
    },
    async () => "swept"
  );
  assert.equal(r, "swept");
  assert.equal(await withHeldExposure(async () => true, async () => { throw new Error("release refused"); }, async () => "swept"), "swept");
});

console.log(`${pass} passed`);
