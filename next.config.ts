import type { NextConfig } from "next";

// Subpath hosting (e.g. swapmore.com/apps/gradeiq): set NEXT_PUBLIC_BASE_PATH
// at build time. Unset locally → served at root.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

const nextConfig: NextConfig = {
  // better-sqlite3 is a native module — keep it out of the server bundler.
  serverExternalPackages: ["better-sqlite3"],
  ...(basePath ? { basePath, assetPrefix: basePath } : {}),
};

export default nextConfig;
