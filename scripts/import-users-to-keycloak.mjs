#!/usr/bin/env node
// Import GradeIQ portal users (the 6 built-in accounts + the portal_users table)
// into the Keycloak realm as `gradeiq` client-role holders, carrying their
// client scope as the `giq_client` attribute. SUP-84.
//
//   KEYCLOAK_ISSUER=https://kc.example/realms/novetta \
//     node scripts/import-users-to-keycloak.mjs --dry [--db <path to gradeiq.db>]
//   … then the same without --dry.
//
// Admin credentials: KC_ADMIN_USER / KC_ADMIN_PASS from the env, or — the
// intended way — typed when asked (the password is not echoed). Never put them
// in a file. They are sent only to <host>/realms/master's token endpoint.
// --dry logs in and READS (clients, roles, users) but writes nothing.
//
// Passwords: sha256 hashes can't be imported, and a user with no password can
// never complete Keycloak's "update password" action (it only runs AFTER a
// successful password login). So each user this script CREATES gets a random
// TEMPORARY password (Keycloak makes them choose their own at first login). The
// list goes to a file only you can read (mode 600, path printed, contents
// never printed) — hand each one over out-of-band, then delete the file.
//
// Options:
//   --dry              read-only rehearsal
//   --db <path>        a COPY of the GradeIQ DB to read portal_users from; it
//                      must exist. Without it only the 6 built-ins are imported
//                      (prod had 0 stored users on 2026-10-20 — re-check).
//   --emails <json>    {"username": "real@email", …} — placeholder
//                      <username>@gradeiq.local is used for anyone not listed
//   --passwords-out <path>  where to write the temporary passwords
//                      (default ~/gradeiq-keycloak-first-passwords-<time>.txt)
//
// Re-runs are safe: a user that already exists (by username or email) is not
// re-created and keeps its password; its gradeiq role and giq_client are
// added if missing, and a giq_client that DIFFERS is reported, never changed.
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => {
  const i = argv.indexOf(n);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) { console.error(`${n} needs a value`); process.exit(1); }
  return v;
};
const DRY = flag("--dry");
const DB_PATH = opt("--db");
const EMAILS_PATH = opt("--emails");
const PW_OUT = opt("--passwords-out") || path.join(os.homedir(), `gradeiq-keycloak-first-passwords-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`);

const ISSUER = (process.env.KEYCLOAK_ISSUER || "").replace(/\/$/, "");
const M = /^(https?:\/\/[^/]+)\/realms\/([^/]+)$/.exec(ISSUER);
if (!M) { console.error("KEYCLOAK_ISSUER must be like https://host/realms/<realm>"); process.exit(1); }
const [, BASE, REALM] = M;
const CLIENT = "gradeiq";

// Built-in accounts (mirror lib/portalAuth.ts USERS).
const BUILTINS = [
  { username: "admin", role: "super", clientId: null },
  { username: "altaf", role: "super", clientId: null },
  { username: "denovo", role: "client", clientId: "denovo" },
  { username: "swapmoreus", role: "client", clientId: "swapmore" },
  { username: "swapmoreind", role: "client", clientId: "swapmore-in" },
  { username: "inzman", role: "client", clientId: "inzman" },
];
const KNOWN_CLIENTS = ["swapmore", "swapmore-in", "denovo", "inzman", "default"]; // lib/clients.ts

function loadStored() {
  if (!DB_PATH) {
    console.log("No --db given: importing the 6 built-in accounts only.");
    return [];
  }
  if (!fs.existsSync(DB_PATH)) { console.error(`--db ${DB_PATH}: no such file`); process.exit(1); }
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  const rows = db.prepare("SELECT username, role, client_id FROM portal_users").all();
  db.close();
  console.log(`${DB_PATH}: ${rows.length} stored portal user(s)`);
  return rows.map((r) => ({ username: r.username, role: r.role === "super" ? "super" : "client", clientId: r.client_id || null }));
}

function loadEmails() {
  if (!EMAILS_PATH) return {};
  const m = JSON.parse(fs.readFileSync(EMAILS_PATH, "utf8"));
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k.toLowerCase(), String(v).toLowerCase()]));
}

