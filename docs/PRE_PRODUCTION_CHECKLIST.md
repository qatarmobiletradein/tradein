# Pre-production gate

Production work (data migration, cutover, DNS, production SMS, disabling Apps Script) may start only when **every** row below is ✅ with evidence. A ⚠️ or ❌ blocks. "Local" evidence never substitutes for a cloud row.

Legend: ✅ done with evidence · 🟡 done locally only (cloud still required) · ❌ not done · ⚠️ decision needed

Status as of 2026-10-08 (this package):

| # | Gate | Status | Evidence / how to close |
|---|---|---|---|
| 1 | Supabase **staging** project created (separate from production) | ❌ | `STAGING_DEPLOYMENT.md` §1. Record project ref (not secret) and region. |
| 2 | Migrations applied to staging; second run applies nothing | ❌ 🟡 | Local: 8/8 as a non-superuser in the emulation. Cloud: paste `npm run migrate` output ×2. |
| 3 | Staging seed applied (fictional only) | ❌ 🟡 | Local: from the Docker image. Cloud: `seed:staging` output (numbers masked). |
| 4 | Auth verified (customers: real SMS OTP; staff: email + password; JWT accepted, invalid/expired refused, issuer/audience match) | ❌ 🟡 | Report groups `auth` (A-*) with `--login`; A-07 needs `QM_EXPIRED_TOKEN`; **A-14 must PASS** (Supabase Cloud tokens carry `amr: password` + `email`). Local emulation used open-source GoTrue v2.170.0. |
| 5 | RLS verified through the real Data API (customer, branch staff, partner admin, QM admin, SUPER_ADMIN; anon) | ❌ 🟡 | Report group `rls` (R-01…R-09) — requires `SUPABASE_URL` + publishable key. |
| 6 | Storage verified (private evidence via signed URL only; public catalogue; uploads only via API) | ❌ 🟡 | Report group `storage` (S-01…S-04) on real Supabase Storage. |
| 7 | Railway staging deployed from the Dockerfile | ❌ 🟡 | Local: image built and run from the shipped Dockerfile. Cloud: deployment id + log line `qm-api listening`. |
| 8 | `/health` passed | ❌ 🟡 | P-01 against the Railway domain. |
| 9 | `/ready` passed (database true, environment staging, SMS configured, keys required) | ❌ 🟡 | P-02, P-03. |
| 10 | Full vertical flow passed (login → trade-in → inspection → offer → acceptance → received → voucher → collection → settlement → approval) | ❌ 🟡 | F-01…F-08 with `STAGING_DATABASE_URL` set (audit + money checks). |
| 11 | Negative tests passed | ❌ 🟡 | N-01…N-11, A-02…A-08, I-01…I-12. |
| 12 | Concurrency passed on Supabase PostgreSQL | ❌ 🟡 | C-01…C-06. |
| 13 | Idempotency passed (428 without key; replay returns the original; key reuse 409) | ❌ 🟡 | I-*, F-01, F-03, C-05, N-06. |
| 14 | Financial totals verified (offer = base × grade; fee; settlement = value + fee; headers = lines) | ❌ 🟡 | F-02, F-05, F-07, D-01, D-02. |
| 15 | No hardcoded secrets | ✅ | Repository scan in `STAGING_TEST_RESULTS.md`; `.env.example` placeholders only; container log scan in the emulation. Re-scan the final repository before production. |
| 16 | Backup / cutover plan reviewed and signed | ❌ | `CUTOVER_PLAN.md` (13 steps) + Supabase backup/PITR choice for production *(verify plan)*. |
| 17 | Browser check on staging (customer by SMS; finance and branch manager by email + password, one via "Set or reset password") | ❌ 🟡 | Local emulation: 3/3 with real Supabase Auth (GoTrue) and a real reset e-mail. Repeat on the staging page with real phones and mailboxes. |
| 18 | SMS provider: real delivery to Qatar numbers from staging; sender id approved | ❌ | Twilio console logs; not emulated. |
| 19 | Migration tooling rehearsed on a **sanitised copy** of real data (not production) | ❌ 🟡 | Local: fictional exports (10/10). Needs a sanitised export and its compare report. |
| 20 | Staff sign-in method decided | ✅ 🟡 | Decided 2026-10-08: staff email + password, customers SMS code. Implemented and tested locally (185 tests, emulation E-11…E-16, browser). Cloud: rows 4, 17, 25, 26, 29. |
| 21 | Data-residency / region decision for customer data | ⚠️ | Legal/business decision (Qatar personal-data law). |
| 22 | Hook protocol confirmed on Supabase Cloud (refusal relayed as 429, not 500) | ❌ 🟡 | E-10 equivalent on staging: second code within 60 s must show "Too many code requests". |
| 23 | `TRUST_PROXY_HOPS` confirmed on Railway | ❌ | Two requests with a forged `X-Forwarded-For` must still share one rate-limit bucket. |
| 24 | Independent review findings resolved | ✅ | `STAGING_TEST_RESULTS.md` → review section. |
| 25 | Custom SMTP configured; staff reset e-mails arrive (inbox, not spam) at your company domain; Reset-password template contains `{{ .Token }}` | ❌ | `CLOUD_CONFIGURATION.md` §2. SPF/DKIM for the sender domain. E-mail rate limit raised above 30/hour if many staff reset at once. |
| 26 | Supabase Auth admin calls work with the new `sb_secret_` key; `postgres` can read `auth.users` | ❌ 🟡 | First staff "Set or reset password" on staging succeeds (and E-14-style stray clean-up if you test it). Emulation used a legacy service-role JWT. |
| 27 | Staff e-mail addresses in the Sheets export are valid and unique | ❌ | `import:sheets --mode dry-run` lists bad ones per row; fix in the sheet before the real import. |
| 28 | MFA for SUPER_ADMIN | ⚠️ | Not built. Recommended before production (Supabase TOTP MFA). Business decision. |
| 29 | Supabase per-IP Auth limits will not throttle everyone (all calls come from Railway's IP) | ❌ | Switch on IP forwarding + `SUPABASE_AUTH_FORWARD_CLIENT_IP=true` and confirm sign-in still works and Supabase Auth logs show client IPs — or raise the per-IP limits. `CLOUD_CONFIGURATION.md` §2. |

Sign-off: business owner `<name/date>` · technical owner `<name/date>`.

Reminder: even when every row is ✅, the next phase still must not run until the cutover plan's own approvals are given. This phase does not cut over.
