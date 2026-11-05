#!/usr/bin/env node
// Keycloak preflight for GradeIQ (SUP-84). Run it ON THE VM, in the app
// directory, BEFORE flipping GIQ_AUTH_MODE=oidc:
//
//   cd ~/gradeiq && node scripts/keycloak-preflight.mjs
//
// It reads the app's env the way `next start` does (.env.local, with anything
// already in the process env winning) and checks, from the machine that will
// actually talk to Keycloak:
//   1. the env names GradeIQ needs are set (values are NEVER printed)
//   2. KEYCLOAK_ISSUER answers discovery + JWKS within 3 s, and calls itself
//      exactly that issuer (a mismatch fails every login after the password step)
//   3. the gradeiq client accepts OIDC_REDIRECT_URI (asks the authorize endpoint;
//      it only renders the login form — nobody is signed in)
//   4. Keycloak accepts OIDC_CLIENT_SECRET (a deliberately bogus code: a good
//      secret gets "invalid_grant", a bad one "unauthorized_client")
//   5. the post-logout URI (<public>/apps/gradeiq/login) is allowed
//   6. gradeiq-svc's client_credentials grant works and its token is signed by
//      the realm with azp=gradeiq-svc and aud containing superiq-erp
//   7. what GIQ_AUTH_MODE is now, what the RUNNING app does with /superadmin,
//      and whether pm2 holds auth env that would override .env.local
// Exit 0 = ready to flip. Exit 1 = not ready; every problem is listed in plain
// English. No dependencies — node 18+ built-ins only, so it can also be piped
// over ssh:  ssh vm 'cd ~/gradeiq && node --input-type=module -' < scripts/keycloak-preflight.mjs
//
// Options: --dotenv <path> (default ./.env.local) · --app <url> (default
//   http://127.0.0.1:3700; "none" skips) · --no-pm2 · --timeout <ms> (3000)
import fs from "node:fs";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};
const ENV_FILE = opt("--dotenv", ".env.local");
const APP = opt("--app", "http://127.0.0.1:3700");
const TIMEOUT = Number(opt("--timeout", "3000"));
const CHECK_PM2 = !argv.includes("--no-pm2");

// ── output ──────────────────────────────────────────────────────────────────
let fails = 0, warns = 0;
const line = (tag, msg) => console.log(`${tag.padEnd(5)} ${msg}`);
const pass = (m) => line("PASS", m);
const fail = (m) => { fails++; line("FAIL", m); };
const warn = (m) => { warns++; line("WARN", m); };
const info = (m) => line("INFO", m);

// ── env, as `next start` sees it ────────────────────────────────────────────
function parseEnvFile(path) {
  const out = {};
  let text;
  try { text = fs.readFileSync(path, "utf8"); } catch { return null; }
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(raw);
    if (!m) continue;
    let v = m[2].trim();
    const q = v[0];
    if ((q === '"' || q === "'" || q === "`") && v.endsWith(q) && v.length >= 2) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    out[m[1]] = v;
  }
  return out;
}
const fileEnv = parseEnvFile(ENV_FILE);
const env = (k) => {
  const v = process.env[k] ?? fileEnv?.[k];
  return v === undefined ? "" : String(v).trim();
};
const loopback = (u) => /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(u.hostname);

console.log(`GradeIQ Keycloak preflight — ${new Date().toISOString()}`);
if (fileEnv) info(`env file: ${ENV_FILE} (process env wins over it, as for next start)`);
else warn(`no env file at ${ENV_FILE} — using the process env only (run this from the app directory, e.g. cd ~/gradeiq)`);

// 1. names
const REQUIRED = [
  ["KEYCLOAK_ISSUER", "the realm URL, e.g. https://<host>/realms/novetta"],
  ["OIDC_CLIENT_SECRET", "the gradeiq client's secret (Keycloak → Clients → gradeiq → Credentials)"],
  ["OIDC_REDIRECT_URI", "https://swapmore.com/apps/gradeiq/auth/callback"],
  ["SVC_CLIENT_SECRET", "the gradeiq-svc client's secret (push to SuperIQ)"],
  ["NEXT_PUBLIC_BASE_PATH", "/apps/gradeiq — without it every /apps/gradeiq route 404s after a restart"],
];
for (const [k, why] of REQUIRED) {
  if (env(k)) pass(`${k} is set`);
  else fail(`${k} is not set — ${why}`);
}
if (env("SUPERIQ_DIAGNOSTICS_URL")) pass("SUPERIQ_DIAGNOSTICS_URL is set");
else warn("SUPERIQ_DIAGNOSTICS_URL is not set — the console's \"push to SuperIQ\" will answer 501 (sign-in is unaffected)");
const CLIENT_ID = env("OIDC_CLIENT_ID") || "gradeiq";
const SVC_ID = env("SVC_CLIENT_ID") || "gradeiq-svc";
info(`client ids: OIDC_CLIENT_ID=${CLIENT_ID}${env("OIDC_CLIENT_ID") ? "" : " (default)"}, SVC_CLIENT_ID=${SVC_ID}${env("SVC_CLIENT_ID") ? "" : " (default)"}`);

