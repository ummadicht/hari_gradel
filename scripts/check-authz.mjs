#!/usr/bin/env node
// Route authorization map check — `npm run check:authz`.
//
// Every app/api/**/route.ts handler must be declared in scripts/authz-map.json
// with WHO may call it (anonymous | session | staff | service | server-key).
// This fails (exit 1) when:
//   • a route file, or an exported HTTP method in one, is not in the map;
//   • the map names a route or method that no longer exists (a stale map is
//     how a route quietly loses its review);
//   • a method is declared staff / service / server-key and its handler (or a
//     helper in the same file that it calls) has no matching check:
//       staff       portalUser( · isEntAuthed( · staffFor(
//       service     requireServiceToken(
//       server-key  hasServerKey( · paidCaller( · isServerCaller(
//   • a method is declared session on a path with no dynamic segment to carry
//     the session id.
// Entries with a `risk` are printed as warnings on every run until closed.
//
// Static and dependency-free: comments and string contents are stripped before
// matching, so text that merely mentions portalUser() does not count as a check. It
// proves a check is PRESENT, not that it is correct — that is what the route
// tests are for.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAP_FILE = path.join(ROOT, "scripts", "authz-map.json");
const API_DIR = path.join(ROOT, "app", "api");
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const CLASSES = ["anonymous", "session", "staff", "service", "server-key"];
const CHECKS = {
  staff: /\b(?:portalUser|isEntAuthed|staffFor)\s*\(/,
  service: /\brequireServiceToken\s*\(/,
  "server-key": /\b(?:hasServerKey|paidCaller|isServerCaller)\s*\(/,
};

/** Every route.ts under app/api, as repo-relative posix paths. */
function routeFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...routeFiles(p));
    else if (e.name === "route.ts" || e.name === "route.js") out.push(path.relative(ROOT, p).split(path.sep).join("/"));
  }
  return out.sort();
}

/**
 * Strip // and /* *\/ comments and blank out string contents, keeping regex
 * literals and line breaks intact. A heuristic, not a parser — but it errs
 * toward hiding code, so a mistake makes a real check invisible (a loud
 * failure), never lets a comment or a string count as a check.
 */
export function stripComments(src) {
  let out = "";
  let i = 0;
  let prev = ""; // last significant (non-space) char emitted, to spot regex literals
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\") j++;
        else if (c !== "`" && src[j] === "\n") break;
        j++;
      }
      // Keep the quotes, blank the contents: text that merely names a check
      // ("portalUser( …") is not a call to it.
      out += c + src.slice(i + 1, j).replace(/[^\n]/g, " ") + (src[j] === c ? c : "");
      i = j + 1;
      prev = c;
      continue;
    }
    if (c === "/" && (prev === "" || "(,=:[!&|?{};+-*%<>~^".includes(prev) || /\breturn$/.test(out.trimEnd()))) {
      let j = i + 1;
      let cls = false;
      while (j < src.length && src[j] !== "\n") {
        if (src[j] === "\\") j++;
        else if (src[j] === "[") cls = true;
        else if (src[j] === "]") cls = false;
        else if (src[j] === "/" && !cls) break;
        j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      prev = "/";
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

const DECL = /^(export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|^(export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/;

/** Top-level declarations: name → { exported, body }. */
export function topLevel(code) {
  const chunks = [];
  for (const line of code.split("\n")) {
    const m = DECL.exec(line);
    if (m) chunks.push({ name: m[2] || m[4], exported: !!(m[1] || m[3]), body: "" });
    if (chunks.length) chunks[chunks.length - 1].body += line + "\n";
  }
  return chunks;
}

/** Which check kinds each top-level chunk performs, following calls to local helpers. */
function checksByChunk(chunks) {
  const kinds = new Map(chunks.map((c) => [c.name, new Set(Object.keys(CHECKS).filter((k) => CHECKS[k].test(c.body)))]));
  for (let changed = true; changed; ) {
    changed = false;
    for (const c of chunks) {
      for (const h of chunks) {
        if (h === c || METHODS.includes(h.name)) continue;
        if (!new RegExp(`\\b${h.name.replace(/\$/g, "\\$")}\\s*\\(`).test(c.body)) continue;
        for (const k of kinds.get(h.name)) {
          if (!kinds.get(c.name).has(k)) {
            kinds.get(c.name).add(k);
            changed = true;
          }
        }
      }
    }
  }
  return kinds;
}

function main() {
  const map = JSON.parse(fs.readFileSync(MAP_FILE, "utf8"));
  const declared = map.routes || {};
  const failures = [];
  const warnings = [];
  let checked = 0;

  const files = routeFiles(API_DIR);
  for (const file of files) {
    const src = fs.readFileSync(path.join(ROOT, file), "utf8");
    const code = stripComments(src);
    const chunks = topLevel(code);
    const methods = chunks.filter((c) => c.exported && METHODS.includes(c.name)).map((c) => c.name);
    const entry = declared[file];
    if (!entry) {
      failures.push(`${file}: not in scripts/authz-map.json (methods: ${methods.join(", ") || "none"})`);
      continue;
    }
    const kinds = checksByChunk(chunks);
    for (const m of methods) {
      const raw = entry[m];
      if (raw === undefined) {
        failures.push(`${file} ${m}: method not declared`);
        continue;
      }
      const cls = typeof raw === "string" ? raw : raw?.class;
      if (!CLASSES.includes(cls)) {
        failures.push(`${file} ${m}: unknown class "${cls}" (use ${CLASSES.join(" | ")})`);
        continue;
      }
      checked++;
      if (CHECKS[cls] && !kinds.get(m).has(cls)) {
        failures.push(`${file} ${m}: declared ${cls}, but the handler has no ${cls} check`);
      }
      if (cls === "session" && !/\[[^\]]+\]/.test(file)) {
        failures.push(`${file} ${m}: declared session, but the path has no dynamic segment for the session id`);
      }
      if (typeof raw === "object" && raw.risk) warnings.push(`${file} ${m}: ${raw.risk}`);
    }
    for (const m of Object.keys(entry)) {
      if (!methods.includes(m)) failures.push(`${file} ${m}: declared, but the file exports no ${m}`);
    }
  }
  for (const file of Object.keys(declared)) {
    if (!files.includes(file)) failures.push(`${file}: declared, but the route no longer exists`);
  }

  for (const w of warnings) console.log(`WARN  ${w}`);
  for (const f of failures) console.log(`FAIL  ${f}`);
  console.log(
    failures.length
      ? `check-authz: ${failures.length} problem(s) across ${files.length} routes`
      : `check-authz: ${files.length} routes, ${checked} handlers declared and checked${warnings.length ? `, ${warnings.length} known risk(s)` : ""}`
  );
  process.exitCode = failures.length ? 1 : 0;
}

// Run when executed, not when imported. Compared as REAL paths: through a
// symlinked directory (macOS /var → /private/var) the two spellings differ, and
// a check that silently never runs would pass everything.
const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) main();
