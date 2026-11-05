// SUP-77 — machine-to-machine auth works with AND without Keycloak.
//
// Live GradeIQ has no KEYCLOAK_ISSUER, and the three machine routes had moved
// to Keycloak-only: SwapMore's pricebook push, the console's push to SuperIQ and
// the customers API all failed ("KEYCLOAK_ISSUER is not set"). These tests pin
// lib/m2m.ts THROUGH THE PRODUCTION ROUTE HANDLERS, for every branch:
//
//   issuer unset  pricebook ← x-sync-secret vs PRICEBOOK_SYNC_SECRET (200 / 401
//                 / 503 when unset); push-superiq → Bearer SUPERIQ_TOKEN (503
//                 "not configured" when unset); customers → 503 "not configured";
//                 nothing throws or logs a stack.
//   issuer set    Keycloak only: a real RS256 token against a local JWKS; the
//                 shared secrets are no longer accepted or sent; Keycloak down
//                 → 503.
//
// The "Keycloak" is a local HTTP server on 127.0.0.1 (discovery, JWKS, token
// endpoint); SuperIQ is a scripted fetch. Nothing leaves the machine.

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import * as jose from "jose";

process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "giq-m2m-")));
for (const k of Object.keys(process.env)) {
  if (/^(PHONECHECK_|IMEI_API_|GEMINI_|GOOGLE_API_KEY|GRADEIQ_|GIQ_AUTH_MODE|KEYCLOAK_|OIDC_|SVC_CLIENT_|PORTAL_PW_|ENT_|PRICEBOOK_SYNC_SECRET|SUPERIQ_|PUBLIC_ORIGIN)/.test(k)) delete process.env[k];
}
if (process.env.NODE_ENV === "development") delete process.env.NODE_ENV;
process.env.GIQ_AUTH_MODE = "legacy";
const ADMIN_PW = `t-${Math.random().toString(36).slice(2)}`;
process.env.PORTAL_PW_ADMIN = ADMIN_PW;
process.env.SUPERIQ_DIAGNOSTICS_URL = "http://superiq.test/api/diagnostics/ingest";
const SYNC = `sync-${Math.random().toString(36).slice(2)}`;
const SUPERIQ_TOKEN = `siq-${Math.random().toString(36).slice(2)}`;

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

// ── a Keycloak-shaped issuer on 127.0.0.1 ───────────────────────────────────
const { publicKey, privateKey } = await jose.generateKeyPair("RS256");
const jwk = { ...(await jose.exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
let ISSUER = "";
let tokenRequests = 0;
const sign = (claims) =>
  new jose.SignJWT({ typ: "Bearer", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
const idp = http.createServer(async (req, res) => {
  const send = (o) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(o));
  };
  if (req.url.endsWith("/.well-known/openid-configuration"))
    return send({ issuer: ISSUER, jwks_uri: `${ISSUER}/protocol/openid-connect/certs`, token_endpoint: `${ISSUER}/protocol/openid-connect/token` });
  if (req.url.endsWith("/protocol/openid-connect/certs")) return send({ keys: [jwk] });
  if (req.url.endsWith("/protocol/openid-connect/token")) {
    tokenRequests++;
    return send({ access_token: await sign({ aud: ["superiq-erp"], azp: "gradeiq-svc" }), expires_in: 300 });
  }
  res.writeHead(404).end();
});
await new Promise((r) => idp.listen(0, "127.0.0.1", r));
ISSUER = `http://127.0.0.1:${idp.address().port}/realms/novetta`;
const DEAD_ISSUER = "http://127.0.0.1:1/realms/novetta"; // nothing listens: Keycloak down

// ── SuperIQ: a scripted ingest that records what it was sent ────────────────
const realFetch = globalThis.fetch;
let superiq = []; // { authorization }
let superiqStatus = 200;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.hostname === "superiq.test") {
    superiq.push({ authorization: new Headers(init.headers).get("authorization") });
    return new Response(JSON.stringify(superiqStatus === 200 ? { imported: 1, unmatched: 0 } : { error: "unauthorized" }), {
      status: superiqStatus,
      headers: { "content-type": "application/json" },
    });
  }
  if (u.hostname === "127.0.0.1") return realFetch(url, init);
  throw new Error(`unexpected fetch ${u.href}`);
};

