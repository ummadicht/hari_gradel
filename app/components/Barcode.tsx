import { encodeCode128B } from "@/lib/barcode128";

// Inline, dependency-free Code 128-B barcode (scannable <rect> stripes) with the
// value printed underneath — used for the device IMEI on the report.
export default function Barcode({
  value,
  height = 40,
  module = 1.4,
}: {
  value: string;
  height?: number;
  module?: number;
}) {
  if (!value) return null;
  const { widths, units } = encodeCode128B(value);
  const w = units * module;
  const rects: React.ReactNode[] = [];
  let x = 0;
  widths.forEach((width, i) => {
    const px = width * module;
    if (i % 2 === 0) {
      // even index = bar
      rects.push(
        <rect key={i} x={x} y={0} width={px} height={height} fill="currentColor" />
      );
    }
    x += px;
  });
  return (
    <div className="inline-flex flex-col items-center">
      <svg
        width={w}
        height={height}
        viewBox={`0 0 ${w} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`IMEI ${value}`}
        style={{ color: "var(--text)" }}
      >
        {rects}
      </svg>
      <span className="mono mt-1 text-[11px] tracking-widest text-[var(--muted)]">
        {value}
      </span>
    </div>
  );
}
