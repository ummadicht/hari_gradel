# GradeIQ staff sign-in → Keycloak (SUP-84 cutover runbook)

Who this is for: the owner, doing the cutover. Every command runs on **your Mac**
unless it says "on the VM". Nothing here needs a rebuild after the branch is
deployed: the switch is one env line plus a restart.

| | |
|---|---|
| App | `https://swapmore.com/apps/gradeiq` — VM `104.197.168.25`, `~/gradeiq`, pm2 `gradeiq` on :3700 |
| Realm | `novetta` (shared with SuperIQ), file `~/projects/keycloak-novetta/realm-novetta.json` |
| GradeIQ clients | `gradeiq` (staff login) · `gradeiq-svc` (GradeIQ → SuperIQ push) |
| Callers of GradeIQ | `pandas-api` (Pandas → `/api/customers/*`) · `swapmore-svc` (SwapMore → pricebook) |
| Switch | `GIQ_AUTH_MODE` in `~/gradeiq/.env.local`: `oidc` = Keycloak, `legacy` = passwords |

What does **not** change: the consumer inspection flow stays anonymous, and
SwapUp's `x-gradeiq-server-key` calls work the same in both modes.

---

## 0. Before you start

1. **Deploy this branch first**, with GIQ_AUTH_MODE left unset. With the flag
   unset nothing changes for staff: they keep the password sign-in, and the
   built-in accounts keep their current passwords. Release it with
   `bash deploy/release.sh --plan` then `bash deploy/release.sh` (see
   `deploy/README.md`): clean `--webpack` build with
   `NEXT_PUBLIC_BASE_PATH=/apps/gradeiq`, ships `.next` + changed sources, never
   touches `.env.local`. `deploy/deploy.sh` is retired and refuses to run.
   Check: `https://swapmore.com/apps/gradeiq/superadmin` still sends you to the
   password form.
2. Have to hand: the managed Keycloak's URL and its **master-realm admin**
   login (only for the console and the user import, never stored anywhere).

## 1. In the managed Keycloak console

1. **Import the realm without its seed user.** `realm-novetta.json` contains an
   `admin` user whose password is written in plain text in that file, and
   client secrets that have been committed. Strip the user before importing:
   ```bash
   jq 'del(.users)' ~/projects/keycloak-novetta/realm-novetta.json > /tmp/realm-import.json
   ```
   Then **Create realm → Resource file → `/tmp/realm-import.json`**, and
   `rm /tmp/realm-import.json`. (Service-account users for `gradeiq-svc`,
   `pandas-api` and `swapmore-svc` are created by Keycloak itself.) If that
   committed password is used anywhere else, change it there too.
2. **Declare the tenant attributes.** Realm settings → **User profile** →
   Create attribute, twice: `giq_client` and `erp_tenant`. For each one, set
   *Who can edit* to **admin** only and *Who can view* to **admin** only. Do
   **not** turn on "Unmanaged attributes": that would let users change their
   own tenant in the Account Console. Without this step Keycloak 24+ silently
   drops `giq_client`, and client users sign in to nothing. The import script
   catches that and stops.
3. **Regenerate every client secret.** The ones in the file are committed, so
   never use them. Clients → `gradeiq`, `gradeiq-svc`, `pandas-api`,
   `swapmore-svc`, `superiq-erp` → **Credentials → Regenerate**. Who needs
   each one:
   - `gradeiq` and `gradeiq-svc`: GradeIQ (step 2).
   - `pandas-api`: Pandas.
   - `swapmore-svc`: SwapMore's pricebook push.
   - `superiq-erp`: SuperIQ.
4. **Check the `gradeiq` client** (Clients → gradeiq → Settings):
   - Valid redirect URIs: `https://swapmore.com/apps/gradeiq/auth/callback`
   - Valid post logout redirect URIs: `https://swapmore.com/apps/gradeiq/*`
   - Remove the `http://localhost:3700/…` entries in production.
   - Advanced → PKCE method: **S256** (set by the import).
5. **Create your own super admin.** Users → Add user, with your real email,
   then:
   - Credentials → set a password.
   - Role mapping → Assign role → filter by clients → `gradeiq` **super**, plus
     any `superiq-erp` roles you need.
   - Required user actions → **Configure OTP**.
6. Optional: Realm settings → Email (SMTP). Without it "Forgot password"
   cannot send mail.

## 2. Put the Keycloak settings on the VM

```bash
cd ~/projects/gradeiq-live        # this branch checked out
bash deploy/set-keycloak-env.sh
```

It asks for four things:
- the issuer, `https://<keycloak-host>/realms/novetta`
- the `gradeiq` secret (hidden as you type)
- the `gradeiq-svc` secret (hidden as you type)
- optionally the SuperIQ ingest URL