// Everything the routes log, so "no stack traces" can be checked.
const logged = [];
for (const level of ["error", "warn"]) {
  const orig = console[level].bind(console);
  console[level] = (...a) => {
    logged.push(a.map((x) => (x instanceof Error ? x.stack : String(x))).join(" "));
    orig(...a);
  };
}

globalThis.AsyncLocalStorage ??= (await import("node:async_hooks")).AsyncLocalStorage;
const require = createRequire(import.meta.url);
const { workAsyncStorage } = require("next/dist/server/app-render/work-async-storage.external.js");
const { workUnitAsyncStorage } = require("next/dist/server/app-render/work-unit-async-storage.external.js");
const { RequestCookies } = require("next/dist/server/web/spec-extension/cookies.js");

const pricebookRoute = await import("../app/api/clients/[clientId]/pricebook/route.ts");
const pushRoute = await import("../app/api/report/[id]/push-superiq/route.ts");
const customersRoute = await import("../app/api/customers/sessions/[id]/route.ts");
const photosRoute = await import("../app/api/customers/sessions/[id]/photos/[pid]/route.ts");
const { db } = await import("./db.ts");
const { checkLogin } = await import("./portalAuth.ts");
const m2m = await import("./m2m.ts");

const BASE = "http://localhost:3700";
function inRequest(cookie, fn) {
  const cookies = new RequestCookies(new Headers(cookie ? { cookie } : {}));
  return workAsyncStorage.run({ route: "/api/test", forceStatic: false, dynamicShouldError: false }, () =>
    workUnitAsyncStorage.run({ type: "request", phase: "render", cookies }, fn)
  );
}
const staff = () => `giq_portal=${checkLogin("admin", ADMIN_PW).token}`;

const BOOK = JSON.parse(fs.readFileSync(new URL("./pricebook-swapmore.seed.json", import.meta.url), "utf8"));
const pushBook = (headers = {}, client = "swapmore") =>
  inRequest("", () =>
    pricebookRoute.POST(
      new Request(`${BASE}/api/clients/${client}/pricebook`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(BOOK),
      }),
      { params: Promise.resolve({ clientId: client }) }
    )
  );
db.prepare(
  "INSERT INTO sessions (id, imei, model, status, functional_grade, cosmetic_grade, overall_grade, client_id) VALUES ('m2m1', '356938035643809', 'iPhone 13', 'graded', 'Working', 'B', 'B', 'denovo')"
).run();
const push = (cookie = staff()) =>
  inRequest(cookie, () =>
    pushRoute.POST(new Request(`${BASE}/api/report/m2m1/push-superiq`, { method: "POST" }), { params: Promise.resolve({ id: "m2m1" }) })
  );
const customers = (token, id = "m2m1") =>
  inRequest("", () =>
    customersRoute.GET(new Request(`${BASE}/api/customers/sessions/${id}`, { headers: token ? { authorization: `Bearer ${token}` } : {} }), {
      params: Promise.resolve({ id }),
    })
  );
const photo = (token) =>
  inRequest("", () =>
    photosRoute.GET(new Request(`${BASE}/api/customers/sessions/m2m1/photos/p1`, { headers: { authorization: `Bearer ${token}` } }), {
      params: Promise.resolve({ id: "m2m1", pid: "p1" }),
    })
  );

const noIssuer = () => delete process.env.KEYCLOAK_ISSUER;
const withIssuer = (iss = ISSUER) => (process.env.KEYCLOAK_ISSUER = iss);

console.log("m2m — no KEYCLOAK_ISSUER: pricebook (SwapMore's x-sync-secret)");

