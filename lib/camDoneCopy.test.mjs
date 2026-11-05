// SUP-265 — the camera page's done screen: "Done — back to SwapUp Store" for a
// SwapUp session, GradeIQ's own words for everyone else, unchanged.
//
// Review of ca09017: the full pass threw away how many colours the sweep
// verified, so a SwapUp session always ended on a green ✓ — even when the
// camera never saw the screen. A SwapUp session now says so, in amber, when
// the sweep saw fewer colours than it asked for.

import assert from "node:assert/strict";

const { camDoneCopy, CAM_DONE_DEFAULT, CAM_DONE_SWAPUP, CAM_DONE_SWAPUP_UNSEEN, CAM_DONE_SWAPUP_PARTIAL } = await import(
  "./camDoneCopy.ts"
);

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

await t('"swapup" → "Done — back to SwapUp Store" / "You can close this tab."', () => {
  assert.deepEqual(camDoneCopy("swapup"), { title: "Done — back to SwapUp Store", body: "You can close this tab.", tone: "ok" });
  assert.equal(camDoneCopy("swapup"), CAM_DONE_SWAPUP);
});

await t("every other session keeps today's words exactly (V2Cam.tsx at 6aa0726)", () => {
  const today = { title: "Captures sent", body: "You can close this tab and return to the first phone to finish.", tone: "ok" };
  for (const app of [undefined, null, "", "other", "SwapUp", " swapup", "counteriq", 1, {}, ["swapup"]]) {
    assert.deepEqual(camDoneCopy(app), today, `app ${JSON.stringify(app)}`);
    assert.equal(camDoneCopy(app), CAM_DONE_DEFAULT);
  }
});

console.log("the sweep's outcome on a SwapUp session");

await t("every colour seen → the green ✓", () => {
  assert.equal(camDoneCopy("swapup", { seen: 6, requested: 6 }), CAM_DONE_SWAPUP);
  assert.equal(camDoneCopy("swapup", { seen: 2, requested: 2 }), CAM_DONE_SWAPUP);
});

await t("the sweep saw nothing → amber, and it says the report will ask the advisor to look", () => {
  const c = camDoneCopy("swapup", { seen: 0, requested: 6 });
  assert.equal(c, CAM_DONE_SWAPUP_UNSEEN);
  assert.deepEqual(c, {
    title: "Done — back to SwapUp Store",
    body: "The camera couldn't see the screen colours, so the report will ask you to look at the screen.",
    tone: "warn",
  });
});

await t("some colours missed → amber, with its own words", () => {
  for (const seen of [1, 4, 5]) {
    const c = camDoneCopy("swapup", { seen, requested: 6 });
    assert.equal(c, CAM_DONE_SWAPUP_PARTIAL);
    assert.deepEqual(c, {
      title: "Done — back to SwapUp Store",
      body: "The camera couldn't confirm every screen colour, so the report will ask you to look at the screen.",
      tone: "warn",
    });
  }
});

await t("no sweep this time (the journey turned it off) → the plain SwapUp words", () => {
  assert.equal(camDoneCopy("swapup", null), CAM_DONE_SWAPUP);
  assert.equal(camDoneCopy("swapup", { seen: null, requested: 6 }), CAM_DONE_SWAPUP);
  assert.equal(camDoneCopy("swapup", { seen: 0, requested: 0 }), CAM_DONE_SWAPUP);
});

await t("other sessions keep today's words whatever the sweep saw", () => {
  for (const sweep of [{ seen: 0, requested: 6 }, { seen: 3, requested: 6 }, { seen: 6, requested: 6 }, null]) {
    assert.equal(camDoneCopy(undefined, sweep), CAM_DONE_DEFAULT);
    assert.equal(camDoneCopy("counteriq", sweep), CAM_DONE_DEFAULT);
  }
});

console.log(`${pass} passed`);
