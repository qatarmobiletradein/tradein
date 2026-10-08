# Railway configuration — staging (as deployed 2026-10-08)

| Setting | Value |
|---|---|
| Workspace | Qatar Mobile's Projects |
| Project | QatarMobile-TradeIn-Staging (`14f9e0c0-48ef-4923-a6ce-07df640485c6`) — the only project; do not create a second |
| Environment | `staging` (`de6dd406-72d3-44e3-bf61-360d86bde3a1`) |
| Service | `qm-api` (`f856fefe-ef33-4bcf-a0fe-3e3899662089`) |
| Region / replicas | `asia-southeast1-eqsg3a` (Singapore) × 1 |
| Source | GitHub `qatarmobiletradein/tradein`, branch `main`, deploys on push (Railway GitHub app installed on the `qatarmobiletradein` account) |
| Build | `Dockerfile` at the repository root (multi-stage, `node:22.22.0-bookworm-slim` pinned by digest; runs as user `node`) |
| Start command | `node dist/apps/api/src/server.js` |
| Pre-deploy | `npm run migrate` — with the `qm_api` role this only **verifies** the ledger (checksums) and stops the deploy if the code expects a migration the database does not have. Schema changes are applied with the owner credential, never by the deploy. |
| Health check | `GET /ready`, timeout 60 s |
| Restart policy | on failure, max 5 |
| Draining | 30 s (graceful SIGTERM) |
| Outbound IPv6 | **enabled** (needed for Supabase's IPv6 direct host) |
| Public domain | `qm-api-staging.up.railway.app` (Railway-generated). No custom domain. |

## Variables on `qm-api` (names only — values never written here)
| Name | Value / source | Secret |
|---|---|---|
| `APP_ENV` | `staging` | no |
| `NODE_ENV` | `production` | no |
| `LOG_LEVEL` | `info` | no |
| `TRUST_PROXY_HOPS` | `1` (Railway edge; verified not spoofable, X-07) | no |
| `DATABASE_URL` | `postgresql://qm_api:…@db.ytniownkhjolgfplegsv.supabase.co:5432/postgres` | **SECRET — sealed** |
| `DATABASE_SSL` | `require` | no |
| `DATABASE_SSL_CA` | Supabase Root 2021 CA (base64 PEM) | no (public certificate) |
| `DATABASE_POOL_MAX` | `10` (role connection limit is 20) | no |
| `SUPABASE_URL` | `https://ytniownkhjolgfplegsv.supabase.co` | no |
| `SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_…` | no (server-side only here) |
| `SUPABASE_SECRET_KEY` | `sb_secret_…` (entered by the owner) | **SECRET — sealed** |
| `SUPABASE_JWKS_URL` | `https://ytniownkhjolgfplegsv.supabase.co/auth/v1/.well-known/jwks.json` | no |
| `SUPABASE_JWT_ISSUER` | `https://ytniownkhjolgfplegsv.supabase.co/auth/v1` | no |
| `SUPABASE_JWT_AUDIENCE` | `authenticated` | no |
| `IDEMPOTENCY_KEY_REQUIRED` | `true` | no |
| `STAFF_SIGN_IN` | `password` | no |
| `STAFF_PASSWORD_MIN_LENGTH` | `12` | no |
| `STAFF_LOGIN_MAX_FAILURES` | `5` | no |
| `STAFF_RESET_EMAILS_PER_HOUR` | `25` | no |
| `SMS_PROVIDER` | `none` (allowed in staging only; production refuses it) | no |
| `CORS_ALLOWED_ORIGINS` | `https://qm-api-staging.up.railway.app` — **placeholder** until a staging frontend exists | no |
| `MIGRATION_TARGET_CONFIRM` | `ytniownkhjolgfplegsv` (guard: migrate/seed refuse any other target) | no |

Not set (by design for now): `SEND_SMS_HOOK_SECRET`, Twilio variables, Microsoft Graph variables (`SMTP_CONFIGURATION.md`), `SUPABASE_AUTH_FORWARD_CLIENT_IP` (needs the Supabase setting first), `QM_PROTECTED_TARGETS` (set it to the production project ref once one exists).

## How to deploy / roll back
- **Deploy:** push to `main` (or Railway → qm-api → Deployments → Redeploy).
- **Roll back:** Railway → qm-api → Deployments → choose a previous SUCCESS deployment → Rollback. Database migrations are forward-only; a rollback of code never undoes a migration.
- **New migration:** apply it with the owner credential (operator terminal, `MIGRATION_TARGET_CONFIRM=<ref> npm run migrate`), *then* deploy the code. The pre-deploy check stops a deploy that is ahead of the database.
- **Logs:** Railway → qm-api → Logs (no tokens, codes or passwords are logged; request bodies are not logged).
