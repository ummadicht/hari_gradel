// ── v2 line-art — the "why" picture at the top of each step.
// Pandas leans on one big, calm drawing per screen instead of a screenshot, so the
// instruction lands before the user reads a word. These are inline SVG on purpose:
// strokes are currentColor and fills are --t-accent-soft, so the SAME art reads
// dark on GradeIQ and light+purple on swapmore with zero per-client assets.

type IllProps = { className?: string };

/** Default box: ~260px tall, scales down on narrow phones (viewBox does the work). */
const BOX = "h-[260px] w-full max-w-[300px]";

/** One stroke language across every drawing. */
const S = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

const SOFT = "var(--t-accent-soft)";

export function PhoneIdIllustration({ className = BOX }: IllProps) {
  return (
    <svg viewBox="0 0 240 260" className={className} aria-hidden="true">
      <g {...S}>
        <rect x="66" y="16" width="108" height="228" rx="22" />
        <path d="M106 30h28" />
        <path d="M108 232h24" />
        {/* the IMEI card on screen */}
        <rect x="82" y="66" width="76" height="104" rx="12" fill={SOFT} />
        <rect x="94" y="80" width="24" height="18" rx="4" />
        <path d="M94 116h52M94 132h52M94 148h32" />
        {/* a dialled *#06# tick — identity confirmed */}
        <circle cx="176" cy="188" r="26" fill={SOFT} />
        <path d="M165 188l8 8 16-17" />
      </g>
    </svg>
  );
}

export function MirrorIllustration({ className = BOX }: IllProps) {
  return (
    <svg viewBox="0 0 240 260" className={className} aria-hidden="true">
      <g {...S}>
        {/* the mirror pane */}
        <rect x="20" y="10" width="200" height="202" rx="22" fill={SOFT} />
        <path d="M44 178L92 40M72 188l30-86" />
        {/* the phone as seen IN the mirror */}
        <rect x="92" y="56" width="56" height="112" rx="12" />
        <circle cx="120" cy="78" r="6" />
        <path d="M104 152h32" />
        {/* the real phone, held up in front of it */}
        <rect x="84" y="196" width="72" height="56" rx="12" fill={SOFT} />
        <path d="M84 212H70a9 9 0 0 0 0 18h14" />
        <path d="M100 252v-14M120 252v-14M140 252v-14" />
      </g>
    </svg>
  );
}

export function TwoDeviceIllustration({ className = BOX }: IllProps) {
  return (
    <svg viewBox="0 0 240 260" className={className} aria-hidden="true">
      <g {...S}>
        {/* device under test, propped up */}
        <rect x="12" y="44" width="80" height="164" rx="14" />
        <path d="M40 56h24" />
        <rect x="24" y="72" width="56" height="108" rx="10" fill={SOFT} />
        {/* the second phone doing the filming, held at a slight angle */}
        <g transform="rotate(8 176 122)">
          <rect x="140" y="46" width="72" height="152" rx="16" />
          <circle cx="176" cy="72" r="10" />
          <circle cx="176" cy="72" r="3.5" />
          <rect x="152" y="100" width="48" height="76" rx="8" fill={SOFT} />
        </g>
        {/* framing lines — kept in the GAP between the two phones (the held phone is
            rotated, so its left edge sits around x≈130-150 and anything further
            right would scribble over its screen). */}
        <path d="M128 90 96 82M124 152 96 164" strokeDasharray="5 9" />
        {/* the hand */}
        <path d="M134 214h68M138 214v26M160 214v30M182 214v26" />
      </g>
    </svg>
  );
}

export function BatteryIllustration({ className = BOX }: IllProps) {
  return (
    <svg viewBox="0 0 240 260" className={className} aria-hidden="true">
      <g {...S}>
        <rect x="60" y="14" width="120" height="232" rx="22" />
        <path d="M104 28h32" />
        {/* the battery-health row */}
        <rect x="78" y="62" width="60" height="34" rx="9" />
        <rect x="84" y="68" width="36" height="22" rx="5" fill={SOFT} />
        <path d="M142 72v14" />
        <text
          x="78"
          y="140"
          fontSize="30"
          fontWeight="700"
          fill="currentColor"
          stroke="none"
        >
          88%
        </text>
        {/* "Maximum Capacity" caption + a settings-list feel */}
        <path d="M78 160h84M78 176h56" />
        <rect x="78" y="196" width="84" height="34" rx="10" fill={SOFT} />
        <path d="M92 213h56" />
      </g>
    </svg>
  );
}

export function ScanIllustration({ className = BOX }: IllProps) {
  return (
    <svg viewBox="0 0 240 260" className={className} aria-hidden="true">
      <g {...S}>
        <rect x="56" y="18" width="128" height="224" rx="22" />
        {/* barcode */}
        <rect x="76" y="96" width="88" height="68" rx="8" fill={SOFT} />
        <path d="M86 110v40M94 110v40M102 110v40M112 110v40M120 110v40M130 110v40M138 110v40M148 110v40M156 110v40" />
        {/* scan reticle corners */}
        <path d="M64 96V80h16M160 80h16v16M176 164v16h-16M80 180H64v-16" />
        {/* the scan beam */}
        <path d="M68 130h104" stroke="var(--t-accent)" strokeWidth="3" />
      </g>
    </svg>
  );
}

export function DoneIllustration({ className = BOX }: IllProps) {
  return (
    <svg viewBox="0 0 240 260" className={className} aria-hidden="true">
      <g {...S}>
        <circle cx="120" cy="130" r="72" fill={SOFT} />
        <path d="M88 130l22 24 44-48" strokeWidth="3" />
        {/* little celebration ticks */}
        <path d="M120 36V22M120 238v-14M206 130h14M20 130h14M181 69l10-10M49 201l10-10M181 191l10 10M49 59l10 10" />
      </g>
    </svg>
  );
}
