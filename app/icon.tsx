import { ImageResponse } from "next/og";

// Favicon / general app icon (PNG), base-path aware via Next metadata.
export const size = { width: 512, height: 512 };
export const contentType = "image/png";

export default function Icon() {
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
          fontSize: 280,
          fontWeight: 800,
          letterSpacing: -12,
          borderRadius: 112,
        }}
      >
        IQ
      </div>
    ),
    { ...size }
  );
}
