# Test results (Phase 2)

> **Superseded by `STAGING_TEST_RESULTS.md`** (staging-readiness stage: 161 automated tests, verification rehearsal, local cloud emulation, migration rehearsal). This page is kept as the Phase 2 record.

Executed on 2026-10-08 in an isolated cloud workspace. Node v22.22.0 (project targets ≥ 20.11), PostgreSQL 16.15 (throwaway cluster on 127.0.0.1, created and deleted per run by `tests/scripts/with-local-postgres.sh`), headless Chromium from Playwright. **Only fictional data. No production system, database, deployment or secret was used.**

## Summary

| Command | Result |
|---|---|
| `npm run typecheck` | **PASS** (0 errors) |
| `npm run build` | **PASS** |
| `npm run test:db` (all suites, real PostgreSQL) | **129 passed / 0 failed** — 10 files, ~15 s |
| `npm test` without a database | 45 passed, 84 skipped (DB suites skip themselves) |
| `npm run test:ui` (browser, unchanged 3.1 HTML → Railway API) | **3/3 PASS** |
| Compiled-server smoke (below) | **PASS** |
| Clean-room check: the packaged ZIP unpacked into an empty folder → `npm ci`, `typecheck`, `build`, `test:db` | **PASS** (129/129) — run before this line was added to the docs |

## By suite (`npm run test:db`)

| File | Tests | Covers |
|---|---:|---|
| `tests/unit/domain.test.ts` | 26 | grading (3.1 internal tests), questionnaire, pricing windows, partner fees, rounding, workflow graph |
| `tests/unit/shared.test.ts` | 19 | money, Qatar days, phones, IMEI, CSV formula neutralising, config refusals, log/audit scrubbing, webhook signatures, image sniffing |
| `tests/integration/vertical-slice.test.ts` | 5 | submission → inspection → offer → accept → received → voucher → collection → settlement paid/closed with exact money |
| `tests/integration/authorization.test.ts` | 14 | see brief checklist below; PENDING is not a collection outcome |
| `tests/integration/transactions.test.ts` | 14 | see brief checklist below |
| `tests/integration/auth-otp.test.ts` | 11 | OTP flow, hook signatures, send limits, **wrong-code limit (concurrent)**, registration, linking, logout-all, fail-closed SMS |
| `tests/integration/http-security.test.ts` | 8 | headers, CORS, request ids, body limits, generic errors, health/ready, **spoofed X-Forwarded-For vs rate limit**, sign-in not reachable via the compatibility endpoint |
| `tests/integration/modules.test.ts` | 15 | catalogue, pricing, fees, grade ladder, import, staff, customers, partners/branches, notifications, dashboards, reports/CSV, search, uploads, audit/settings, reconciliation |
| `tests/integration/migration.test.ts` | 6 | dry-run, validate, apply (idempotent, ids preserved, counters), compare, file migration, migrated user signs in |
| `tests/db/rls.test.ts` | 11 | RLS as `anon`/`authenticated` with simulated JWT claims, incl. finance tables mirroring the API |

## Brief checklist → test (all executed, all passed)

| Required test | Test name (file) |
|---|---|
| Own branch allowed | "branch user: own branch allowed" (authorization) |
| Other branch denied | "branch user: another branch of the same partner is denied"; "cannot reach another branch by SUBMITTING a different branch id"; "cannot issue a voucher for another branch's device" |
| Other partner denied | "partner user: another partner's trade-in is denied" |
| Lower role cannot modify SUPER_ADMIN | "lower roles cannot modify a SUPER_ADMIN; nobody changes their own role; the last SUPER_ADMIN is protected" (partner staff get the same 404 as for a non-existent id) |
| Duplicate IMEI | "duplicate IMEI: a second open trade-in for the same device is refused" |
| Concurrent IMEI | "duplicate IMEI under CONCURRENT creation: exactly one succeeds" |
| Duplicate voucher | "duplicate voucher: concurrent issue requests produce exactly one live voucher" |
| Duplicate collection | "duplicate collection: concurrent note creation claims each device once" |
| Duplicate settlement | "duplicate settlement: concurrent creation for the same period claims each device once" |
| Idempotent retry | "idempotent retry returns the ORIGINAL result and creates nothing new"; "same key with a DIFFERENT payload is refused (409)" |
| Rollback on failure | "rollback on failure: nothing from a failed request survives"; "a failed attempt stores nothing, so a retry with the same key can succeed" |
| Invalid transitions | "invalid transitions are refused by the API and, independently, by the database" |
| Unauthorised finance actions | "QM_ADMIN cannot approve; partner and technician cannot settle" |
| Tokens | "bad signature, wrong audience, service role, expired, unknown user → 401"; "role/status changes revoke existing sessions immediately" |

## Browser smoke (`npm run test:ui`)
```
PASS customer: signed in with OTP and the portal rendered (.cx)
PASS finance-admin: signed in with OTP and the portal rendered (#root *)
PASS branch-manager: signed in with OTP and the portal rendered (#root *)
```
Real OTP sign-in through the 3.1 login screen (code captured by the test SMS provider), no browser console errors. Screenshots were inspected (customer home with an active trade-in; admin dashboard figures). **Not covered:** clicking through every screen of every portal.

## Compiled server smoke (dist/, throwaway DB)
- `npm run migrate` applied 6; second run `applied 0, alreadyApplied 6`.
- `npm run seed:dev` loaded fictional data; `npm run job:reconcile` → 0 issues.
- `/health` 200 with CSP and `X-Request-Id`; `/ready` → `{database:true, sms:"not configured"}`.
- Unauthenticated action → 401 generic message.
- SIGTERM → "shutting down" … "shutdown complete", exit 0.
- `APP_ENV=production SMS_PROVIDER=test` → refused to start, exit 2, listing variable names only.

## NOT EXECUTED (needs the real platform or credentials)
| Item | Why not | Where to run |
|---|---|---|
| Supabase GoTrue `/otp`, `/verify`, `/token`, `/logout` against a real project | no project/credentials (by design) | staging (cutover step 3) |
| Real Send SMS hook payload/response format from Supabase | same; tested with our own signed payloads | staging |
| JWKS (asymmetric) verification against a real project | HS256 path tested; JWKS code path not executed | staging |
| Supabase Storage REST upload / signed URL | `MemoryStorage` used in tests | staging |
| RLS through real PostgREST with real anon/user keys | simulated with `set role` + JWT claims in SQL | staging |
| Twilio / custom SMS delivery | no credentials; the test provider was used | staging with a team phone |
| Railway build/deploy, health check, SIGTERM from the platform | not deployed (by instruction) | staging |
| Data migration on a real export | not performed (by instruction) | staging rehearsal (cutover steps 4–6) |
| Load/performance testing | not in scope | staging |
| Full manual pass over every 3.1 screen | only sign-in + portal render automated | staging UAT |

## Independent review
A separate reviewer agent (no part in writing the code) audited authorisation, money/transactions, SQL, secrets, RLS, JWT and the SMS hook. It found **no authorisation bypass through the API**. Fixed and re-tested (tests above): spoofable `X-Forwarded-For` (trust all proxies → hop count), sign-in reachable via the compatibility endpoint without the auth limit, no wrong-code limit (3.1 `MAX_ATTEMPTS` restored), RLS wider than the API for partner staff on settlements/collections/partner terms, `PENDING` accepted as a collection outcome, SUPER_ADMIN ids discoverable by partner staff. Documented, not changed (3.1 behaviour or platform-dependent): see `ARCHITECTURE.md` → known limits.

No penetration test was performed. These results do not mean the system is secure — they mean the listed controls behaved as described in these tests.