// ── prompts (admin credentials are typed, not stored) ───────────────────────
function askLine(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(q, (a) => { rl.close(); res(a.trim()); }));
}
function askHidden(q) {
  return new Promise((res) => {
    const stdin = process.stdin;
    process.stdout.write(q);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let buf = "";
    const onData = (chunk) => {
      for (const c of chunk) {
        if (c === "\r" || c === "\n") {
          stdin.setRawMode(false); stdin.pause(); stdin.off("data", onData);
          process.stdout.write("\n");
          return res(buf);
        }
        if (c === "\u0003") { stdin.setRawMode(false); process.stdout.write("\n"); process.exit(130); }
        if (c === "\u007f" || c === "\b") buf = buf.slice(0, -1);
        else buf += c;
      }
    };
    stdin.on("data", onData);
  });
}
async function adminCreds() {
  let user = process.env.KC_ADMIN_USER, pass = process.env.KC_ADMIN_PASS;
  if (user && pass) return { user, pass };
  if (!process.stdin.isTTY) { console.error("Set KC_ADMIN_USER and KC_ADMIN_PASS, or run this in a terminal to be asked."); process.exit(1); }
  if (!user) user = await askLine(`Keycloak admin username (master realm at ${BASE}): `);
  if (!pass) pass = await askHidden("Keycloak admin password (hidden): ");
  if (!user || !pass) { console.error("admin username and password are required"); process.exit(1); }
  return { user, pass };
}

