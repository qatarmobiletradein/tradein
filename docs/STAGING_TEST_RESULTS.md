# Staging-readiness test results

Executed 2026-10-08 in an isolated cloud workspace with fictional data only. **Nothing ran on Supabase Cloud or Railway** — no account was available. The production Apps Script system, production data, DNS, URLs and SMS were not touched.

Environment: Node v22.22.0, PostgreSQL 16.15 (throwaway clusters), Docker 29.8.2, Chromium (Playwright), images `node:22.22.0-bookworm-slim@sha256:dd9d2197…`, `supabase/gotrue:v2.170.0` (open-source Supabase Auth, built 2025-03-06), `postgrest/postgrest:v12.2.12` (built 2024-11-06). Hosted Supabase may run newer versions of both.

## Summary by where it ran

| Where | What | Result |
|---|---|---|
| **TESTED ON REAL SUPABASE** | — | **Nothing. NOT EXECUTED.** |
| **TESTED ON REAL RAILWAY** | — | **Nothing. NOT EXECUTED.** |
| Local — automated suite | `npm run typecheck`, `npm run build`, `npm run test:db` | pass · pass · **185 / 185** (14 files) |
| Local — without a database | `npm test` | 76 passed, 109 skipped (DB suites skip themselves) |
| Local — browser | `npm run test:ui` (3.1 screens + staff sign-in → API) | **8 / 8** (phone mode 3, email + password mode 5) |
| Local — staging verification rehearsal | `npm run rehearse:staging` (the real `verify-staging` script vs a local HTTP server, stand-ins for Auth/Storage, `STAFF_SIGN_IN=password`) | **77 PASS · 0 FAIL · 3 SKIPPED** (no Data API → RLS-over-REST and direct Storage checks skipped) |
| Local — **cloud emulation** | `npm run emulate:staging` (shipped Docker image + real GoTrue + real PostgREST + TLS PostgreSQL with Supabase-like roles + emulated gateway/Storage/Twilio/SMTP) | verification **88 PASS · 0 FAIL · 0 SKIPPED**; emulation-only checks **16 / 16**; browser **3 / 3**; graceful shutdown pass; log scan pass (no secret, key, JWT, password or address) |
| Local — migration tooling | `npm run rehearse:migration` (real CLIs, fictional exports) | **10 / 10** |
| Clean-room check of the delivered ZIP | unzipped into an empty folder → `npm ci` → typecheck → build → `test:db` → web build | pass · pass · pass · **185 / 185** · pass |
| Independent reviews | separate reviewer, read-only | stage review: 15 findings → fixed; staff sign-in review (two rounds): 10 + 3 findings → fixed or documented (below) |

## 1. Automated suite (`npm run test:db`, 185 tests)
| File | Tests | Area |
|---|---:|---|
| unit/domain | 26 | 3.1 grading, questionnaire, pricing, fees, workflow |
| unit/shared | 19 | money, time, text, config, logging, webhooks, uploads |
| unit/staging-readiness | 25 | staging/production config rules, empty-variable handling, target guard (incl. bypass attempts), TLS/CA, Supabase key headers, client-IP forwarding headers, malformed Auth replies, JWT rotation (JWKS + secret), tester mapping (phones and emails) |
| unit/openapi | 3 | spec valid, complete, up to date, no credentials |
| integration/auth-otp | 11 | OTP, hook signatures, limits, wrong-code limit, linking, logout-all |
| integration/authorization | 14 | branch/partner/customer isolation, SUPER_ADMIN protection, finance permissions, tokens |
| integration/http-security | 8 | headers, CORS, request ids, limits, generic errors, X-Forwarded-For spoofing |
| integration/transactions | 14 | idempotency, rollback, concurrency (IMEI, voucher, collection, settlement), transitions |
| integration/vertical-slice | 5 | submission → paid settlement with exact money |
| integration/modules | 15 | catalogue, pricing, staff, customers, partners, notifications, dashboards, reports, search, uploads, reconciliation |
| integration/migration | 6 | dry-run, validate, apply, compare, file migration, migrated sign-in |
| db/rls | 11 | (incl. the new `staff_auth_attempts` table: no client access) |
| integration/staff-password | 21 | staff email + password: first password by e-mailed code, login, same answer for wrong password/unknown address, no SMS for staff numbers (also via Auth directly), only password sessions of the provisioned Auth user with the current address count, reset limits, wrong-code limit, pause after wrong passwords (10 concurrent → exactly 5 reach Auth), sessions ended on password set, admin create/approve/change address, applicant flow, leftover/conflicting Auth users, Auth admin outage, reply independent of Supabase, platform e-mail cap, customers unchanged, config defaults, password and address rules |
| integration/staging-readiness | 7 | **428 for all 18 idempotent actions without a key, nothing written**; registry = 3.1 client's keyed list; migration ledger + edited-file refusal; fail-closed default privileges (tables, functions); hook resilience on DB failure; migrate/seed command guards |

