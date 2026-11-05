"use client";
import { useEffect, useRef, useState } from "react";

// Touchscreen + multi-touch in ONE clear game: clear every square by tapping or
// swiping (the squares tile the screen edge to edge, so a dead touch zone leaves
// a square standing → digitizer coverage). One special square needs TWO fingers
// at once to clear → multi-touch. Reports { touch, multitouch } when finished.

type Res = "pass" | "fail" | "skip";


const COLS = 6;
const ROWS = 11;
const TIMEOUT_MS = 30000;

/**
 * FULL-BLEED TILES, NOT FLOATING CIRCLES.
 *
 * The grid used inset circles: cell centres were squeezed into `0.1 + y*0.82`,
 * so the top 10% and bottom 8% of the digitiser were never asked to register a
 * touch at all — and round targets leave untested gaps between neighbours even
 * inside the covered band. A dead strip along the top edge, which is exactly
 * where a dropped phone's digitiser fails, passed this test every time.
 *
 * Now the screen is tiled edge to edge with rectangles that share borders:
 * every pixel belongs to some tile, so a dead zone ALWAYS leaves one standing.
 */
type Tile = { id: number; col: number; row: number; multi: boolean };

function buildTiles(): Tile[] {
  const out: Tile[] = [];
  let id = 0;
  for (let row = 0; row < ROWS; row++)
    for (let col = 0; col < COLS; col++)
      out.push({ id: id++, col, row, multi: false });
  // The two-finger target is a normal tile in the middle, promoted.
  const mid = out.find((t) => t.row === Math.floor(ROWS / 2) && t.col === Math.floor(COLS / 2));
  if (mid) mid.multi = true;
  return out;
}

