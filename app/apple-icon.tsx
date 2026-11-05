import { ImageResponse } from "next/og";

// iOS home-screen icon (Add to Home Screen). Next injects this as
// <link rel="apple-touch-icon">, base-path aware. PNG, no external asset.
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(135deg,#12b0a0,#0b7d78)",
          color: "#fff",
          fontSize: 96,
          fontWeight: 800,
          letterSpacing: -4,
        }}
      >
        IQ
      </div>
    ),
    { ...size }
  );
}