const flag = env("GIQ_AUTH_MODE").toLowerCase();
info(`GIQ_AUTH_MODE is ${flag === "oidc" ? "oidc — staff already sign in with Keycloak" : flag === "legacy" ? "legacy (explicit) — staff sign in with passwords" : "unset — legacy, staff sign in with passwords"}`);

// 2. issuer shape
const ISSUER_RAW = env("KEYCLOAK_ISSUER");
const ISSUER = ISSUER_RAW.replace(/\/$/, "");
let issuerUrl = null;
if (ISSUER_RAW) {
  try {
    issuerUrl = new URL(ISSUER);
    if (!/^\/realms\/[^/]+$/.test(issuerUrl.pathname)) fail("KEYCLOAK_ISSUER should look like https://<host>/realms/<realm> (no extra path)");
    else if (issuerUrl.protocol !== "https:" && !loopback(issuerUrl)) fail("KEYCLOAK_ISSUER must be https:// (tokens and secrets travel over it)");
    else pass("KEYCLOAK_ISSUER has the shape https://<host>/realms/<realm>");
    if (ISSUER_RAW.endsWith("/")) warn("KEYCLOAK_ISSUER ends with \"/\" — GradeIQ strips it; the realm's issuer has none");
  } catch {
    fail("KEYCLOAK_ISSUER is not a URL");
    issuerUrl = null;
  }
}
const BASE = env("NEXT_PUBLIC_BASE_PATH");
const REDIRECT = env("OIDC_REDIRECT_URI");
let publicOrigin = null;
if (REDIRECT) {
  try {
    const r = new URL(REDIRECT);
    publicOrigin = r.origin;
    if (r.protocol !== "https:" && !loopback(r)) fail("OIDC_REDIRECT_URI must be https://");
    if (r.pathname !== `${BASE}/auth/callback`) fail(`OIDC_REDIRECT_URI must end in ${BASE || ""}/auth/callback (the app's callback under its base path)`);
    else pass(`OIDC_REDIRECT_URI points at the app's callback (${BASE}/auth/callback)`);
  } catch {
    fail("OIDC_REDIRECT_URI is not a URL");
  }
}

// ── network helpers ─────────────────────────────────────────────────────────
async function get(url, init = {}) {
  return fetch(url, { redirect: "manual", cache: "no-store", ...init, signal: AbortSignal.timeout(TIMEOUT) });
}
const why = (e) =>
  e?.name === "TimeoutError"
    ? `no answer within ${TIMEOUT / 1000}s`
    : e?.cause?.code || e?.cause?.errors?.[0]?.code || e?.cause?.message || e?.message || String(e);
const b64json = (s) => JSON.parse(Buffer.from(s, "base64url").toString("utf8"));