export default function BubbleTouch({ onDone }: { onDone: (touch: Res, multitouch: Res) => void }) {
  const padRef = useRef<HTMLDivElement>(null);
  const bubblesRef = useRef<Tile[]>(buildTiles());
  const poppedRef = useRef<Set<number>>(new Set());
  const multiBurstRef = useRef(false);
  const maxTouchRef = useRef(1);
  const doneRef = useRef(false);
  const [, setTick] = useState(0);
  const tick = () => setTick((t) => t + 1);

  const singles = bubblesRef.current.filter((b) => !b.multi);
  const multi = bubblesRef.current.find((b) => b.multi)!;

  /**
   * TRUE FULL SCREEN, WHERE THE BROWSER ALLOWS IT.
   *
   * `100dvh` only fills the *viewport* — the URL bar and the browser chrome
   * still own real pixels of the digitiser, and those pixels are precisely the
   * ones this test can't reach. Fullscreen hands them back, so the tiles cover
   * the physical panel rather than the page.
   *
   * Requested on the first touch, not on mount: the API requires live user
   * activation, and the tap that advanced the previous step has expired by the
   * time this component paints.
   *
   * Honest limitation: iOS Safari on iPhone does not implement element
   * fullscreen at all (only <video>). There it silently stays at 100dvh — still
   * edge to edge within the viewport, just not under the browser chrome.
   */
  const fsTriedRef = useRef(false);
  function goFullscreen() {
    if (fsTriedRef.current) return;
    fsTriedRef.current = true;
    const el = padRef.current?.parentElement;
    if (!el || document.fullscreenElement) return;
    try {
      const req = (el as any).requestFullscreen || (el as any).webkitRequestFullscreen;
      req?.call(el, { navigationUI: "hide" })?.catch?.(() => {});
    } catch {
      /* unsupported (iOS Safari) — 100dvh is the fallback */
    }
  }
  function exitFullscreen() {
    try {
      if (document.fullscreenElement) document.exitFullscreen()?.catch?.(() => {});
    } catch {
      /* nothing to exit */
    }
  }

  useEffect(() => {
    const t = setTimeout(() => finish(), TIMEOUT_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function finish() {
    if (doneRef.current) return;
    doneRef.current = true;
    exitFullscreen();
    const poppedSingles = singles.filter((b) => poppedRef.current.has(b.id)).length;
    const cov = poppedSingles / singles.length;
    const touch: Res = cov >= 0.9 ? "pass" : "fail";
    const multitouch: Res = multiBurstRef.current || maxTouchRef.current >= 2 ? "pass" : "skip";
    onDone(touch, multitouch);
  }

  function maybeComplete() {
    const allSingles = singles.every((b) => poppedRef.current.has(b.id));
    if (allSingles && multiBurstRef.current) setTimeout(finish, 250);
  }

  // Pop any single bubble under a point (tap or swipe).
  function popAt(clientX: number, clientY: number) {
    const rect = padRef.current?.getBoundingClientRect();
    if (!rect) return;
    const W = rect.width, H = rect.height;
    const px = clientX - rect.left, py = clientY - rect.top;
    // Which tile owns this pixel. Tiles tile the plane, so this is a direct
    // index rather than a distance test — and every pixel maps to exactly one.
    const col = Math.floor((px / W) * COLS);
    const row = Math.floor((py / H) * ROWS);
    let changed = false;
    for (const b of singles) {
      if (poppedRef.current.has(b.id)) continue;
      if (b.col === col && b.row === row) {
        poppedRef.current.add(b.id);
        changed = true;
      }
    }
    if (changed) { tick(); maybeComplete(); }
  }

  function onPointer(e: React.PointerEvent) {
    if (e.type === "pointerdown") goFullscreen();
    if (e.type === "pointermove" && e.buttons === 0) return;
    popAt(e.clientX, e.clientY);
  }

  function onTouch(e: React.TouchEvent) {
    goFullscreen();
    maxTouchRef.current = Math.max(maxTouchRef.current, e.touches.length);
    const rect = padRef.current?.getBoundingClientRect();
    if (!rect) return;
    const W = rect.width, H = rect.height;
    // Single pops for each finger.
    for (let k = 0; k < e.touches.length; k++) popAt(e.touches[k].clientX, e.touches[k].clientY);
    // Multi-touch burst: 2+ fingers inside the special bubble at once.
    if (!multiBurstRef.current) {
      let inside = 0;
      for (let k = 0; k < e.touches.length; k++) {
        const c = Math.floor(((e.touches[k].clientX - rect.left) / W) * COLS);
        const r2 = Math.floor(((e.touches[k].clientY - rect.top) / H) * ROWS);
        if (c === multi.col && r2 === multi.row) inside++;
      }
      if (inside >= 2) { multiBurstRef.current = true; tick(); maybeComplete(); }
    }
  }

  const poppedSingles = singles.filter((b) => poppedRef.current.has(b.id)).length;

  return (
    <div className="stage relative bg-[var(--bg)]" style={{ height: "100dvh" }}>
      {/* The instructions float ON TOP of the tiles rather than above them —
          the tiles now own every pixel, so there is no free strip to put a
          header in. `pointer-events-none` keeps the tiles underneath fully
          tappable, and the scrim keeps the text legible over them. */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 z-10 px-6 pb-3 pt-3 text-center"
        style={{ background: "linear-gradient(to bottom, rgba(0,0,0,0.62), rgba(0,0,0,0))" }}
      >
        <h1 className="text-lg font-extrabold text-white">Clear every square</h1>
        <p className="mt-0.5 text-[13px] text-white/75">
          Tap or swipe over them all · the <span style={{ color: "var(--gold-2)" }}>2-finger</span> square needs both fingers
        </p>
        <div className="mt-1 text-[12px] text-white/70">
          {poppedSingles}/{singles.length} cleared · multi-touch {multiBurstRef.current ? "✓" : "—"}
        </div>
      </div>

      <div
        ref={padRef}
        className="absolute inset-0 touch-none select-none"
        onPointerDown={onPointer}
        onPointerMove={onPointer}
        onTouchStart={onTouch}
        onTouchMove={onTouch}
      >
        {bubblesRef.current.map((b) => {
          const popped = b.multi ? multiBurstRef.current : poppedRef.current.has(b.id);
          if (popped) return null;
          return (
            <div
              key={b.id}
              className="absolute grid place-items-center"
              style={{
                left: `${(b.col / COLS) * 100}%`,
                top: `${(b.row / ROWS) * 100}%`,
                width: `${100 / COLS}%`,
                height: `${100 / ROWS}%`,
                // A hairline inset so neighbouring tiles read as separate
                // targets without leaving any pixel unowned.
                outline: "1px solid rgba(255,255,255,0.18)",
                outlineOffset: "-1px",
                // The two-finger tile must read as different at a glance, and
                // it can't do that in a tint of the brand colour — on a gold
                // client the old lighter-gold tile was invisible among its
                // neighbours. Inverting it (dark tile, brand-coloured ring)
                // stays distinct whatever --brand happens to be.
                background: b.multi
                  ? "radial-gradient(circle at 35% 30%, #2b2b2b, #111)"
                  : "radial-gradient(circle at 35% 30%, color-mix(in oklch, var(--brand) 85%, white), var(--brand))",
                boxShadow: b.multi
                  ? "inset 0 0 0 3px var(--brand)"
                  : "0 2px 8px rgba(0,0,0,0.18)",
                color: "#fff",
                fontWeight: 800,
              }}
            >
              {b.multi && (
                <span className="text-center text-[10px] leading-tight">
                  ✌︎<br />2 fingers
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