async function adminToken({ user, pass }) {
  const body = new URLSearchParams({ grant_type: "password", client_id: "admin-cli", username: user, password: pass });
  const r = await fetch(`${BASE}/realms/master/protocol/openid-connect/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`admin login failed: HTTP ${r.status} (check the admin username/password and that ${BASE} is the Keycloak host)`);
  return (await r.json()).access_token;
}
const api = (tok) => async (method, p, json) => {
  const r = await fetch(`${BASE}/admin/realms/${REALM}${p}`, {
    method, headers: { authorization: `Bearer ${tok}`, ...(json !== undefined ? { "content-type": "application/json" } : {}) },
    body: json !== undefined ? JSON.stringify(json) : undefined, signal: AbortSignal.timeout(15_000),
  });
  return r;
};
const jsonOf = async (r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)));

const emailFor = (u, emails) => (emails[u.toLowerCase()] || (u.includes("@") ? u : `${u}@gradeiq.local`)).toLowerCase();
const tempPassword = () => crypto.randomBytes(15).toString("base64url"); // 20 chars

const main = async () => {
  const emails = loadEmails();
  const users = [...BUILTINS, ...loadStored().filter((s) => !BUILTINS.some((b) => b.username === s.username))];
  for (const u of users) {
    if (u.role === "client" && !KNOWN_CLIENTS.includes(u.clientId)) {
      console.error(`✗ ${u.username}: role client but client "${u.clientId}" is not a GradeIQ client — fix it in GradeIQ first`);
      process.exit(1);
    }
  }
  console.log(`${users.length} portal users → realm '${REALM}' client '${CLIENT}'${DRY ? " (DRY RUN — nothing is written)" : ""}`);
  const placeholders = users.filter((u) => !emails[u.username.toLowerCase()] && !u.username.includes("@")).length;
  if (placeholders) console.log(`NOTE: ${placeholders} user(s) get <username>@gradeiq.local placeholder emails (no mail can reach them) — pass --emails or set real ones in the console.`);

  const kc = api(await adminToken(await adminCreds()));
  const client = (await jsonOf(await kc("GET", `/clients?clientId=${CLIENT}`)))[0];
  if (!client) throw new Error(`client ${CLIENT} not found in realm ${REALM} — import realm-novetta.json first`);
  const clientRoles = Object.fromEntries((await jsonOf(await kc("GET", `/clients/${client.id}/roles`))).map((r) => [r.name, r]));
  for (const r of ["super", "client"]) if (!clientRoles[r]) throw new Error(`client ${CLIENT} has no "${r}" role`);

  const findUser = async (u, email) => {
    const byName = await jsonOf(await kc("GET", `/users?username=${encodeURIComponent(u.username)}&exact=true`));
    if (byName.length) return byName[0];
    const byEmail = await jsonOf(await kc("GET", `/users?email=${encodeURIComponent(email)}&exact=true`));
    return byEmail[0] || null;
  };
  const hasRole = async (id, role) =>
    (await jsonOf(await kc("GET", `/users/${id}/role-mappings/clients/${client.id}`))).some((r) => r.name === role);

  const issued = [];
  let created = 0, existing = 0, repaired = 0, failed = 0;
  for (const u of users) {
    const email = emailFor(u.username, emails);
    const label = `${u.username} [${u.role}${u.clientId ? ` · giq_client=${u.clientId}` : ""}]`;
    try {
      const found = await findUser(u, email);
      if (found) {
        existing++;
        const fixes = [];
        const theirs = found.attributes?.giq_client?.[0];
        if (u.clientId && theirs && theirs !== u.clientId) {
          console.log(`  ! ${label}: already exists with giq_client=${theirs} — NOT changed; decide in the console`);
          failed++;
          continue;
        }
        if (u.clientId && !theirs) fixes.push("giq_client");
        if (!(await hasRole(found.id, u.role))) fixes.push(`role ${u.role}`);
        if (!fixes.length) {
          console.log(`  = ${label}: already in the realm (password unchanged${found.email && found.email !== email ? `; email ${found.email}` : ""})`);
          continue;
        }
        if (DRY) { console.log(`  ~ ${label}: exists — would add ${fixes.join(" + ")}`); continue; }
        if (fixes.includes("giq_client")) {
          const full = await jsonOf(await kc("GET", `/users/${found.id}`));
          const r = await kc("PUT", `/users/${found.id}`, { ...full, attributes: { ...(full.attributes || {}), giq_client: [u.clientId] } });
          if (!r.ok) throw new Error(`setting giq_client: HTTP ${r.status}`);
        }
        if (fixes.some((f) => f.startsWith("role"))) {
          const r = await kc("POST", `/users/${found.id}/role-mappings/clients/${client.id}`, [{ id: clientRoles[u.role].id, name: u.role }]);
          if (!r.ok) throw new Error(`role mapping: HTTP ${r.status}`);
        }
        repaired++;
        console.log(`  ~ ${label}: existed — added ${fixes.join(" + ")} (password unchanged)`);
        continue;
      }
      if (DRY) { console.log(`  + ${label}: would create (${email}) with a temporary password`); created++; continue; }

      const cr = await kc("POST", "/users", {
        username: u.username, email, enabled: true, firstName: u.username,
        requiredActions: ["UPDATE_PASSWORD"],
        attributes: u.clientId ? { giq_client: [u.clientId] } : {},
      });
      // 409 = a user with that username or email appeared since the check: NOT a success.
      if (!cr.ok) throw new Error(cr.status === 409 ? "Keycloak says the username or email is taken (409)" : `create: HTTP ${cr.status}`);
      const nu = (await jsonOf(await kc("GET", `/users?username=${encodeURIComponent(u.username)}&exact=true`)))[0];
      if (!nu) throw new Error("created, but not found afterwards");
      const rm = await kc("POST", `/users/${nu.id}/role-mappings/clients/${client.id}`, [{ id: clientRoles[u.role].id, name: u.role }]);
      if (!rm.ok) throw new Error(`role mapping: HTTP ${rm.status}`);
      const pw = tempPassword();
      const rp = await kc("PUT", `/users/${nu.id}/reset-password`, { type: "password", value: pw, temporary: true });
      if (!rp.ok) throw new Error(`temporary password: HTTP ${rp.status}`);
      issued.push(`${u.username}\t${email}\t${pw}`);
      // Keycloak 24+ silently DROPS attributes the realm's user profile doesn't
      // declare. Without giq_client a client user signs in to nothing.
      if (u.clientId) {
        const back = await jsonOf(await kc("GET", `/users/${nu.id}`));
        if (back.attributes?.giq_client?.[0] !== u.clientId) {
          throw new Error("created, but Keycloak DROPPED giq_client — declare giq_client in Realm settings → User profile (edit: admin only), then re-run");
        }
      }
      created++;
      console.log(`  + ${label}: created (${email}), temporary password issued`);
    } catch (e) {
      failed++;
      console.log(`  ✗ ${label}: ${e instanceof Error ? e.message : e}`);
    }
  }

  if (issued.length) {
    fs.writeFileSync(PW_OUT, `# GradeIQ → Keycloak first-sign-in passwords (temporary; Keycloak asks for a new one at first login).\n# Hand each over privately, then DELETE this file.\n# username\temail\tpassword\n${issued.join("\n")}\n`, { mode: 0o600, flag: "wx" });
    fs.chmodSync(PW_OUT, 0o600);
    console.log(`\n${issued.length} temporary password(s) written to ${PW_OUT} (mode 600) — not shown here.`);
  }
  if (existing) {
    console.log("\nNOTE: users that already existed keep the password the realm gave them. realm-novetta.json seeds an");
    console.log("      `admin` whose password is written in that file — reset it (Credentials → Reset password,");
    console.log("      Temporary ON) or delete that user before staff sign in with Keycloak.");
  }
  console.log(`\n${DRY ? "would create" : "created"}=${created} existing=${existing} repaired=${repaired} failed=${failed}`);
  if (failed) process.exitCode = 1;
};
main().catch((e) => { console.error(`✗ ${e instanceof Error ? e.message : e}`); process.exit(1); });
