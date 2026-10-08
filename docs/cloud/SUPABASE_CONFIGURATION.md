# Supabase configuration — staging (as deployed 2026-10-08)

| | |
|---|---|
| Organisation | Qatar Mobile (Pro plan) |
| Project | **QM Trade-in Project** — ref `ytniownkhjolgfplegsv` |
| Region | ap-southeast-1 (Singapore) |
| Postgres | 17.6, status Healthy |
| Dashboard label | "Production" — **used as staging by owner decision**; holds fictional data and test accounts only (see PRE_PRODUCTION_BLOCKERS #1) |
| API URL | `https://ytniownkhjolgfplegsv.supabase.co` |
| JWT signing | asymmetric **ES256** keys; JWKS `…/auth/v1/.well-known/jwks.json`; no legacy JWT secret used |
| Keys in use | publishable `sb_publishable_7Qnv…` (browser-safe) · secret `sb_secret_…` (Railway only, sealed) |

## Database
- **Migrations (11)**, ledger `app.schema_migrations`, each row = SHA-256 of the file:
  0100 core schema · 0200 business rules · 0300 RLS · 0400 storage · 0500 reporting/views · 0600 RLS refinements · 0700 privileges hardening · 0800 staff email sign-in · **0900 sequence grants** · **1000 function search_path** · **1100 API runtime role**.
- State verified identical to a fresh build of the repository (13-category catalogue fingerprint; 37 tables, 27 policies, 23 triggers, 19 functions, 93 indexes).
- **RLS** on every public table. 12 internal tables have RLS and **no** policy on purpose (deny-all to clients; advisor INFO).
- **Client grants:** `anon`/`authenticated` have no INSERT/UPDATE/DELETE/TRUNCATE on public tables, no sequence usage, no EXECUTE on internal functions; future objects are covered by default-privilege changes.
- **Roles:** `postgres` = owner (schema changes only, operator use). **`qm_api`** = the API's login: BYPASSRLS, DML on `public`/`app`, EXECUTE on `app` functions, SELECT on `auth.users`; no CREATE on any schema, owns nothing, no TRUNCATE, connection limit 20. Password set out-of-band (SCRAM verifier only; not in the repository).
- **Connection used by Railway:** direct host `db.ytniownkhjolgfplegsv.supabase.co:5432` (IPv6), TLS verified with Supabase Root 2021 CA. Transaction pooler (6543) is refused by the migration tool.
- Extensions: Supabase defaults (pgcrypto in `extensions`, uuid-ossp, pg_stat_statements, supabase_vault).

## Storage
| Bucket | Public | Size limit | Types | Writes |
|---|---|---|---|---|
| `catalog-media` | yes | 2 MB | png, jpeg, gif, webp, heic, heif, bmp | API only |
| `inspection-photos` | **no** | 4 MB | same | API only; read through short-lived signed URLs |
SVG and disguised files are refused (S-01).

## Auth — current state and required settings
Current state observed from behaviour (the connector cannot read Auth settings):

| Setting | Observed now | Required | Where |
|---|---|---|---|
| Email provider | ON (password sign-in works) | ON, "Confirm email" ON | Authentication → Sign In / Providers → Email |
| Phone provider | **OFF** ("Phone logins are disabled") | ON when SMS is ready, OTP length 6, expiry 300 s | Providers → Phone |
| Send SMS hook | not set | `https://<api>/v1/hooks/send-sms` + secret → Railway `SEND_SMS_HOOK_SECRET` | Authentication → Hooks |
| Email sender | Supabase built-in (delivers only to team members, low hourly limit) | custom sender — see `SMTP_CONFIGURATION.md` | Authentication → Emails / Hooks |
| Reset Password template | default | must contain `{{ .Token }}` (the 6-digit code the API verifies) | Authentication → Emails → Templates |
| Refresh-token reuse detection | **appears OFF** (X-05) | ON, reuse interval ~10 s | Authentication → Sessions / Attack protection *(menu names vary — verify)* |
| Leaked-password protection | **OFF** (advisor WARN) | ON *(plan-dependent — verify)* | Authentication → Providers → Email / Attack protection |
| Minimum password length | unknown | 12 | same |
| IP address forwarding | **OFF** | ON, then Railway `SUPABASE_AUTH_FORWARD_CLIENT_IP=true` | Authentication → Rate Limits |
| Anonymous sign-ins | unknown | OFF (the API refuses anonymous tokens anyway) | Providers |
| JWT expiry | 3600 s (observed) | 3600 s is fine | JWT Keys |

## Test fixtures present in this project (staging only)
- Fictional seed: partners `VND-001`, `VND-002`, branches, catalogue, prices, 9 staff profiles (`usr-0000N@staff.example.test`), 2 customers.
- Supabase Auth users: 9 staff (created by the API through the admin API) + 2 customers (`cus-0000N@customer.example.test`, created directly for testing). Their test passwords are scrambled after the verification run; nobody holds a working password for them.
- Trade-ins, vouchers, collections and settlements created by the verification run (test IMEIs prefixed `99`).
