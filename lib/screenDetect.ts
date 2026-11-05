/**
 * Lit-screen detection — shared by EVERY surface that films a device's screen.
 *
 * Extracted from V2Cam because the capture surfaces had diverged: /v2/cam waited
 * until the camera could actually SEE the pattern, while /handoff still fired on
 * a bare `await wait(1300)` timer. That timer captures whatever happens to be in
 * frame — often nothing — and the grader is then handed six photos of a screen it
 * never saw (which used to be recorded as a passing display test).
 *
 * Any new capture surface should import these rather than re-implement them, so
 * "did the camera really see it?" answers the same way everywhere.
 */

export type ScreenBox = { x0: number; y0: number; x1: number; y1: number };

export const SCN_W = 64;
export const SCN_H = 48;

function scaledPixels(v: HTMLVideoElement): Uint8ClampedArray | null {
  if (!v.videoWidth) return null;
  const c = document.createElement("canvas");
  c.width = SCN_W;
  c.height = SCN_H;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(v, 0, 0, SCN_W, SCN_H);
  return ctx.getImageData(0, 0, SCN_W, SCN_H).data;
}

/** Locate a bright, lit rectangle (a phone screen showing white). */
export function findLitScreen(
  v: HTMLVideoElement,
): { box: ScreenBox; coverage: number } | null {
  const d = scaledPixels(v);
  if (!d) return null;
  let x0 = SCN_W,
    y0 = SCN_H,
    x1 = -1,
    y1 = -1,
    n = 0;
  for (let y = 0; y < SCN_H; y++) {
    for (let x = 0; x < SCN_W; x++) {
      const i = (y * SCN_W + x) * 4;
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (lum > 150) {
        n++;
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  }
  const coverage = n / (SCN_W * SCN_H);
  // Too little = not framed yet; too much = the camera is staring at a lamp or
  // the frame is blown out, not a phone screen.
  if (coverage < 0.05 || coverage > 0.85 || x1 < 0) return null;
  return { box: { x0, y0, x1, y1 }, coverage };
}

/** Mean colour + in-region contrast inside a locked screen box. */
export function regionStats(v: HTMLVideoElement, b: ScreenBox) {
  const d = scaledPixels(v);
  if (!d) return null;
  let r = 0,
    g = 0,
    bl = 0,
    n = 0;
  const lums: number[] = [];
  for (let y = b.y0; y <= b.y1; y++) {
    for (let x = b.x0; x <= b.x1; x++) {
      const i = (y * SCN_W + x) * 4;
      r += d[i];
      g += d[i + 1];
      bl += d[i + 2];
      lums.push(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
      n++;
    }
  }
  if (!n) return null;
  r /= n;
  g /= n;
  bl /= n;
  const mean = lums.reduce((a, x) => a + x, 0) / lums.length;
  const sd = Math.sqrt(lums.reduce((a, x) => a + (x - mean) ** 2, 0) / lums.length);
  return { r, g, b: bl, sd };
}

/** Does what the camera sees inside the locked box match the pattern we asked for? */
export function matchesPattern(
  st: { r: number; g: number; b: number; sd: number },
  p: string,
): boolean {
  const { r, g, b, sd } = st;
  const mx = Math.max(r, g, b),
    mn = Math.min(r, g, b);
  switch (p) {
    case "white":
      return mn > 130 && mx - mn < 70;
    case "red":
      return r > g + 35 && r > b + 35;
    case "green":
      return g > r + 30 && g > b + 30;
    case "blue":
      return b > r + 30 && b > g + 30;
    case "black":
      return mx < 95;
    case "stripes":
      return sd > 32; // alternating bands = high in-region contrast
    default:
      return true;
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until a lit WHITE screen is visible, then lock onto its rectangle.
 * Returns null if it never appears within `timeoutMs` — callers must then skip
 * the sweep rather than capture blind.
 */
export async function lockOntoScreen(
  videoEl: () => HTMLVideoElement | null,
  timeoutMs = 20000,
  onHint?: (hint: string) => void,
): Promise<ScreenBox | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = videoEl();
    if (v && v.readyState >= 2) {
      const hit = findLitScreen(v);
      if (hit) {
        const st = regionStats(v, hit.box);
        if (st && matchesPattern(st, "white")) {
          // Hold briefly so a passing glare can't lock us onto the wrong thing.
          await wait(350);
          const again = findLitScreen(v);
          const st2 = again && regionStats(v, again.box);
          if (again && st2 && matchesPattern(st2, "white")) return again.box;
        } else {
          onHint?.("Screen found — hold steady on the white screen");
        }
      } else {
        onHint?.("Point the camera at the phone's screen…");
      }
    }
    await wait(200);
  }
  return null;
}

/**
 * Wait until the locked region actually shows `pattern`. Returns false on
 * timeout — the caller should then SKIP that pattern. A missing pattern is
 * honest; a frame that doesn't show it is not.
 */
export async function waitForPattern(
  videoEl: () => HTMLVideoElement | null,
  box: ScreenBox,
  pattern: string,
  timeoutMs = 4000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = videoEl();
    const st = v && v.readyState >= 2 ? regionStats(v, box) : null;
    if (st && matchesPattern(st, pattern)) return true;
    await wait(150);
  }
  return false;
}
