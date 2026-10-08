# Blockers before production

Staging is live and verified (see `REAL_STAGING_RESULTS.md`). **Production must not go live until every item marked BLOCKER is closed.** Owner = who has to act.

| # | Item | Why it blocks | Owner | Severity |
|---|---|---|---|---|
| 1 | **Separate production Supabase project** | The only project (`QM Trade-in Project`) is labelled "Production" in the dashboard but now holds staging/fictional data and test accounts. Production needs its own project, credentials and keys; or relabel this one as staging and create a new one for production. Decide which. | Owner | BLOCKER |
| 2 | **Customer SMS provider** (Twilio or custom) + Supabase **phone provider ON** + **Send SMS hook** → `https://<api>/v1/hooks/send-sms` with `SEND_SMS_HOOK_SECRET`; `SMS_PROVIDER` ≠ `none` (the API refuses `none` in production) | customers cannot sign in without it; not tested on the cloud | Owner (provider account) + Claude (wiring/test) | BLOCKER |
| 3 | **Staff email sender** for `info@qatarmobile.qa` (Microsoft Graph, see `SMTP_CONFIGURATION.md`) + Supabase **Reset Password** template containing `{{ .Token }}` | staff cannot set or reset passwords; not tested on the cloud | Owner (M365 admin) | BLOCKER |
| 4 | **SUPER_ADMIN MFA** | platform owner account protected by a password only | Build in a later phase (not rushed) | BLOCKER for production (not for staging) |
| 5 | Supabase Auth: **refresh-token reuse detection ON**, reuse interval ≈10 s | X-05 FAIL: a spent refresh token still worked after 20 s | Owner (Auth → Sessions / Refresh tokens) | BLOCKER |
| 6 | Supabase Auth: **leaked-password protection ON**; minimum password length **12** (matches `STAFF_PASSWORD_MIN_LENGTH`) | advisor WARN | Owner (Auth → Providers → Email / Password security) — *availability depends on plan; verify* | High |
| 7 | Supabase Auth: **IP address forwarding ON** + `SUPABASE_AUTH_FORWARD_CLIENT_IP=true` (requires the `sb_secret_` key — in place), **or** raise per-IP Auth limits | otherwise Supabase's per-IP limits (e.g. 30 verifications / 5 min) are shared by all users behind Railway; not tested on the cloud | Owner (Auth → Rate Limits) + Claude (test) | High |
| 8 | Supabase Auth: anonymous sign-ins OFF; "Confirm email" ON; self sign-up for staff domains not possible | defence in depth | Owner | High |
| 9 | **Worker**: Railway cron service `qm-reconcile` (hourly) + alerting on its issues | reconciliation ran only read-only by hand | Claude + Owner | High |
| 10 | **Rotate credentials that passed through tool calls**: `qm_api` password (and the Supabase secret key if desired) | values were handled by the deployment assistant | Owner | High (production uses new credentials anyway) |
| 11 | **Backups**: confirm retention/PITR on the production plan + one restore drill | not executed | Owner | High |
| 12 | **Data residency decision** (Qatar personal-data law) for customer data in Singapore | legal decision, not technical | Owner / legal | BLOCKER for real customer data |
| 13 | Custom domains `api.qatarmobile.qa`, `tradein.qatarmobile.qa` + TLS + `CORS_ALLOWED_ORIGINS` = real frontend origin | deliberately not done yet | Owner (DNS) + Claude | BLOCKER at cutover |
| 14 | Frontend deployed against the API and smoke-tested (staff + customer journeys) | no staging frontend yet | Claude | High |
| 15 | Load / performance test at expected peak | not executed | Claude | Medium |
| 16 | Production data migration rehearsal on a copy, then cutover per `docs/CUTOVER_PLAN.md` (Apps Script stays as is until then) | deliberately not done | Owner + Claude | BLOCKER at cutover |
| 17 | Remove staging fixtures from any project that becomes production (test Auth users `*.example.test`, fictional seed) | fixtures exist in this project | Claude | BLOCKER if this project is reused |
| 18 | Rename audit action `STAFF_PASSWORD_RESET_SENT` → `…_REQUESTED` (details already say `delivered:false`) | clarity of audit trail | Claude | Low |
| 19 | Railway: keep `DATABASE_URL`, `SUPABASE_SECRET_KEY` (and future SMS/Graph secrets) **sealed**; production in its own Railway environment/project | hygiene | Owner | Medium |

Already closed during this phase: sequence grants (0900), function `search_path` (1000), least-privilege API role (1100), TLS verification of the database connection, client-IP spoofing of rate limits (X-07 PASS), admin API with `sb_secret_` key (verified).
