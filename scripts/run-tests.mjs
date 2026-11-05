#!/usr/bin/env node
// Runs every unit test in the repo: lib/**/*.test.mjs and scripts/**/*.test.mjs.
//
// Each file runs in its own Node process, from its own throwaway working
// directory. `lib/db.ts` puts its SQLite file under `process.cwd()`, so a fresh
// cwd per file means every test gets an empty database of its own and nothing
// ever touches data/gradeiq.db. The repo's own lib/capture/ts-resolve.mjs is
// loaded so tests can import the production .ts modules unchanged.
//
// Everything is resolved from this file's location, so the runner works from
// any checkout or clone without knowing where it lives.
//
//   npm test                         every test
//   npm test -- lib/capture          only the files under a directory
//   npm test -- lib/deviceMatch.test.mjs lib/phonecheck.test.mjs
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESOLVER = pathToFileURL(path.join(ROOT, "lib/capture/ts-resolve.mjs")).href;
const SEARCH = ["lib", "scripts"];
const SKIP_DIRS = new Set(["node_modules", ".next", ".git"]);

function findTests(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  const stat = fs.statSync(dir);
  if (stat.isFile()) {
    if (dir.endsWith(".test.mjs")) out.push(dir);
    return out;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findTests(full, out);
    else if (entry.name.endsWith(".test.mjs")) out.push(full);
  }
  return out;
}

const args = process.argv.slice(2);
const roots = (args.length ? args : SEARCH).map((p) => path.resolve(ROOT, p));
const missing = roots.filter((p) => !fs.existsSync(p));
if (missing.length) {
  console.error(`No such test path: ${missing.map((p) => path.relative(ROOT, p)).join(", ")}`);
  process.exit(2);
}
const files = [...new Set(roots.flatMap((r) => findTests(r)))].sort();
if (!files.length) {
  console.error("No test files found.");
  process.exit(2);
}

const failed = [];
const started = Date.now();
for (const file of files) {
  const rel = path.relative(ROOT, file);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "gradeiq-test-"));
  const t0 = Date.now();
  const run = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", "--import", RESOLVER, file],
    { cwd, stdio: "inherit" },
  );
  fs.rmSync(cwd, { recursive: true, force: true });
  const ok = run.status === 0;
  if (!ok) failed.push(rel);
  const why = run.signal ? `killed by ${run.signal}` : `exit ${run.status}`;
  console.log(`${ok ? "PASS" : "FAIL"} ${rel} (${Date.now() - t0} ms${ok ? "" : ", " + why})\n`);
}

const secs = ((Date.now() - started) / 1000).toFixed(1);
if (failed.length) {
  console.log(`${failed.length} of ${files.length} test files failed in ${secs}s:`);
  for (const f of failed) console.log(`  ${f}`);
  process.exit(1);
}
console.log(`All ${files.length} test files passed in ${secs}s.`);
