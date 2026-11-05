// "This is what we need" — a mock of the real Battery Health screen for the
// seller's platform, with the number we're after ringed. Sellers routinely send
// the wrong screen (battery USAGE, not battery HEALTH), so showing the target
// beats describing it. Pure inline SVG: no assets, re-themes from --t-* tokens.

type Props = { platform: "ios" | "samsung" | "pixel" | "android"; className?: string };

const BOX = "h-56 w-auto";

export default function BatteryExampleShot({ platform, className = BOX }: Props) {
  const ios = platform === "ios";
  const heading = ios ? "Battery Health & Charging" : "Battery information";
  const metric = ios ? "Maximum Capacity" : "Battery health";
  const value = ios ? "87%" : "Good · 87%";

  return (
    <svg viewBox="0 0 240 300" className={className} role="img" aria-label={`Example ${metric} screen`}>
      {/* phone body */}
      <rect x="18" y="6" width="204" height="288" rx="26" fill="var(--t-card)" stroke="currentColor" strokeWidth="2" />
      <rect x="96" y="14" width="48" height="7" rx="3.5" fill="currentColor" opacity="0.25" />

      {/* nav bar */}
      <text x="34" y="48" fontSize="9" fill="currentColor" opacity="0.5">‹ Battery</text>
      <text x="34" y="70" fontSize="12" fontWeight="700" fill="currentColor">{heading}</text>

      {/* the row that matters */}
      <rect x="30" y="86" width="180" height="52" rx="10" fill="var(--t-accent-soft)" />
      <text x="42" y="108" fontSize="10" fill="currentColor" opacity="0.75">{metric}</text>
      <text x="42" y="128" fontSize="19" fontWeight="800" fill="currentColor">{value}</text>

      {/* ring + label pointing at the number */}
      <rect
        x="34" y="90" width="172" height="44" rx="8"
        fill="none" stroke="var(--t-accent)" strokeWidth="2.5" strokeDasharray="5 4"
      />
      <g>
        <rect x="120" y="146" width="92" height="20" rx="10" fill="var(--t-accent)" />
        <text x="166" y="160" fontSize="9.5" fontWeight="700" textAnchor="middle" fill="var(--t-cta-text)">
          we need this
        </text>
        <path d="M150 146 L142 136" stroke="var(--t-accent)" strokeWidth="2" strokeLinecap="round" />
      </g>

      {/* filler rows so it reads as a real settings screen */}
      {[184, 214, 244].map((y, i) => (
        <g key={y}>
          <rect x="30" y={y} width={i === 1 ? 120 : 150} height="8" rx="4" fill="currentColor" opacity="0.14" />
          <rect x="30" y={y + 14} width={i === 2 ? 90 : 110} height="6" rx="3" fill="currentColor" opacity="0.08" />
        </g>
      ))}
    </svg>
  );
}
