# Staging-readiness changelog

Base: `QatarMobile_Supabase_Railway_Phase2.zip` (SHA-256 `28130253…c8b0d54a`). No redesign; the architecture (frontend → Railway API → Supabase) is unchanged. Production, production data and the Apps Script deployment were not touched.

> The brief said the Phase 2 ZIP would be uploaded; it did not arrive with the message. I worked from the identical file produced in the previous step (same SHA-256).

## Owner decision implemented: staff sign in with email + password
Asked and confirmed during this stage (the Phase 2 build used phone OTP for everyone). Customers keep the 3.1 SMS code.
- **API:** `POST /v1/auth/staff/login`, `/v1/auth/staff/reset/start`, `/v1/auth/staff/reset/finish` (`apps/api/src/services/staff-auth.ts`). Staff Auth users are created by the API with the secret key the first time a reset code is requested for an ACTIVE staff address (covers admin-created, approved and Sheets-imported staff). Password policy 12+ characters, letters + digit, not the address.
- **Who counts as staff:** only a Supabase **password** session (`amr`) of the Auth user the API linked to the profile, carrying the profile's current email. Phone-code and password-recovery sessions are refused; staff are never linked by phone. No SMS is sent to a staff number, even via Supabase Auth directly (hook).
- **Limits:** wrong passwords pause an address after 5 in 15 min; reset e-mails 1/60 s, 5/hour; wrong reset codes 5 per code. Reserved under a per-address lock (concurrency-tested). Addresses stored hashed; passwords/codes never stored or logged.
- **Staff management:** email required, validated and unique (case-insensitive) when creating, approving or applying; changing it ends sessions and the old password never carries over.
- **Database:** migration `…0800_staff_email_sign_in.sql` (email format check, unique index, `staff_auth_attempts`, RLS on, no client grants).
- **Frontend:** `apps/web/qm-staff-signin.js`, injected after the unchanged `Auth.html` (checksums still verified): "Staff sign-in (email and password)" and "Set or reset password" (e-mailed 6-digit code).
- **Config:** `STAFF_SIGN_IN` (unset = `password` in staging/production, `phone` in dev/test; `phone` refused in production), `STAFF_PASSWORD_MIN_LENGTH`, `STAFF_LOGIN_MAX_FAILURES`; web build `QM_STAFF_SIGN_IN`; `/ready` reports `staffSignIn`.
- **Seed/verification:** staging seed gives seeded staff fictional `@staff.example.test` addresses; the testers file maps staff to work emails; `verify:staging --login` asks staff for a password (or `reset`) without echo; new checks P-07, A-10…A-14.
- **Importer:** a malformed staff email in the Sheets export is reported per row (never stored or guessed).
- **Emulation:** GoTrue now sends the real "Reset password" e-mail to an SMTP sink; new checks E-11…E-16 (incl. a stray direct sign-up with a staff address, address change, recovery session refused, pause with the real Auth server).
- **Independent review of this feature (second reviewer, two rounds) — fixed:** Supabase's per-IP limits shared by all users (opt-in `Sb-Forwarded-For` with the new secret key; a Supabase 429 no longer costs the person an attempt — customers included); "set or reset" now replies before any staff-dependent work (no timing difference) with a lock-protected platform e-mail cap; an administrator's email change unlinks the Auth user at once (old password and refresh tokens dead); leftover Auth users removed only if never confirmed or API-managed (`app_metadata.qm_staff`); ASCII-only addresses; a 200 without a session is "unavailable"; recovery uses the session's user id; 90-day retention for `staff_auth_attempts`; clear duplicate-email message. Remaining (documented): forwarding must be switched on and verified on staging; the hourly e-mail budget can be consumed by someone who knows staff addresses.
- **Cloud prerequisites added:** custom SMTP (Supabase's built-in e-mail reaches only project team members, 2/hour), Email provider + password policy, Reset-password template with `{{ .Token }}` — `CLOUD_CONFIGURATION.md` §2.

## Blockers found and fixed
| # | Finding | How it was found | Fix |
|---|---|---|---|
| 1 | **Railway config-as-code is deprecated**: new services cannot use `railway.json`, and existing ones stop on 2026-12-01; `NIXPACKS` is no longer a listed builder. | Railway docs | `railway.json` removed; **Dockerfile** (pinned base image by digest, multi-stage, non-root, prod deps only) + `.railway/railway.ts` (IaC, typed against `railway@3.11.0`, refuses the production environment, secrets `preserve()`d). |
| 2 | **Supabase new API keys are not JWTs**: they must go in `apikey`, not `Authorization: Bearer`. The API sent both. | Supabase docs | Keys sent only in `apikey` unless they are legacy JWT keys; new names `SUPABASE_PUBLISHABLE_KEY` / `SUPABASE_SECRET_KEY` accepted. |
| 3 | **Send SMS hook refusals were mis-signalled**: a non-2xx answer becomes a generic 500 "Error running hook" in Supabase Auth (and 429/503 get retried). | Real Supabase Auth (GoTrue v2.170.0) in the local emulation | Refusals are returned as `200 {"error":{"http_code","message"}}`; Supabase Auth now relays e.g. 429 "Too many code requests" in ~15 ms. |
| 4 | **Database TLS could not be verified** against Supabase's own CA, and `sslmode=` in a pasted URL silently overrode the TLS setting. | Code review + emulation | `DATABASE_SSL_CA` (PEM or base64); `ssl*` URL parameters stripped; verified end-to-end (no CA → refused). |
| 5 | **Supabase's database name is always `postgres`**, so the import tool's "confirm by database name" could not tell staging from production. | Supabase docs | All writing operator commands confirm by **project ref**, print the target without the password, refuse `QM_PROTECTED_TARGETS`, and refuse the transaction pooler for session work. `npm run migrate` gained the same guard (it had none). |
| 6 | **Migrations had only been run as a superuser.** On Supabase, `postgres` is not a superuser; creating a policy on `storage.objects` needs ownership. | Emulation with Supabase-like roles | The OPTIONAL catalogue read policy is skipped with a WARNING instead of failing; everything else stays strict. Migrations now pass as a non-superuser `postgres`. |
| 7 | **Future tables would be readable by the Data API**: Supabase grants new public objects to `anon`/`authenticated` by default. The view `settlement_lines` and identity sequences kept those grants. | Review | Migration `…0700`: grants revoked; default privileges for new objects removed (fail closed). |
| 8 | **Idempotency keys were optional** in staging/production. | Brief | Default `true` in staging/production; `false` refused there; missing key → **428 `IDEMPOTENCY_KEY_REQUIRED`** before anything runs. Confirmed the 3.1 client sends keys for exactly the 18 idempotent actions. |
| 9 | **Staging could start without SMS** (`SMS_PROVIDER=none`), i.e. with no way to sign in. | Review | Staging/production require `twilio` or `custom`; `/ready` reports SMS. |
| 10 | Network errors reaching Supabase Auth or Storage became 500s; an Auth outage during refresh signed people out. | Emulation | Clean 503 "temporarily unavailable"; refresh failures due to an outage no longer force sign-out. |
| 11 | SMS provider timeout (10 s) exceeded Supabase's 5 s hook budget. | Supabase docs | 4 s. |
| 12 | Broken pooled connections were returned to the pool. | Review | Connection-level errors destroy the client; TCP keep-alive on. |
| 13 | `--resume` with an unknown or finished run gave a raw foreign-key error / re-ran. | Migration rehearsal | Clear refusal; only unfinished APPLY runs resume. |
| 14 | `KEY=` (empty, from a copied template) could switch a protection off. | Review | Empty variables are treated as unset. |

## Independent review (second reviewer, this stage) — fixed
- Operator target guard: URL parameters (`host`, `port`, `user`, `options`…), host-less URLs and `PG*` variables that could redirect a command are refused; an empty confirmation never matches.
- `import:files`: the Storage project must be the database's project and not protected.
- `.dockerignore` patterns now apply at any depth; the image copies only `supabase/migrations` and `supabase/seed`.
- `verify:staging`: refuses `--expect-environment production`, checks the API and Supabase hosts against `QM_PROTECTED_TARGETS`, binds the DB to the same project, and runs every DB query in an explicit READ ONLY transaction.
- Migration `…0700`: PUBLIC's default EXECUTE on new functions removed (global default).
- Send SMS hook: database failures and post-send bookkeeping errors no longer produce a 5xx; no per-IP 429 on the hook route.
- Main-module detection works on Windows and paths with spaces; operator TLS defaults to verified for remote targets (`disable` refused remotely); invalid `DATABASE_SSL_CA` is named; trailing slash on `SUPABASE_URL` handled; IaC file manages only an environment named `staging` and declares optional variables.

## Smaller changes
- JWT: legacy HS256 secret and JWKS can be configured **together** (signing-key rotation); algorithm chosen per key source (no alg confusion); `role` must be `authenticated`; anonymous sign-ins refused.
- Production refuses `DATABASE_SSL=no-verify` and `LOG_LEVEL=debug|trace`; https required for Supabase/JWKS URLs.
- `/ready` adds `environment`, `version`, `idempotencyKeysRequired` (booleans/names only).
- Logs scrub `sb_secret_…`/`sb_publishable_…` keys and passwords in connection strings.
- Migration runner prints migration WARNINGs; the test template is now built with the real runner.
- Version label `4.1.0-staging`.

## Added
- `npm run seed:staging` + `supabase/seed/staging_extra.sql` (second partner/branch, extra admins/staff/customer; tester-number mapping from a git-ignored file).
- `npm run verify:staging` — the cloud verification (platform, auth/JWT, idempotency, full vertical flow, negative, concurrency, direct RLS through the Data API, Storage, read-only DB consistency), honest PASS/FAIL/SKIPPED report.
- `npm run rehearse:staging` — runs that verification against a local server.
- `npm run emulate:staging` — the shipped Docker image + real Supabase Auth (GoTrue) + real PostgREST + TLS PostgreSQL with Supabase-like roles, plus browser sign-in.
- `npm run rehearse:migration` — the migration CLIs end to end on fictional exports, including a killed-and-resumed run.
- `npm run openapi` → `docs/openapi.json` (OpenAPI 3.1, validated and drift-checked in tests).
- Docs: `STAGING_DEPLOYMENT`, `CLOUD_CONFIGURATION`, `STAGING_TEST_RESULTS`, `PRE_PRODUCTION_CHECKLIST`, `API_HANDOFF`, this changelog.
- Tests: 129 → **185** automated (staging-readiness unit + integration, OpenAPI, Supabase key handling, JWT rotation, staff email + password sign-in).

## Unchanged on purpose
Business rules (3.1), roles, workflows, money handling, the frontend (checksum-verified 3.1 HTML; staff sign-in is an added script), phone-OTP sign-in for customers.