await t("the right x-sync-secret is accepted (200) and the book is held", async () => {
  noIssuer();
  process.env.PRICEBOOK_SYNC_SECRET = SYNC;
  const r = await pushBook({ "x-sync-secret": SYNC });
  assert.equal(r.status, 200);
  const out = await r.json();
  assert.equal(out.ok, true);
  assert.equal(out.models, BOOK.models.length);
  const got = await (await pricebookRoute.GET(new Request(`${BASE}/api/clients/swapmore/pricebook`), { params: Promise.resolve({ clientId: "swapmore" }) })).json();
  assert.equal(got.source, "synced");
});

await t("a wrong, shorter, longer or missing secret is 401", async () => {
  noIssuer();
  process.env.PRICEBOOK_SYNC_SECRET = SYNC;
  for (const h of [{ "x-sync-secret": SYNC + "x" }, { "x-sync-secret": "short" }, { "x-sync-secret": SYNC.slice(0, -1) }, {}]) {
    const r = await pushBook(h);
    assert.equal(r.status, 401, JSON.stringify(Object.keys(h)));
    assert.deepEqual(await r.json(), { error: "unauthorized" });
  }
});

await t("a Bearer token is not a substitute for the secret without Keycloak (401)", async () => {
  noIssuer();
  process.env.PRICEBOOK_SYNC_SECRET = SYNC;
  const r = await pushBook({ authorization: `Bearer ${await sign({ aud: ["gradeiq"], azp: "swapmore-svc" })}` });
  assert.equal(r.status, 401);
});

await t("PRICEBOOK_SYNC_SECRET unset → 503 'not configured' (even with a header)", async () => {
  noIssuer();
  delete process.env.PRICEBOOK_SYNC_SECRET;
  const r = await pushBook({ "x-sync-secret": SYNC });
  assert.equal(r.status, 503);
  assert.match((await r.json()).error, /not configured: PRICEBOOK_SYNC_SECRET is not set/);
  process.env.PRICEBOOK_SYNC_SECRET = SYNC;
});

await t("an unknown client is still 404 before any auth", async () => {
  noIssuer();
  assert.equal((await pushBook({ "x-sync-secret": SYNC }, "nobody")).status, 404);
});

console.log("m2m — no KEYCLOAK_ISSUER: push to SuperIQ (SUPERIQ_TOKEN)");

await t("push-superiq sends SUPERIQ_TOKEN as the Bearer (200)", async () => {
  noIssuer();
  process.env.SUPERIQ_TOKEN = SUPERIQ_TOKEN;
  superiq = [];
  superiqStatus = 200;
  const r = await push();
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  assert.deepEqual(superiq, [{ authorization: `Bearer ${SUPERIQ_TOKEN}` }]);
});

await t("SUPERIQ_TOKEN unset → 503 'not configured', nothing sent", async () => {
  noIssuer();
  delete process.env.SUPERIQ_TOKEN;
  superiq = [];
  const r = await push();
  assert.equal(r.status, 503);
  const { error } = await r.json();
  assert.match(error, /not configured/);
  assert.match(error, /SUPERIQ_TOKEN/);
  assert.deepEqual(superiq, []);
});

await t("SuperIQ refusing the token is the upstream's failure (502)", async () => {
  noIssuer();
  process.env.SUPERIQ_TOKEN = SUPERIQ_TOKEN;
  superiqStatus = 401;
  try {
    assert.equal((await push()).status, 502);
  } finally {
    superiqStatus = 200;
  }
});

await t("push-superiq still needs staff (401, nothing sent)", async () => {
  noIssuer();
  superiq = [];
  assert.equal((await push("")).status, 401);
  assert.deepEqual(superiq, []);
});

console.log("m2m — no KEYCLOAK_ISSUER: customers API");

await t("customers → 503 'not configured' (with or without a bearer), photos too", async () => {
  noIssuer();
  for (const r of [await customers("x.y.z"), await customers(""), await photo("x.y.z")]) {
    assert.equal(r.status, 503);
    assert.deepEqual(await r.json(), { error: { code: "not_configured", message: "Machine-to-machine access is not configured on this server." } });
  }
});

