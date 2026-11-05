// The resolver half of ts-resolve.mjs (loader hooks run on their own thread).
//
// Only relative, extensionless specifiers are touched, and only when a matching
// .ts/.tsx actually exists on disk. Everything else falls through untouched, so
// package resolution, node: builtins and .mjs imports behave exactly as normal.
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const CANDIDATES = [".ts", ".tsx", "/index.ts", "/index.tsx"];

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
    try {
      const base = new URL(specifier, context.parentURL);
      for (const ext of CANDIDATES) {
        const attempt = new URL(base.href + ext);
        if (fs.existsSync(fileURLToPath(attempt))) {
          return { url: attempt.href, shortCircuit: true };
        }
      }
    } catch {
      /* fall through to the default resolver */
    }
  }
  // `@/…` is the tsconfig path alias for the repo root.
  if (specifier.startsWith("@/")) {
    const root = new URL("../../", import.meta.url);
    const base = new URL(specifier.slice(2), root);
    for (const ext of ["", ...CANDIDATES]) {
      try {
        const attempt = new URL(base.href + ext);
        if (fs.existsSync(fileURLToPath(attempt))) {
          return { url: attempt.href, shortCircuit: true };
        }
      } catch {
        /* keep trying */
      }
    }
  }
  try {
    return await nextResolve(specifier, context);
  } catch (e) {
    // `next/server`, `next/headers`: a package subpath with no exports map,
    // which the bundler resolves to `<subpath>.js` and bare Node ESM refuses.
    // Lets a test import a production route handler unchanged.
    if (e?.code === "ERR_MODULE_NOT_FOUND" && /^next\/[a-z-]+$/.test(specifier)) {
      return nextResolve(`${specifier}.js`, context);
    }
    throw e;
  }
}

export const _pathToFileURL = pathToFileURL;

// `import seed from "./x.json"` — fine for the bundler, but bare Node ESM wants
// `with { type: "json" }`. Supplies the attribute so a test can import a module
// that reads a JSON seed (lib/clientPricing.ts) without changing it.
export async function load(url, context, nextLoad) {
  if (url.startsWith("file:") && url.endsWith(".json") && !context.importAttributes?.type) {
    return nextLoad(url, { ...context, importAttributes: { ...context.importAttributes, type: "json" } });
  }
  return nextLoad(url, context);
}