async function main() {
  if (!issuerUrl) {
    fail("Keycloak checks skipped — KEYCLOAK_ISSUER is missing or invalid");
    return;
  }

  // discovery
  let disc;
  try {
    const r = await get(`${ISSUER}/.well-known/openid-configuration`);
    if (r.status === 404) return fail("discovery answered 404 — the realm name in KEYCLOAK_ISSUER is probably wrong");
    if (!r.ok) return fail(`discovery answered HTTP ${r.status}`);
    disc = await r.json();
    pass(`discovery answered within ${TIMEOUT / 1000}s`);
  } catch (e) {
    return fail(`Keycloak is not reachable from this machine: ${why(e)}`);
  }
  if (String(disc.issuer || "").replace(/\/$/, "") === ISSUER) pass("Keycloak's issuer string matches KEYCLOAK_ISSUER exactly");
  else fail(`Keycloak calls itself "${disc.issuer}" but KEYCLOAK_ISSUER is "${ISSUER}" — every login would fail token verification; make them identical (scheme, host, port, realm)`);
  for (const k of ["authorization_endpoint", "token_endpoint", "jwks_uri", "end_session_endpoint"]) {
    if (!disc[k]) fail(`discovery has no ${k}`);
  }

  // JWKS
  let jwks = [];
  try {
    const r = await get(disc.jwks_uri);
    if (!r.ok) fail(`JWKS answered HTTP ${r.status}`);
    else {
      jwks = (await r.json()).keys || [];
      const sig = jwks.filter((k) => k.kty === "RSA" && (!k.use || k.use === "sig"));
      if (sig.length) pass(`JWKS loaded (${sig.length} RSA signing key${sig.length > 1 ? "s" : ""})`);
      else fail("JWKS has no RSA signing key — GradeIQ verifies RS256 tokens");
    }
  } catch (e) {
    fail(`JWKS not reachable: ${why(e)}`);
  }

  // redirect URI registered (authorize endpoint renders its login form; nobody signs in)
  if (REDIRECT && disc.authorization_endpoint) {
    const u = new URL(disc.authorization_endpoint);
    u.searchParams.set("client_id", CLIENT_ID);
    u.searchParams.set("redirect_uri", REDIRECT);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("scope", "openid");
    u.searchParams.set("state", `preflight-${crypto.randomBytes(6).toString("hex")}`);
    u.searchParams.set("code_challenge", crypto.createHash("sha256").update(crypto.randomBytes(32)).digest("base64url"));
    u.searchParams.set("code_challenge_method", "S256");
    try {
      const r = await get(u);
      const loc = r.headers.get("location") || "";
      if (r.status === 200) pass(`client "${CLIENT_ID}" accepts OIDC_REDIRECT_URI (Keycloak shows its login form)`);
      else if (r.status >= 300 && r.status < 400 && loc.startsWith(REDIRECT)) {
        const err = new URL(loc).searchParams.get("error");
        if (err) fail(`client "${CLIENT_ID}" accepts the redirect URI but refuses the login request: ${err} (is the standard flow + PKCE S256 enabled?)`);
        else pass(`client "${CLIENT_ID}" accepts OIDC_REDIRECT_URI`);
      } else if (r.status === 400) fail(`Keycloak refuses OIDC_REDIRECT_URI for client "${CLIENT_ID}" (HTTP 400) — add it to the client's "Valid redirect URIs", or the client id is wrong`);
      else fail(`the authorize endpoint answered HTTP ${r.status} for client "${CLIENT_ID}"`);
    } catch (e) {
      fail(`authorize endpoint not reachable: ${why(e)}`);
    }
  }

  // client secret (a bogus code: good secret → invalid_grant, bad secret → 401)
  if (disc.token_endpoint && env("OIDC_CLIENT_SECRET")) {
    try {
      const r = await get(disc.token_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code", code: `preflight-not-a-code-${crypto.randomBytes(6).toString("hex")}`,
          redirect_uri: REDIRECT, client_id: CLIENT_ID, client_secret: env("OIDC_CLIENT_SECRET"),
          code_verifier: crypto.randomBytes(32).toString("base64url"),
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 400 && j.error === "invalid_grant") pass(`Keycloak accepts OIDC_CLIENT_SECRET for client "${CLIENT_ID}"`);
      else if (r.status === 401 || j.error === "invalid_client" || j.error === "unauthorized_client")
        fail(`Keycloak REJECTS OIDC_CLIENT_SECRET for client "${CLIENT_ID}" (${j.error || `HTTP ${r.status}`}) — copy the current secret from Clients → ${CLIENT_ID} → Credentials`);
      else fail(`unexpected token-endpoint answer while checking the client secret: HTTP ${r.status} ${j.error || ""}`.trim());
    } catch (e) {
      fail(`token endpoint not reachable: ${why(e)}`);
    }
  }

  // post-logout redirect (no id_token_hint → Keycloak shows its confirmation page)
  if (disc.end_session_endpoint && publicOrigin) {
    const plr = `${publicOrigin}${BASE}/login`;
    const u = new URL(disc.end_session_endpoint);
    u.searchParams.set("client_id", CLIENT_ID);
    u.searchParams.set("post_logout_redirect_uri", plr);
    try {
      const r = await get(u);
      if (r.status === 200 || (r.status >= 300 && r.status < 400)) pass(`Keycloak allows the post-logout redirect to ${BASE}/login`);
      else if (r.status === 400) fail(`Keycloak refuses the post-logout redirect ${plr} — add ${publicOrigin}${BASE}/* to the ${CLIENT_ID} client's "Valid post logout redirect URIs" (logout would leave the Keycloak session alive)`);
      else warn(`the end-session endpoint answered HTTP ${r.status} for the post-logout check`);
    } catch (e) {
      fail(`end-session endpoint not reachable: ${why(e)}`);
    }
  }

  // gradeiq-svc client_credentials → a realm-signed token for SuperIQ
  if (disc.token_endpoint && env("SVC_CLIENT_SECRET")) {
    try {
      const r = await get(disc.token_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "client_credentials", client_id: SVC_ID, client_secret: env("SVC_CLIENT_SECRET") }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.access_token) {
        fail(`client_credentials for "${SVC_ID}" failed: ${j.error || `HTTP ${r.status}`}${r.status === 401 ? " — check SVC_CLIENT_SECRET and that the client has Service accounts enabled" : ""}`);
      } else {
        const [h, p, s] = String(j.access_token).split(".");
        const header = b64json(h), claims = b64json(p);
        const key = jwks.find((k) => k.kid === header.kid);
        let sigOk = false;
        if (key && header.alg === "RS256") {
          sigOk = crypto.verify("RSA-SHA256", Buffer.from(`${h}.${p}`), crypto.createPublicKey({ key, format: "jwk" }), Buffer.from(s, "base64url"));
        }
        const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
        const problems = [];
        if (!sigOk) problems.push(key ? `signature does not verify (${header.alg})` : "signed with a key not in the realm JWKS");
        if (String(claims.iss || "").replace(/\/$/, "") !== ISSUER) problems.push(`iss is "${claims.iss}"`);
        if (claims.azp !== SVC_ID) problems.push(`azp is "${claims.azp}", not "${SVC_ID}"`);
        if (!aud.includes("superiq-erp")) problems.push(`aud ${JSON.stringify(claims.aud)} lacks "superiq-erp" (the client's audience mapper)`);
        if (!(Number(claims.exp) > Date.now() / 1000)) problems.push("already expired (clock skew?)");
        if (problems.length) fail(`"${SVC_ID}" token is wrong: ${problems.join("; ")}`);
        else pass(`"${SVC_ID}" client_credentials works — realm-signed, azp=${SVC_ID}, aud includes superiq-erp`);
      }
    } catch (e) {
      fail(`client_credentials check failed: ${why(e)}`);
    }
  }
}

