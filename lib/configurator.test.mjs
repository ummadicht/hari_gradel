// SUP-88 — only a super admin may read or rewrite the GLOBAL program config.
//
// /api/configurator used to take a sentence from anyone and rewrite every
// tenant's segments and pricing overrides ("Add a $500 trade-in bonus"). These
// tests drive the PRODUCTION route handlers and the PRODUCTION middleware:
//   • no sign-in → 401, and nothing is saved;
//   • a client admin → 403, and nothing is saved;
//   • a super admin → 200 and the change is stored;
//   • the same holds in both GIQ_AUTH_MODE settings (portal cookie in legacy,
//     Keycloak session in oidc — and in oidc a legacy cookie is nobody);
//   • the /configurator page is behind the staff middleware.
//
// Staff is not faked: each call runs inside a Next request scope carrying the
// cookie a browser would send, so portalUser() resolves it exactly as in prod.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

// db.ts opens <cwd>/data/gradeiq.db — never a real database.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "giq-configurator-")));
for (const k of Object.keys(process.env)) {
  if (/^(GEMINI_|GOOGLE_API_KEY|OPENAI_|MOONSHOT_|KIMI_|GRADEIQ_|GIQ_AUTH_MODE|KEYCLOAK_|PORTAL_PW_|ENT_|NEXT_PUBLIC_BASE_PATH|PUBLIC_ORIGIN)/.test(k)) delete process.env[k];
}
if (process.env.NODE_ENV === "development") delete process.env.NODE_ENV;
process.env.GIQ_AUTH_MODE = "legacy";
// Operator-set passwords (generated per run), so nothing leans on a default.
const ADMIN_PW = `t-${Math.random().toString(36).slice(2)}`;
const DENOVO_PW = `t-${Math.random().toString(36).slice(2)}`;
process.env.PORTAL_PW_ADMIN = ADMIN_PW;
process.env.PORTAL_PW_DENOVO = DENOVO_PW;

let pass = 0;
const t = async (name, fn) => {
  try {
    await fn();
    console.log("  ok  ", name);
    pass++;
  } catch (e) {
    console.log("  FAIL", name, "\n       ", e.stack || e.message);
    process.exitCode = 1;
  }
};

// No network: the commands used here are parsed without a model.
globalThis.fetch = async (url) => {
  throw new Error(`unexpected fetch ${url}`);
};

globalThis.AsyncLocalStorage ??= (await import("node:async_hooks")).AsyncLocalStorage;
const require = createRequire(import.meta.url);
const { workAsyncStorage } = require("next/dist/server/app-render/work-async-storage.external.js");
const { workUnitAsyncStorage } = require("next/dist/server/app-render/work-unit-async-storage.external.js");
const { RequestCookies } = require("next/dist/server/web/spec-extension/cookies.js");
const { NextRequest } = await import("next/server.js");

const route = await import("../app/api/configurator/route.ts");
const mw = await import("../middleware.ts");
const { getProgramConfig } = await import("./programConfig.ts");
const { checkLogin } = await import("./portalAuth.ts");
const { insertSession, newSid } = await import("./oidc-session.ts");

const BASE = "http://localhost:3700";

/** Run a handler the way Next does: inside a request scope with this cookie header. */
function inRequest(cookie, fn) {
  const cookies = new RequestCookies(new Headers(cookie ? { cookie } : {}));
  return workAsyncStorage.run({ route: "/api/test", forceStatic: false, dynamicShouldError: false }, () =>
    workUnitAsyncStorage.run({ type: "request", phase: "render", cookies }, fn)
  );
}
const legacyCookie = (user, pw) => {
  const hit = checkLogin(user, pw);
  assert.ok(hit, `legacy sign-in for ${user}`);
  return `giq_portal=${hit.token}`;
};
function oidcCookie(role, clientId) {
  const sid = newSid();
  insertSession({ sid, sub: `kc-${role}`, email: `${role}@example.test`, name: role, role, clientId, id_token: null });
  return `giq_session=${sid}`;
}

const post = (message, cookie = "") =>
  inRequest(cookie, () =>
    route.POST(
      new NextRequest(`${BASE}/api/configurator`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      })
    )
  );