## 2. Cloud emulation (`npm run emulate:staging`)
What was **real**: the shipped Dockerfile image (built here; runtime layers identical to the shipped file — a local-only variant added this workspace's TLS-proxy CA to the *build* stage so `npm ci` could reach the registry); PostgreSQL TLS with certificate verification (`DATABASE_SSL_CA`); migrations and the staging seed run **from the image** as a **non-superuser** `postgres` role; Supabase Auth (GoTrue v2.170.0) with phone OTP and the Send SMS hook calling the API over HTTPS, and email + password with the real "Reset password" e-mail (custom template with `{{ .Token }}`) delivered over SMTP; the Auth **admin** API called by the API with the service key (legacy JWT form — the new `sb_secret_` form was not testable locally); PostgREST v12.2.12 with the project's JWT secret; Chromium against the page served over HTTPS.
What was **emulated**: Supabase's API gateway (routing + `apikey` check), the Storage API (object visibility still decided by the real `storage.objects` RLS), Twilio's Messages API, an SMTP server (sink). Assumed privileges: REFERENCES on `auth.users`, INSERT on `storage.buckets` for `postgres`.

| Check | Result |
|---|---|
| No CA → migration refused ("unable to verify the first certificate") | PASS |
| `npm run migrate` from the image: 8 applied; second run 0 applied | PASS (one expected WARNING: optional catalogue storage policy skipped — `postgres` does not own `storage.objects`) |
| `npm run seed:staging` from the image, `APP_ENV=staging` | PASS |
| API container `APP_ENV=staging`: `/ready` → database true, environment staging, SMS configured, keys required | PASS |
| E-01 real sign-in, 11 profiles: 2 customers by SMS code (API → GoTrue → hook → Twilio emulation → verify); 9 staff by "set or reset password" (API provisions the Auth user with the service key → GoTrue e-mails the code → verify recovery → set password) | PASS |
| E-11 staff sign in again with email + password; token carries `amr: password` and the email | PASS |
| E-02 token alg/issuer/audience/role as configured | PASS |
| E-03 staff linked to Auth users with their address (confirmed); customers linked by phone | PASS |
| E-04 refresh through the Auth server (staff token still a password session) | PASS |
| E-12 Supabase Auth called directly for an SMS code to a staff number: refused by the hook, nothing sent | PASS |
| E-13 a password-recovery session obtained directly from Supabase Auth is refused by the API | PASS |
| E-14 a direct sign-up with a staff address before set-up: cleared, the owner sets up normally, the stray password never works | PASS |
| E-15 administrator changes a staff address: old address refused, old password does not carry over, new address set up | PASS |
| E-16 5 wrong passwords pause the address; the right password is then refused too (real Auth server) | PASS |
| E-05 calling Supabase Auth **directly** for a disabled account: refused by the hook (403 relayed), no SMS | PASS |
| E-06 a Supabase session for a number with no profile: API 401, Data API returns nothing | PASS |
| E-07 wrong-code limit with the real Auth server | PASS |
| E-08 logout-all: old access token refused; refresh token revoked by Auth | PASS |
| E-09 unsigned hook call through the public route → 401 | PASS |
| E-10 cooldown relayed as 429 "Too many code requests" in ~10 ms (hook protocol) | PASS |
| `verify-staging`: platform 7, auth 25, idempotency 12, vertical flow 8, negative 11, concurrency 6, RLS-over-REST 9, Storage 4, read-only DB 6 | **88 / 88 PASS** |
| Browser: customer by SMS code; finance admin sets a first password from the e-mailed code; branch manager by email + password; portals render | **3 / 3** |
| `docker stop` → "shutdown complete", exit 0 | PASS |
| API container log contains no password, secret, key, hook secret or JWT; no staff password or address | PASS |
| Image contents: only `dist`, prod `node_modules` (23 MB), `package.json`, `supabase/{migrations,seed}`; runs as `node`; no `.env`/key/cert files | PASS |

Findings the emulation produced (all fixed): hook refusals were sent as non-2xx (became a generic 500 in Supabase Auth); network failures reaching Auth produced 500s; the migration's storage policy needs ownership a non-superuser lacks. See `STAGING_CHANGELOG.md`.

## 2a. Staff email + password — what is and is not proven
| Claim | Evidence |
|---|---|
| Staff can set a first password and sign in; customers unchanged | integration (21), browser 5/5 (stub) + 2/3 (real GoTrue), E-01, E-11 |
| Only password sessions of the API-provisioned Auth user with the current address are staff | integration; E-13 (recovery session), E-12 (no SMS), E-15 (address change) |
| Limits hold under concurrency | integration: 10 concurrent wrong passwords → exactly 5 reach Auth |
| Real Supabase Cloud: tokens carry `amr`/`email`; admin API accepts the `sb_secret_` key; `postgres` may read `auth.users`; e-mail delivery via your SMTP; IP forwarding | **NOT EXECUTED** — verify:staging A-14, first staff set-up, checklist rows 25, 26, 29 |

## 3. Brief §16 negative tests / §17 concurrency → evidence (local + emulation)
| Required | Check ids |
|---|---|
| branch → another branch denied | N-01, N-02, F-01, F-05, R-05 |
| partner → another partner denied | N-03, R-06 |
| lower role modifies SUPER_ADMIN denied | N-04 |
| invalid / expired JWT denied | A-02…A-06, A-07 (expired, minted with the test secret in the emulation) |
| missing idempotency key denied | I-01…I-10 (428) |
| same key → original result | F-01, F-03, C-05, C-06 |
| duplicate IMEI rejected | N-05, C-01 |
| duplicate voucher prevented | F-05, C-02 |
| duplicate collection prevented | N-07, C-03 |
| duplicate settlement prevented | N-08, C-04 |
| invalid state transition rejected | N-09 |
| same idempotency key simultaneously | C-05 (5 parallel → 1 effect, 1 audit row) |

## 4. Migration tooling rehearsal (`npm run rehearse:migration`)
M-01 dry-run reports duplicates/invalid phones, failed-row CSV without personal data · M-02 validate rolls back · M-03 broken reference → PARTIAL, dependents rejected, comparison and reconciliation flag the gap · M-04 corrected export re-applied → complete · **M-05 a 20,000-row import killed with SIGKILL after 1,000 rows, resumed from checkpoints → exactly 20,000, no duplicates; resuming a finished run refused** · M-06 legacy ids kept, counters continued · M-07a idempotent re-run · M-07b unknown run id refused · M-07 exact financial totals equal · M-08 refused rows flagged. **10 / 10.**

## 5. Secret scan
`grep` over the repository (excluding `node_modules`, `dist`, reports) for JWTs, `whsec_`, `sb_secret_`, Stripe/Twilio-style keys and private keys: two hits, both deliberately fake JWTs in unit tests (`tests/unit/shared.test.ts` log scrubbing, `tests/unit/staging-readiness.test.ts` key detection). Test passwords are fictional and random per run in the emulation. `.env.example` and `staging-testers.example.json` hold placeholders only. Re-scan before production.

## 6. Independent review
**Staff sign-in review (two rounds, read-only).** Round 1 (10 findings): Supabase per-IP limits shared through the API's single IP (customers could lose code attempts on Supabase 429s); reset timing/429 differences revealing staff addresses and allowing e-mail-quota exhaustion; refresh tokens of the old Auth user surviving an administrator's address change; address re-use blocked by leftover Auth users; recovery not revoking when token verification failed; non-ASCII case-folding mismatch; malformed 200s counted as wrong passwords; attempt table retention; duplicate-email race message. Round 2 (3 new, from the fixes): cooldown rows given back on Supabase failures; clean-up could delete confirmed Auth users the API did not create; non-ASCII addresses now refused (importer reports them). All fixed and re-tested (185 tests, emulation 88 + 16 + 3, browser 8/8) except, by design: forwarding is opt-in until verified on staging, and someone who knows staff addresses can use the hourly reset-email budget (audited).

**Stage review.** A separate reviewer (read-only) reported 15 items; fixed: URL query parameters / `PG*` variables / host-less URLs that could redirect an operator command past the target guard; file migration not bound to the database's project; `.dockerignore` matching only at the root (now `**/` and only `supabase/{migrations,seed}` copied); verification accepting `--expect-environment production` and not checking the API/Supabase hosts against `QM_PROTECTED_TARGETS`; read-only DB connection relying on a startup option (now every query runs in an explicit `READ ONLY` transaction); PUBLIC's default EXECUTE on new functions; hook paths that could still answer 5xx (DB failure, post-send bookkeeping, per-IP 429); main-module detection on Windows/paths with spaces; operator TLS defaulting to off; IaC guard and undeclared optional variables; doc contradictions; invalid CA silently ignored; trailing slash in `SUPABASE_URL` for Storage. All re-tested.

## 7. NOT EXECUTED — must run on the real staging (commands in `STAGING_DEPLOYMENT.md`)
| Cloud test (brief §14) | Command / evidence |
|---|---|
| Staff email + password on Supabase Cloud (amr/email claims, admin API with `sb_secret_`, SMTP delivery, template) | `verify:staging --login` A-10…A-14; first "Set or reset password" on the staging page |
| Supabase per-IP limits not shared by everyone | `SUPABASE_AUTH_FORWARD_CLIENT_IP` + IP forwarding, or raised limits (checklist 29) |
| Railway deploy succeeds | Railway deployment log `qm-api listening` |
| `/health` success · `/ready` confirms DB | `verify:staging` P-01, P-02 |
| Supabase Auth login works (real SMS) | `verify:staging --login` (A-ME-*) |
| JWT accepted · invalid JWT rejected | A-ME-*, A-02…A-06; expired: A-07 with `QM_EXPIRED_TOKEN` |
| RLS blocks unauthorized access (real Data API) | R-01…R-09 |
| Storage permissions (real Supabase Storage) | S-01…S-04 |
| API creates staging records · transactions on Supabase PostgreSQL | F-01…F-08, D-01, D-02 |
| Idempotency with the real DB | I-*, F-01, F-03, C-05 |
| Concurrent duplicate IMEI → one record | C-01 |
| Full vertical flow §15 with audit/scope/money after each step | F-01…F-08 (needs `STAGING_DATABASE_URL` for audit rows) |
| Real SMS delivery to Qatar numbers | testers' handsets + Twilio logs |
| Hook protocol on Supabase Cloud | second code within 60 s must show "Too many code requests" |
| `TRUST_PROXY_HOPS` on Railway | forged `X-Forwarded-For` must not reset the auth rate limit |
| Supabase privilege assumptions | `npm run migrate` on staging (REFERENCES on `auth.users`, `storage.buckets` insert); SELECT on `auth.users` for the API (stray clean-up) |
| `.railway/railway.ts` | `railway config plan` (CLI ≥ 5.42.1) |
| Load / performance, penetration test | not in scope |

These results do not mean the system is secure; they mean the listed controls behaved as described in these runs.