It writes them into `~/gradeiq/.env.local` over ssh. Secrets go only over
ssh's stdin, never on a command line, and the file is mode 600. A backup of
the old file is kept next to it as `.env.local.bak-keycloak-<time>`. The
script does not change `GIQ_AUTH_MODE` and does not restart the app. It then
runs **`scripts/keycloak-preflight.mjs` on the VM**, which checks from the
server itself:
- the env names are set (values are never printed)
- discovery and JWKS answer within 3 s
- Keycloak's issuer string is exactly `KEYCLOAK_ISSUER`
- the client accepts the redirect URI and the post-logout URI
- Keycloak accepts the `gradeiq` secret
- `gradeiq-svc` gets a realm-signed token with `aud` superiq-erp
- what mode the running app is in
- whether pm2 holds env that would override the file

You want `READY`. Each FAIL line says in plain English what to fix. Re-running
the script is safe.

You can re-run the preflight on its own at any time:
`ssh -i ~/.ssh/denovo_gcp ammar@104.197.168.25 'cd ~/gradeiq && node --input-type=module -' < scripts/keycloak-preflight.mjs`

> At the next restart, machine-to-machine (M2M) auth goes live: Pandas, the
> SwapMore pricebook and push-to-SuperIQ. It needs only `KEYCLOAK_ISSUER`, not
> the flag. Staff sign-in stays on passwords until step 4.
>
> It also REPLACES the pre-Keycloak secrets (lib/m2m.ts): from that restart the
> pricebook route no longer accepts SwapMore's `x-sync-secret`
> (`PRICEBOOK_SYNC_SECRET`), and push-to-SuperIQ sends a `gradeiq-svc` token
> instead of `SUPERIQ_TOKEN`. Switch SwapMore to `swapmore-svc` tokens and
> SuperIQ's ingest to keycloak mode at the same time, or both feeds stop.

## 3. Import the staff users

1. **How many stored users does prod have?** Read-only, on the VM:
   ```bash
   ssh -i ~/.ssh/denovo_gcp ammar@104.197.168.25 \
     "cd ~/gradeiq && node -e \"const D=require('better-sqlite3');const d=new D('data/gradeiq.db',{readonly:true});console.log(d.prepare('select count(*) n from portal_users').get().n)\""
   ```
   It was **0** on 2026-10-20. If it is still 0, import without `--db`: only
   the 6 built-ins are imported. If it is more than 0, take a consistent copy:
   run `.backup('/home/ammar/gradeiq-users-copy.db')` on the VM with
   better-sqlite3, scp it to the Mac, delete it on the VM, and pass
   `--db <copy>`. Never use `~/projects/gradeiq/data/gradeiq.db`: that is a
   diverged local DB with users that are not on prod.
2. Optional: create `emails.json`, for example `{"altaf": "altaf@…", "denovo": "ops@…"}`.
   Anyone not listed gets a placeholder `<username>@gradeiq.local`, which can't
   receive mail.
3. Rehearse, then run for real. It asks for the master-realm admin username
   and password (hidden as you type); never put them in a file:
   ```bash
   export KEYCLOAK_ISSUER=https://<keycloak-host>/realms/novetta
   node scripts/import-users-to-keycloak.mjs --dry [--db <copy>] [--emails emails.json]
   node scripts/import-users-to-keycloak.mjs       [--db <copy>] [--emails emails.json]
   ```
   `--dry` logs in and reads, but writes nothing. The real run creates each
   user with:
   - their `gradeiq` role (`super` or `client`)
   - `giq_client` for client users
   - a random **temporary** password; Keycloak makes them choose their own at
     first login

   The passwords go **only** to `~/gradeiq-keycloak-first-passwords-<time>.txt`
   (mode 600, never printed). Hand each one over privately, then delete the
   file. A user that already exists is never re-created and keeps its password:
   the script only adds a missing role or `giq_client`, and it reports a
   `giq_client` that differs without changing it.
4. Check one client user in the console. On Attributes you should see
   `giq_client`. On Role mapping you should see the `gradeiq` `client` role.

## 4. Flip to Keycloak

```bash
bash deploy/set-auth-mode.sh oidc
```

The script refuses to flip unless both of these pass:
- the build on the VM has the SUP-84 fixes
- the preflight is READY

Then it:
1. sets `GIQ_AUTH_MODE=oidc` (backup kept, mode 600)
2. runs `pm2 restart gradeiq`, never with `--update-env`
3. confirms that a signed-out visit to `/superadmin` now goes to `/auth/login`

## 5. Smoke test (prod)

1. In a private window, open `https://swapmore.com/apps/gradeiq/superadmin`.
   You should land on the Keycloak login. Sign in as your super admin and you
   should be back on the console with **All clients**.
2. Sign in as a client user, for example `denovo` with its temporary password,
   and set a new one. You should see only that tenant. `/apps/gradeiq/console/swapmore`
   should give a 404.
3. Sign in as a SuperIQ-only user (no `gradeiq` role). You should see "Your
   account doesn't have access to GradeIQ", with no session created.
4. Click the console's **Sign out**. You should land on GradeIQ `/login`, and
   reopening `/superadmin` should ask Keycloak for the password again.
