import type { MetadataRoute } from "next";

// PWA manifest. Served at ${basePath}/manifest.webmanifest and auto-linked by
// Next. The string URLs inside (start_url/scope/icons) are NOT auto-prefixed, so
// we add the base path manually for subpath hosting (swapmore.com/apps/gradeiq).
const BP = process.env.NEXT_PUBLIC_BASE_PATH || "";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "GradeIQ — 90-second phone inspection",
    short_name: "GradeIQ",
    description:
      "Scan, rotate, done. AI-graded phone condition, fraud & identity in under 90 seconds — no cable, no app store.",
    start_url: `${BP}/v2`,
    scope: `${BP}/`,
    id: `${BP}/`,
    display: "standalone",
    orientation: "portrait",
    background_color: "#0b0f14",
    theme_color: "#0e8f86",
    categories: ["business", "productivity", "utilities"],
    icons: [
      { src: `${BP}/icon.svg`, sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: `${BP}/icon.svg`, sizes: "any", type: "image/svg+xml", purpose: "maskable" },
    ],
  };
}
