# GradeIQ — Keycloak env

Staff/portal login is delegated to Keycloak (OIDC) when `GIQ_AUTH_MODE=oidc`; machine callers use `client_credentials`. All values come from the managed Keycloak console — never commit them. Cutover steps: **docs/KEYCLOAK-CUTOVER.md** (`deploy/set-keycloak-env.sh` writes these on the VM, `deploy/set-auth-mode.sh` flips the mode, `scripts/keycloak-preflight.mjs` checks them).

| Var | Purpose |
| --- | --- |
| `GIQ_AUTH_MODE` | `oidc` = staff sign in with Keycloak (password routes 404). `legacy` = explicit rollback to the password logins. Unset = legacy until the first Keycloak sign-in; after it, built-in default passwords stay off. Runtime flag: edit `.env.local` + `pm2 restart gradeiq` (never `--update-env`), no rebuild |
| `KEYCLOAK_ISSUER` | realm issuer, e.g. `https://<host>/realms/novetta` (discovery + JWKS). Must equal what Keycloak reports as `issuer` |
| `OIDC_CLIENT_ID` | `gradeiq` (confidential human-login client; default) |
| `OIDC_CLIENT_SECRET` | that client's secret |
| `OIDC_REDIRECT_URI` | `https://swapmore.com/apps/gradeiq/auth/callback` (+ localhost `http://localhost:3700/auth/callback` in dev) |
| `SVC_CLIENT_ID` / `SVC_CLIENT_SECRET` | `gradeiq-svc` — the outbound M2M client used by `push-superiq` to authenticate to SuperIQ |
| `SUPERIQ_DIAGNOSTICS_URL` | SuperIQ ingest URL, e.g. `https://wholecellmarket.com/api/diagnostics/ingest` |
| `PUBLIC_ORIGIN` | optional, e.g. `https://swapmore.com` — pins the origin used in sign-in redirects and exported URLs; by default it comes from Caddy's `X-Forwarded-Host`/`-Proto` |
| `NEXT_PUBLIC_BASE_PATH` | `/apps/gradeiq` — must stay in the VM's `.env.local` (re-read at start; without it every route 404s) |
| `KC_ADMIN_USER` / `KC_ADMIN_PASS` | Keycloak master-realm admin — ONLY for `scripts/import-users-to-keycloak.mjs`, which asks for them when unset; never store them in a file |

Notes:
- Inbound M2M is verified against JWKS: `/api/customers/*` expects client `pandas-api` (aud `gradeiq`); `/api/clients/[id]/pricebook` expects `swapmore-svc` (aud `gradeiq`). M2M is on Keycloak exactly when `KEYCLOAK_ISSUER` is set (independent of `GIQ_AUTH_MODE`); with Keycloak unreachable and no cached keys, bearer calls answer 503.
- Without `KEYCLOAK_ISSUER` (today's prod, lib/m2m.ts): the pricebook push is checked against `PRICEBOOK_SYNC_SECRET` (SwapMore's `x-sync-secret` header, constant-time; unset = 503), push-to-SuperIQ sends `SUPERIQ_TOKEN` as the Bearer (SuperIQ's legacy ingest compares it with its Phonecheck webhook secret; unset = 503 "not configured"), and `/api/customers/*` answers 503 "not configured". Setting the issuer switches all three to Keycloak at the next restart, so SwapMore and SuperIQ must move to Keycloak tokens at the same time.
- Staff access is granted, never assumed: gradeiq client role `super` (all clients), or `client` plus a known `giq_client` attribute (one client). Anyone else in the shared realm gets no session.
- The consumer inspection flow (Landing → /inspect → /staff/[id] and all `/api/sessions/*` writes) is anonymous and needs no Keycloak. SwapUp's `x-gradeiq-server-key` (`GRADEIQ_SERVER_KEY`) and CounterIQ's `x-gradeiq-retail-key` (`GRADEIQ_RETAIL_KEY`, paid IMEI lookups on session create only) work in both modes.
- Retired env (safe to remove after the one-release fallback window): `PANDAS_CLIENT_ID/SECRET/SIGNING_KEY`, `ENT_USER/ENT_PASS`, `PORTAL_PW_*`; `PRICEBOOK_SYNC_SECRET` and `SUPERIQ_TOKEN` only once `KEYCLOAK_ISSUER` is set and SwapMore and SuperIQ use Keycloak tokens.