// What the RUNNING app does — shows the mode the process actually loaded.
async function appCheck() {
  if (APP === "none") return;
  const host = publicOrigin ? new URL(publicOrigin).host : "swapmore.com";
  try {
    const r = await get(`${APP.replace(/\/$/, "")}${BASE}/superadmin`, { headers: { "x-forwarded-host": host, "x-forwarded-proto": "https" } });
    const loc = r.headers.get("location") || "";
    const p = loc ? new URL(loc, APP).pathname : "";
    if (p.endsWith("/auth/login")) info(`running app: /superadmin → ${p} (the process is in oidc mode)`);
    else if (p.endsWith("/login")) info(`running app: /superadmin → ${p} (the process is in legacy mode)`);
    else info(`running app: /superadmin answered HTTP ${r.status}${p ? ` → ${p}` : ""}`);
    if (loc && /^https?:\/\/(localhost|127\.)/.test(loc)) warn(`the running app redirects to ${new URL(loc).origin}, not the public origin`);
  } catch (e) {
    warn(`the running app at ${APP} did not answer: ${why(e)}`);
  }
}

// pm2 env overrides .env.local: a flip written to the file would be ignored.
function pm2Check() {
  if (!CHECK_PM2) return;
  let list;
  try {
    list = JSON.parse(execFileSync("pm2", ["jlist"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 }));
  } catch {
    return info("pm2 not found here — skipped the pm2 env check");
  }
  const proc = list.find((p) => p.name === "gradeiq");
  if (!proc) return warn('no pm2 process named "gradeiq"');
  const penv = { ...(proc.pm2_env?.env || {}), ...(proc.pm2_env || {}) };
  const shadow = Object.keys(penv).filter((k) => /^(GIQ_AUTH_MODE|KEYCLOAK_ISSUER|OIDC_|SVC_CLIENT_|NEXT_PUBLIC_BASE_PATH$|SUPERIQ_DIAGNOSTICS_URL$|PORTAL_PW_|ENT_)/.test(k));
  if (shadow.length) warn(`the pm2 process itself carries ${shadow.join(", ")} — process env beats .env.local, so edits to the file would not take effect. Restart it from a clean shell (pm2 delete gradeiq && pm2 start npm --name gradeiq -- start) and never use --update-env for the flip`);
  else pass("pm2's gradeiq process carries no auth env of its own (.env.local decides)");
}

await main();
await appCheck();
pm2Check();
console.log("");
if (fails) {
  console.log(`NOT READY — ${fails} problem${fails > 1 ? "s" : ""} above${warns ? `, ${warns} warning${warns > 1 ? "s" : ""}` : ""}. Do not set GIQ_AUTH_MODE=oidc yet.`);
  process.exit(1);
}
console.log(`READY — Keycloak answers this server correctly${warns ? ` (${warns} warning${warns > 1 ? "s" : ""} above)` : ""}.`);
