import type { NextConfig } from "next";

// Subpath hosting (e.g. swapmore.com/apps/gradeiq): set NEXT_PUBLIC_BASE_PATH
// at build time. Unset locally → served at root.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

const nextConfig: NextConfig = {
  output: "standalone",
  // better-sqlite3 and pg are server-only database drivers — keep them out of the bundler.
  serverExternalPackages: ["better-sqlite3", "pg"],
  ...(basePath ? { basePath, assetPrefix: basePath } : {}),
};

export default nextConfig;