await t("nothing above threw or logged 'KEYCLOAK_ISSUER is not set' or a stack", () => {
  assert.equal(logged.filter((l) => /KEYCLOAK_ISSUER is not set|\n\s+at /.test(l)).length, 0, logged.join("\n---\n"));
});

console.log("m2m — KEYCLOAK_ISSUER set: Keycloak only");

await t("pricebook: a swapmore-svc token for audience gradeiq → 200", async () => {
  withIssuer();
  const r = await pushBook({ authorization: `Bearer ${await sign({ aud: ["gradeiq", "account"], azp: "swapmore-svc" })}` });
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
});

await t("pricebook: the x-sync-secret alone is NO LONGER accepted (401 missing_bearer_token)", async () => {
  withIssuer();
  process.env.PRICEBOOK_SYNC_SECRET = SYNC;
  const r = await pushBook({ "x-sync-secret": SYNC });
  assert.equal(r.status, 401);
  assert.deepEqual(await r.json(), { error: "missing_bearer_token" });
});

await t("pricebook: another client's token is 403, a foreign signature 401", async () => {
  withIssuer();
  assert.equal((await pushBook({ authorization: `Bearer ${await sign({ aud: ["gradeiq"], azp: "pandas-api" })}` })).status, 403);
  const { privateKey: rogue } = await jose.generateKeyPair("RS256");
  const forged = await new jose.SignJWT({ aud: ["gradeiq"], azp: "swapmore-svc" })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(ISSUER)
    .setExpirationTime("5m")
    .sign(rogue);
  assert.equal((await pushBook({ authorization: `Bearer ${forged}` })).status, 401);
});

await t("push-superiq: sends a minted gradeiq-svc token, never SUPERIQ_TOKEN", async () => {
  withIssuer();
  process.env.SUPERIQ_TOKEN = SUPERIQ_TOKEN;
  superiq = [];
  tokenRequests = 0;
  const r = await push();
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  assert.equal(superiq.length, 1);
  const bearer = superiq[0].authorization.replace(/^Bearer /, "");
  assert.notEqual(bearer, SUPERIQ_TOKEN);
  const claims = jose.decodeJwt(bearer);
  assert.equal(claims.azp, "gradeiq-svc");
  assert.deepEqual(claims.aud, ["superiq-erp"]);
  assert.equal(tokenRequests, 1);
});

await t("customers: a pandas-api token gets past auth (unknown session → 404); none → 401", async () => {
  withIssuer();
  const tok = await sign({ aud: ["gradeiq"], azp: "pandas-api" });
  assert.equal((await customers(tok, "no-such-session")).status, 404);
  assert.equal((await customers("")).status, 401);
});

await t("Keycloak down: pricebook bearer and customers → 503, push-superiq → 503 and nothing sent", async () => {
  withIssuer(DEAD_ISSUER);
  const tok = await sign({ aud: ["gradeiq"], azp: "swapmore-svc" });
  assert.equal((await pushBook({ authorization: `Bearer ${tok}` })).status, 503);
  assert.equal((await customers(tok)).status, 503);
  superiq = [];
  assert.equal((await push()).status, 503);
  assert.deepEqual(superiq, []);
});

await t("lib/m2m: keycloakM2M follows KEYCLOAK_ISSUER only — never GIQ_AUTH_MODE", () => {
  noIssuer();
  process.env.GIQ_AUTH_MODE = "oidc";
  assert.equal(m2m.keycloakM2M(), false);
  process.env.KEYCLOAK_ISSUER = "  ";
  assert.equal(m2m.keycloakM2M(), false);
  withIssuer();
  process.env.GIQ_AUTH_MODE = "legacy";
  assert.equal(m2m.keycloakM2M(), true);
  noIssuer();
});

idp.close();
console.log(pass + " assertions passed\n");
