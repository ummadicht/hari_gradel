// scripts/check-authz.mjs — the route authorization map must fail loudly.
//
// Runs the real script against small fixture trees (a copy of the script in a
// throwaway repo layout), then against this repo itself.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(REPO, "scripts", "check-authz.mjs");

let pass = 0;
const t = (name, fn) => {
  try {
    fn();
    console.log("  ok  ", name);
    pass++;
  } catch (e) {
    console.log("  FAIL", name, "\n       ", e.message);
    process.exitCode = 1;
  }
};

/** A throwaway repo: { "app/api/x/route.ts": src, … } plus a map. → { status, out } */
function run(files, routes) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "giq-authz-"));
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(root, "scripts", "check-authz.mjs"));
  fs.writeFileSync(path.join(root, "scripts", "authz-map.json"), JSON.stringify({ routes }));
  for (const [rel, src] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), src);
  }
  const r = spawnSync(process.execPath, [path.join(root, "scripts", "check-authz.mjs")], { encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const STAFF = `import { portalUser } from "@/lib/portalAuth";
export async function GET() {
  const user = await portalUser();
  if (!user) return new Response("no", { status: 401 });
  return new Response("ok");
}
`;
const OPEN = `export async function POST(req: Request) {
  return new Response("ok");
}
`;

console.log("check-authz");

t("a fully declared tree passes", () => {
  const r = run(
    { "app/api/admin/route.ts": STAFF, "app/api/sessions/[id]/ping/route.ts": OPEN },
    { "app/api/admin/route.ts": { GET: "staff" }, "app/api/sessions/[id]/ping/route.ts": { POST: "session" } }
  );
  assert.equal(r.status, 0, r.out);
});

t("an undeclared route fails", () => {
  const r = run({ "app/api/admin/route.ts": STAFF, "app/api/new/route.ts": OPEN }, { "app/api/admin/route.ts": { GET: "staff" } });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /app\/api\/new\/route\.ts: not in scripts\/authz-map\.json/);
});

t("an undeclared method in a declared route fails", () => {
  const r = run({ "app/api/admin/route.ts": STAFF + OPEN }, { "app/api/admin/route.ts": { GET: "staff" } });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /POST: method not declared/);
});

t("a declared-staff route with no staff check fails — a comment naming portalUser() does not count", () => {
  const src = `// Staff only: we check portalUser() somewhere, honest.
/* isEntAuthed() too */
export async function GET() {
  const note = "portalUser( is just text in a string";
  return new Response(note);
}
`;
  const r = run({ "app/api/admin/route.ts": src }, { "app/api/admin/route.ts": { GET: "staff" } });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /declared staff, but the handler has no staff check/);
});

t("a staff check made through a local helper counts", () => {
  const src = `import { portalUser } from "@/lib/portalAuth";
async function authorized(id: string) {
  const user = await portalUser();
  return user ? { user } : { error: true };
}
export async function GET() {
  const a = await authorized("x");
  return new Response(JSON.stringify(a));
}
`;
  const r = run({ "app/api/admin/route.ts": src }, { "app/api/admin/route.ts": { GET: "staff" } });
  assert.equal(r.status, 0, r.out);
});

t("a staff check in ANOTHER method does not cover this one", () => {
  const r = run({ "app/api/admin/route.ts": STAFF + OPEN }, { "app/api/admin/route.ts": { GET: "staff", POST: "staff" } });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /POST: declared staff, but the handler has no staff check/);
});

t("a stale entry fails, and so does an unknown class", () => {
  const stale = run({ "app/api/admin/route.ts": STAFF }, { "app/api/admin/route.ts": { GET: "staff" }, "app/api/gone/route.ts": { GET: "anonymous" } });
  assert.equal(stale.status, 1, stale.out);
  assert.match(stale.out, /gone\/route\.ts: declared, but the route no longer exists/);
  const cls = run({ "app/api/admin/route.ts": STAFF }, { "app/api/admin/route.ts": { GET: "admins" } });
  assert.equal(cls.status, 1, cls.out);
});

t("session on a path with no id segment fails; service needs requireServiceToken", () => {
  const s = run({ "app/api/ping/route.ts": OPEN }, { "app/api/ping/route.ts": { POST: "session" } });
  assert.equal(s.status, 1, s.out);
  const svc = run({ "app/api/ping/route.ts": OPEN }, { "app/api/ping/route.ts": { POST: "service" } });
  assert.equal(svc.status, 1, svc.out);
  assert.match(svc.out, /declared service, but the handler has no service check/);
});

t("a known risk is printed as a warning, not a failure", () => {
  const r = run({ "app/api/ping/route.ts": OPEN }, { "app/api/ping/route.ts": { POST: { class: "anonymous", risk: "writes config" } } });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /WARN {2}app\/api\/ping\/route\.ts POST: writes config/);
});

t("THIS repo's map covers every route and its checks", () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /check-authz: \d+ routes/);
});

console.log(`\n${pass} passed${process.exitCode ? ", SOME FAILED" : ""}`);