5. The old password routes are gone. Both of these should print `404`:
   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'content-type: application/json' \
     -d '{"username":"admin","password":"admin"}' https://swapmore.com/apps/gradeiq/api/portal/login
   curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'content-type: application/json' \
     -d '{"user":"denovo","pass":"denovo"}' https://swapmore.com/apps/gradeiq/api/enterprise/login
   ```
6. M2M:
   - In the console, use **Push to SuperIQ** on a session that has an IMEI.
     It should return ok (this needs `SUPERIQ_DIAGNOSTICS_URL`).
   - Pandas or SwapMore: get a token with
     `curl -s -d grant_type=client_credentials -d client_id=pandas-api --data-urlencode client_secret=… $KEYCLOAK_ISSUER/protocol/openid-connect/token`,
     then call `GET /apps/gradeiq/api/customers/sessions/<id>` with
     `Authorization: Bearer <token>`. You should get 200.
7. SwapUp's IMEI lookup (`x-gradeiq-server-key`) still answers.
8. On the VM, `pm2 logs gradeiq --lines 200 | grep '\[auth\]'` shows only
   what you expect: refusals name the user and the reason, and outages name
   the cause.

## 6. Rollback (no rebuild)

```bash
bash deploy/set-auth-mode.sh legacy
```

- Staff are back on the password sign-in, **including the built-in default
  passwords** (`admin/admin` …), because no interim password change was
  chosen. For a rollback longer than a few minutes, consider setting
  `PORTAL_PW_ADMIN` and the others in `.env.local`, plus a restart.
- Keycloak sessions that already exist keep working, so nobody is signed out.
  M2M is unaffected.

What happens in other cases, with no action from you:

| Situation | What staff see | What still works | Fix |
|---|---|---|---|
| Keycloak down | "Single sign-on isn't answering" with a **Try again** button. A hung Keycloak gives up after 4 s, then fails fast for 15 s. | Signed-in sessions. Password sign-in does **not** reopen. | Wait, or roll back. |
| `KEYCLOAK_ISSUER`, the secret or the redirect URI missing or wrong | "Single sign-on isn't set up correctly" (the log names the missing env or the mismatch) | Signed-in sessions | Re-run `deploy/set-keycloak-env.sh` + restart, or roll back. |
| `GIQ_AUTH_MODE` **lost** after the cutover (e.g. `.env.local` rewritten) | Password form with "the built-in default passwords are switched off" | Signed-in sessions, plus any password an operator set (`PORTAL_PW_*`, stored users) | Set the flag explicitly: `deploy/set-auth-mode.sh oidc` (or `legacy`). |

The last row is deliberate. After the first Keycloak sign-in, the server
records the cutover in its DB (`auth_state`). From then on an *unset* flag
never quietly re-opens `admin/admin`; only an explicit
`GIQ_AUTH_MODE=legacy` does.

## 7. Fallback window, then cleanup (follow-up ticket)

Keep the legacy code for **one release** after the cutover. When a release has
gone by without a rollback, open the cleanup, in this order:

1. **Delete the password sign-in code:**
   - `lib/entAuth.ts` and `lib/customerAuth.ts`
   - the password half of `lib/portalAuth.ts`: `USERS` defaults, `checkLogin`,
     `tokenFor`, the stored-user functions, the legacy branch of `portalUser`,
     and `builtinDefaultsAllowed`
   - the routes `app/api/portal/login`, `app/api/enterprise/login` and
     `app/api/enterprise/logout`
   - the UI: `app/components/EnterpriseLogin.tsx`,
     `app/login/LegacyLoginForm.tsx`, the in-page `Login` in
     `app/superadmin/page.tsx`, and the login form in
     `app/channel/retail/RetailDesk.tsx`
   - the 410 stub `app/api/customers/auth/token`, once Pandas has confirmed
     they use Keycloak tokens
2. **Delete the legacy branch of the switch:**
   - in `lib/auth-mode.ts` / `middleware.ts`: the legacy branch and `LEGACY_COOKIES`
   - the `auth_state` cutover guard
   - the create/reset ops of `/api/portal/users` and the Users panel; people
     are managed in Keycloak
3. **Retire the env** (see `ENV-keycloak.md`): `PANDAS_CLIENT_ID`,
   `PANDAS_CLIENT_SECRET`, `PANDAS_SIGNING_KEY`, `PRICEBOOK_SYNC_SECRET` and
   `SUPERIQ_TOKEN` (with the no-Keycloak branch of lib/m2m.ts), `ENT_USER`,
   `ENT_PASS`, `PORTAL_PW_*`, and then `GIQ_AUTH_MODE` itself.
4. Export, then drop, the `portal_users` table.

## Testing this without a real Keycloak

`bash scripts/e2e-keycloak/run.sh` runs a local, Keycloak-shaped mock
(`scripts/e2e-keycloak/mock-idp.mjs`, fed by a secret-free copy of the realm's
client definitions). It covers the whole cutover: this runbook's scripts
through a stand-in for ssh, the flip and the rollback on the same build,
Keycloak down, hung and misconfigured, tenant scope, M2M, and the user import.
The header of `run.sh` has the details.
