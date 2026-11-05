// Bold, minimal line-art showing HOW to hold the phone for the current capture
// angle. One accent color, thick strokes, a nudging arrow — no clutter.

export type Pose =
  | "off"
  | "front"
  | "back"
  | "left"
  | "right"
  | "top"
  | "bottom"
  | "corner";

export function poseFor(label: string): Pose {
  const l = label.toLowerCase();
  if (/\boff\b|screen off|power/.test(l)) return "off";
  if (/back|rear|camera/.test(l)) return "back";
  if (/left/.test(l)) return "left";
  if (/right/.test(l)) return "right";
  if (/bottom|port|usb|charg/.test(l)) return "bottom";
  if (/top/.test(l)) return "top";
  if (/corner/.test(l)) return "corner";
  return "front";
}

const HOW: Record<Pose, string> = {
  off: "Screen OFF — checks the glass",
  front: "Screen facing you",
  back: "Flip — rear glass & cameras",
  left: "Turn to the left edge",
  right: "Turn to the right edge",
  top: "Tilt to the top edge",
  bottom: "Tilt to the bottom edge",
  corner: "Close-up each corner",
};

const INK = "var(--text)";
const ACCENT = "var(--brand)";
const GO = "var(--green)";

// A nudging arrow pointing at the phone.
function Arrow() {
  return (
    <g className="ag-arrow" stroke={GO} strokeWidth={6} strokeLinecap="round" fill="none">
      <path d="M14 62 h22" />
      <path d="M30 54 l8 8 l-8 8" strokeLinejoin="round" />
    </g>
  );
}

function Body({ fill = "var(--card-2)" }: { fill?: string }) {
  return (
    <rect x={52} y={14} width={42} height={92} rx={10} fill={fill} stroke={INK} strokeWidth={4} />
  );
}

function renderPose(pose: Pose) {
  switch (pose) {
    case "off":
      return (
        <>
          {/* phone with a dark/off screen + power symbol */}
          <rect x={52} y={14} width={42} height={92} rx={10} fill={INK} stroke={INK} strokeWidth={4} />
          <circle cx={73} cy={19} r={1.8} fill="var(--card)" />
          {/* power icon */}
          <g stroke={GO} strokeWidth={5} fill="none" strokeLinecap="round">
            <path d="M73 46 v14" />
            <path d="M64 52 a13 13 0 1 0 18 0" />
          </g>
          <Arrow />
        </>
      );
    case "front":
      return (
        <>
          <Body />
          <rect x={57} y={23} width={32} height={70} rx={5} fill={ACCENT} opacity={0.18} />
          <circle cx={73} cy={19} r={1.8} fill={INK} />
          <Arrow />
        </>
      );
    case "back":
      return (
        <>
          <Body fill="var(--card-2)" />
          <rect x={58} y={22} width={20} height={20} rx={6} fill={INK} />
          <circle cx={64} cy={28} r={3} fill="var(--card)" />
          <circle cx={72} cy={36} r={3} fill="var(--card)" />
          <Arrow />
        </>
      );
    case "left":
    case "right": {
      const flip = pose === "right";
      return (
        <g transform={flip ? "translate(120,0) scale(-1,1)" : undefined}>
          {/* edge-on thin body */}
          <rect x={66} y={14} width={16} height={92} rx={8} fill="var(--card-2)" stroke={INK} strokeWidth={4} />
          {/* side buttons */}
          <rect x={61} y={40} width={5} height={9} rx={2} fill={INK} />
          <rect x={61} y={54} width={5} height={17} rx={2} fill={INK} />
          {/* rotate arrow */}
          <g className="ag-arrow" stroke={GO} strokeWidth={6} fill="none" strokeLinecap="round">
            <path d="M40 44 a20 20 0 0 0 0 32" />
            <path d="M32 66 l8 10 l9 -6" strokeLinejoin="round" />
          </g>
        </g>
      );
    }
    case "top":
      return (
        <>
          <Body />
          <rect x={52} y={14} width={42} height={10} rx={5} fill={GO} />
          <g className="ag-arrow-down" stroke={GO} strokeWidth={6} fill="none" strokeLinecap="round">
            <path d="M73 -2 v14" />
            <path d="M65 6 l8 8 l8 -8" strokeLinejoin="round" />
          </g>
        </>
      );
    case "bottom":
      return (
        <>
          <Body />
          <rect x={52} y={96} width={42} height={10} rx={5} fill={GO} />
          <rect x={67} y={99} width={12} height={4} rx={2} fill="var(--card)" />
          <g className="ag-arrow-up" stroke={GO} strokeWidth={6} fill="none" strokeLinecap="round">
            <path d="M73 118 v-12" />
            <path d="M65 112 l8 -8 l8 8" strokeLinejoin="round" />
          </g>
        </>
      );
    case "corner":
      return (
        <>
          <Body />
          <circle cx={90} cy={22} r={15} fill="none" stroke={GO} strokeWidth={5} className="ag-pulse" />
          <path d="M100 33 l10 10" stroke={GO} strokeWidth={6} strokeLinecap="round" />
        </>
      );
  }
}

// Just the phone-pose glyph (no text) — for the compact side tiles.
export function PoseIcon({ label, size = 38 }: { label: string; size?: number }) {
  const pose = poseFor(label);
  return (
    <svg viewBox="0 0 120 120" width={size} height={size} aria-hidden>
      {renderPose(pose)}
    </svg>
  );
}

export default function AngleGuide({ label }: { label: string }) {
  const pose = poseFor(label);
  return (
    <div className="flex flex-col items-center text-center">
      <svg viewBox="0 0 120 120" width="100%" style={{ maxWidth: 132 }} aria-hidden>
        {renderPose(pose)}
      </svg>
      <div className="mt-1 text-base font-extrabold leading-tight">{label}</div>
      <div className="text-xs text-[var(--muted)]">{HOW[pose]}</div>
    </div>
  );
}

// Box shape hint for the on-camera framing guide.
export function frameForPose(pose: Pose): { width: string; ar: string } {
  if (pose === "left" || pose === "right") return { width: "26%", ar: "1 / 2.6" };
  return { width: "50%", ar: "1 / 2" };
}
