// Node ESM resolve hook: lets tests import production modules that use
// extensionless relative specifiers.
//
// The source writes `import { db } from "./db"` — correct for TypeScript and
// for Next's bundler, but bare Node ESM requires a real filename. Rather than
// rewrite production imports (which would be a change made purely to satisfy a
// test runner, and would risk the Next build), the test process teaches Node
// the same resolution rule the compiler already uses.
//
// Used as: node --experimental-strip-types --import ./lib/capture/ts-resolve.mjs …
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import fs from "node:fs";

const HOOK = new URL("./ts-resolve-hooks.mjs", import.meta.url).href;
register(HOOK, pathToFileURL("./"));

// Keep a reference so bundlers/linters don't flag the import as unused.
export const _fs = fs;