const get = (cookie = "") => inRequest(cookie, () => route.GET());
const promo = () => getProgramConfig().pricing.promoBonus ?? 0;

console.log("configurator (SUP-88)");

await t("no sign-in: POST is 401 and the global config is untouched", async () => {
  const r = await post("Add a $500 trade-in bonus");
  assert.equal(r.status, 401);
  assert.match((await r.json()).error, /super admin/);
  assert.equal(promo(), 0);
});

await t("no sign-in: GET is 401 too (nothing in the public flow reads it)", async () => {
  assert.equal((await get()).status, 401);
});

await t("a junk portal cookie is nobody (401)", async () => {
  assert.equal((await post("Add a $500 trade-in bonus", "giq_portal=admin.not-the-token")).status, 401);
  assert.equal(promo(), 0);
});

await t("client admin (legacy): 403 on POST and GET, nothing saved", async () => {
  const cookie = legacyCookie("denovo", DENOVO_PW);
  const r = await post("Add a $500 trade-in bonus", cookie);
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /Only a super admin/);
  assert.equal((await get(cookie)).status, 403);
  assert.equal(promo(), 0);
});

await t("super admin (legacy): 200, the change is stored and read back", async () => {
  const cookie = legacyCookie("admin", ADMIN_PW);
  const r = await post("Add a $25 trade-in bonus", cookie);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.changed, true);
  assert.equal(d.config.pricing.promoBonus, 25);
  assert.equal(promo(), 25);
  const g = await get(cookie);
  assert.equal(g.status, 200);
  assert.equal((await g.json()).pricing.promoBonus, 25);
});

await t("an empty message from a super admin is still a 400", async () => {
  assert.equal((await post("", legacyCookie("admin", ADMIN_PW))).status, 400);
});

await t("oidc: Keycloak super 200, Keycloak client admin 403, a legacy cookie is nobody (401)", async () => {
  const legacyAdmin = legacyCookie("admin", ADMIN_PW);
  process.env.GIQ_AUTH_MODE = "oidc";
  try {
    const sup = await post("Set margin to 12%", oidcCookie("super", null));
    assert.equal(sup.status, 200);
    assert.equal(getProgramConfig().pricing.marginRate, 0.12);

    const client = await post("Add a $900 trade-in bonus", oidcCookie("client", "swapmore"));
    assert.equal(client.status, 403);
    assert.equal((await get(oidcCookie("client", "swapmore"))).status, 403);

    assert.equal((await post("Add a $900 trade-in bonus", legacyAdmin)).status, 401);
    assert.equal(promo(), 25, "neither refused write changed the promo");
  } finally {
    process.env.GIQ_AUTH_MODE = "legacy";
  }
});

// ── the page ────────────────────────────────────────────────────────────────

const page = (pathname, cookie) =>
  mw.middleware(new NextRequest(`${BASE}${pathname}`, { headers: cookie ? { cookie } : {} }));

await t("middleware: /configurator with no sign-in → the legacy sign-in page", async () => {
  const r = page("/configurator");
  assert.equal(r.status, 307);
  const loc = new URL(r.headers.get("location"));
  assert.equal(loc.pathname, "/login");
  assert.equal(loc.searchParams.get("returnTo"), "/configurator");
});

await t("middleware: /configurator in oidc mode → the Keycloak start", async () => {
  process.env.GIQ_AUTH_MODE = "oidc";
  try {
    const r = page("/configurator");
    assert.equal(r.status, 307);
    assert.equal(new URL(r.headers.get("location")).pathname, "/auth/login");
  } finally {
    process.env.GIQ_AUTH_MODE = "legacy";
  }
});

await t("middleware: a signed-in browser reaches /configurator; the matcher covers it", async () => {
  const r = page("/configurator", legacyCookie("admin", ADMIN_PW));
  assert.equal(r.headers.get("location"), null);
  assert.equal(r.headers.get("x-middleware-next"), "1");
  assert.ok(mw.config.matcher.includes("/configurator/:path*"));
});

await t("middleware: the consumer flow stays open", async () => {
  for (const p of ["/", "/v2", "/v2/cam/abc", "/s/abc", "/report/abc"]) {
    assert.equal(page(p).headers.get("location"), null, p);
  }
});

console.log(`${pass} passed`);
