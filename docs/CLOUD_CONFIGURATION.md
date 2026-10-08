# Cloud configuration — staging

Every setting the staging environment needs: what it is, where it is set, and who may see it. **No real values are in this repository.** Placeholders are written `<like-this>`.

Platform facts below were checked against the vendors' public documentation on 2026-10-08 (sources at the end). Dashboard menu names change; where I describe a screen I'm not certain of, it is marked *(verify)*.

## 1. Classification

| Class | Rule |
|---|---|
| **SAFE FOR FRONTEND** | May be embedded in the built page (`dist/web/index.html`). |
| **SERVER ONLY** | Railway service variables (sealed when SECRET) or the operator's terminal. Never in the frontend build, the repository, a ticket, a chat or a document. |

The following must never reach a browser: the service-role / secret key, the database password, `DATABASE_URL`, SMS credentials, the hook secret, the JWT secret, any private signing key. The frontend build embeds only the four `QM_*` values below — `apps/web/build.mjs` has no code path that reads any other variable.

### SAFE FOR FRONTEND (web build only)
| Variable | Staging value |
|---|---|
| `QM_API_BASE` | `https://<railway-staging-domain>` |
| `QM_TRANSPORT` | `railway` |
| `QM_ENVIRONMENT_LABEL` | `STAGING` |
| `QM_STAFF_SIGN_IN` | `password` (default) — must match the API's `STAFF_SIGN_IN` |

`SUPABASE_PUBLISHABLE_KEY` is browser-safe *by Supabase's design*, but this frontend does not need it (sign-in goes through the API), so it is not embedded.

### SERVER ONLY — Railway service `qm-api`
| Variable | Staging value | Secret? | Notes |
|---|---|---|---|
| `APP_ENV` | `staging` | no | Turns on the strict rules (below). Unset = `production`. |
| `NODE_ENV` | `production` | no | Set by the Dockerfile too. |
| `LOG_LEVEL` | `info` | no | |
| `TRUST_PROXY_HOPS` | `1` | no | Railway's edge proxy. *Verify*: if `/ready` logs show every request from one IP, the hop count is wrong. |
| `PORT` | *(Railway sets it)* | no | Do not set. |
| `DATABASE_URL` | session pooler or direct URL (§3) | **SECRET** | Contains the database password. |
| `DATABASE_SSL` | `require` | no | Certificate verified. `no-verify` is allowed in staging only as a temporary fallback; refused in production. |
| `DATABASE_SSL_CA` | PEM of the Supabase database CA | no (server-only) | Download from the Supabase dashboard (§2). One line with literal `\n`, or base64. |
| `DATABASE_POOL_MAX` | `10` | no | Must stay below the pooler's pool size *(verify in Database settings)*. |
| `SUPABASE_URL` | `https://<staging-ref>.supabase.co` | no | Must be https. |
| `SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_…` (or legacy anon key in `SUPABASE_ANON_KEY`) | no (server-only here) | Sent only in the `apikey` header. |
| `SUPABASE_SECRET_KEY` | `sb_secret_…` (or legacy key in `SUPABASE_SERVICE_ROLE_KEY`) | **SECRET** | Storage writes and signed URLs, and the Supabase Auth **admin** calls that set up staff sign-in (create the Auth user for a staff address). New-style keys are sent only in `apikey` (Supabase: they are not JWTs). *Not verified on Supabase Cloud: that the gateway accepts an `sb_secret_` key in `apikey` alone for `/auth/v1/admin/*` — the emulation used a legacy service-role JWT.* |
| `SUPABASE_JWKS_URL` | `https://<staging-ref>.supabase.co/auth/v1/.well-known/jwks.json` | no | Recommended (ES256/RS256 signing keys). |
| `SUPABASE_JWT_SECRET` | legacy JWT secret | **SECRET** | Only if the project still signs with the legacy HS256 secret, or during a rotation (both may be set). |
| `SUPABASE_JWT_ISSUER` | `https://<staging-ref>.supabase.co/auth/v1` | no | *Verify*: check A-01 in the verification report — it prints the real `iss` of a token. |
| `SUPABASE_JWT_AUDIENCE` | `authenticated` | no | |
| `SEND_SMS_HOOK_SECRET` | `v1,whsec_…` from the Send SMS hook | **SECRET** | |
| `CORS_ALLOWED_ORIGINS` | `https://<staging-frontend-origin>` | no | https only; no `*`. |
| `SMS_PROVIDER` | `twilio` (or `custom`) | no | `none` and `test` are refused in staging/production. |
| `TWILIO_ACCOUNT_SID` / `TWILIO_FROM` | from Twilio | identifier | |
| `TWILIO_AUTH_TOKEN` | from Twilio | **SECRET** | |
| `CUSTOM_SMS_URL` / `CUSTOM_SMS_KEY` | if `custom` | key **SECRET** | URL must be https. |
| `IDEMPOTENCY_KEY_REQUIRED` | leave unset (= `true`) | no | `false` is refused in staging/production. |
| `STAFF_SIGN_IN` | leave unset (= `password` in staging/production) | no | Owner decision: staff sign in with work email + password; customers keep SMS codes. `phone` is refused in production. |
| `STAFF_PASSWORD_MIN_LENGTH` | `12` (default) | no | API rule; set Supabase's minimum at least as high (§2). |
| `STAFF_LOGIN_MAX_FAILURES` | `5` (default) | no | Wrong passwords per address per 15 minutes before sign-in for that address pauses. |
| `STAFF_RESET_EMAILS_PER_HOUR` | `25` (default) | no | Reset e-mails per hour for **all** staff together; keep it below the project's Supabase e-mail limit (§2). Raise both together if you have many staff. |
| `SUPABASE_AUTH_FORWARD_CLIENT_IP` | `true` **after** switching on Supabase's IP forwarding (§2); otherwise unset | no | Sends the person's IP to Supabase Auth (`Sb-Forwarded-For`) with the new secret key, so Supabase's per-IP limits apply per person instead of to the API's single IP. Refused with a legacy key. *Not verified on Supabase Cloud — test on staging (sign-in still works; Supabase Auth logs show client IPs).* |
| `AUTH_RATE_LIMIT_MAX`, `RATE_LIMIT_MAX`, `OTP_*` | defaults | no | 3.1 values; clamped, cannot be disabled. |

### SERVER ONLY — Railway cron service `qm-reconcile` (optional)
`APP_ENV=staging`, `NODE_ENV=production`, `DATABASE_URL` (**SECRET**), `DATABASE_SSL=require`, `DATABASE_SSL_CA`. Start command `node dist/apps/api/src/jobs/run-job.js reconcile`, hourly.

### SERVER ONLY — operator terminal (never stored)
| Variable | Purpose |
|---|---|
| `DATABASE_URL` | for `npm run migrate` / `seed:staging` (direct or **session** pooler; not 6543) |
| `MIGRATION_TARGET_CONFIRM` | must equal the staging **project ref** (the command prints it) |
| `QM_PROTECTED_TARGETS` | the **production** project ref, if one exists — those commands then refuse it |
| `STAGING_DATABASE_URL` | read-only checks of `npm run verify:staging` |

Type secrets into the terminal (`read -rs VAR`) rather than pasting them into a command line, so they do not land in shell history.

## 2. Supabase staging project

| Setting | Value | Why |
|---|---|---|
| Project | NEW project, name `qatar-mobile-tradein-staging` | Never reuse production. |
| Region | the region closest to Qatar that your plan offers, and the same region as Railway (§4) | Latency; every API request makes database round-trips. *Data residency for customer data is a legal decision (Qatar's personal-data law) — confirm before production; staging holds fictional data only.* |
| Database password | generated (long, random), stored in your password manager | It goes into `DATABASE_URL` only. |
| SSL enforcement | ON (Database settings → SSL configuration) | Then download the CA certificate there → `DATABASE_SSL_CA`. |
| Network restrictions *(verify availability on your plan)* | optional: allow only Railway's egress + operator IPs | Defence in depth. |
| Auth → Phone provider | enabled | Phone OTP sign-in. |
| Auth → OTP | length 6, expiry **300 s** | Must equal `OTP_TTL_MINUTES=5`. |
| Auth → Send SMS hook | HTTPS, `https://<railway-staging-domain>/v1/hooks/send-sms`, generate secret → `SEND_SMS_HOOK_SECRET` | The API applies 3.1's limits and sends via Twilio. Hooks must answer within 5 s (the SMS call has a 4 s budget). |
| Auth → Rate Limits | **Either** switch on *IP address forwarding* and set `SUPABASE_AUTH_FORWARD_CLIENT_IP=true` on the API, **or** raise the per-IP limits | Every Auth call comes from Railway's IP. Supabase's documented defaults are per IP: **30 code verifications / 5 min**, **30 sign-in-type requests (`/otp`, `/recover`, …) / 5 min**, 150 token requests / 5 min — without forwarding these would be shared by ALL users at once. The API's own per-person limits stay in force either way. |
| Auth → anonymous sign-ins | OFF | Anonymous tokens are refused by the API anyway. |
| Auth → Email provider | **ON**; "Confirm email" ON; "Secure email change" ON *(verify names)* | Staff sign in with email + password. Staff Auth users are created by the API (confirmed); "Confirm email" stops anyone who signs up directly with somebody else's address from signing in. |
| Auth → Password | minimum length **12**; required characters: at least letters and digits; **leaked password protection ON** (Supabase: Pro plan and above); **"Require current password when changing password" OFF** *(verify name)* | The API enforces 12 + letters + digit itself. The e-mailed-code reset cannot supply the old password, so that option would break "Set or reset password". "Require reauthentication" can stay as it is: the reset session is new (Supabase counts sessions under 24 h as recent). |
| Auth → Email OTP | expiry **900 s**, length 6 *(verify names)* | The reset code e-mailed to staff. |
| Auth → SMTP | **custom SMTP: required** (your mail provider, sender e.g. `no-reply@<your-domain>`, with SPF/DKIM for that domain) | Supabase's built-in service delivers **only to the project's team members** and **2 e-mails per hour** — not usable for staff. After custom SMTP is set Supabase starts at **30 e-mails per hour**; raise it in Auth → Rate Limits to cover your staff's resets. |
| Auth → Email templates → **Reset password** | subject `Your Qatar Mobile staff code`; body below (must contain `{{ .Token }}`) | The staff screen asks for a 6-digit code, not a link. |
| Auth → "Allow new users to sign up" | **ON** (customers register by phone) | Side effect: anyone can create an Auth user with an email directly. Such a user is never a staff session (staff are linked only to the Auth user the API created). If it holds a staff address and no profile uses it, the API removes it during set-up when it never confirmed the address or is one the API itself manages (`app_metadata.qm_staff`); anything else is refused and audited as `STAFF_SIGNIN_CONFLICT` for an administrator. Optional extra (not built): Supabase's *Before User Created* hook could refuse e-mail sign-ups — *verify first whether it also runs for admin-created users, or it would block staff set-up.* |
| Auth → Database read of `auth.users` | (nothing to set) | The API reads `auth.users` (as `postgres`) only to clear such a stray, unconfirmed user. Worked in the emulation; *verify on Supabase Cloud*. |
| Auth → signing keys | asymmetric key (ES256 recommended) | → `SUPABASE_JWKS_URL`. |
| Auth → refresh tokens | rotation + reuse detection ON *(verify names)* | |
| API keys | create publishable + secret keys | Legacy anon/service_role keys are being deprecated by Supabase by end of 2026. |
| Data API | keep enabled for staging verification | The RLS checks (R-01…R-09) go through it. The app itself does not use it. |
| Storage | nothing by hand | Buckets come from migration `…0400`. If it printed a WARNING about `qm_catalog_media_read`, optionally add that SELECT policy in the dashboard. |

### Reset password e-mail template
Subject: `Your Qatar Mobile staff code`
```html
<h2>Qatar Mobile staff password</h2>
<p>Your code is <strong>{{ .Token }}</strong>. It expires in 15 minutes.</p>
<p>If you did not ask for this, ignore this email.</p>
```
(The local emulation uses exactly this template.) Leave out `{{ .ConfirmationURL }}`: staff type the code into the staff screen.

## 3. Which database connection

| Use | Connection | Port | Notes |
|---|---|---|---|
| Railway API (default) | **Session pooler** `postgres.<ref>@<pooler-host>` | 5432 | IPv4. Supports everything the API uses. |
| Railway API (alternative) | Direct `postgres@db.<ref>.supabase.co` | 5432 | IPv6 only (unless the IPv4 add-on): enable **outbound IPv6** on the Railway service. |
| Migrations, seed | Direct (if your network has IPv6) or session pooler | 5432 | The runner holds a *session* advisory lock: the transaction pooler (6543) is refused. |
| Never | Transaction pooler | 6543 | Not needed by a long-running server. |

Copy hosts from the dashboard's **Connect** dialog — the pooler host contains an index that cannot be derived from the region.

## 4. Railway staging

| Setting | Value |
|---|---|
| Project | dedicated `qatar-mobile-tradein-staging` (the IaC file describes the whole project; resources not in it are deleted on apply) |
| Service | `qm-api`, source = this repository (root directory `/`) or `railway up` |
| Build | the repository's `Dockerfile` (Railway always uses a Dockerfile it finds) |
| Start | Dockerfile `CMD` = `node dist/apps/api/src/server.js` |
| Health check | `/ready`, timeout 60 s |
| Restart | on failure, 5 retries; draining 30 s (SIGTERM → graceful shutdown, 25 s hard limit) |
| Networking | public Railway domain; outbound IPv6 only if using the direct DB connection |
| Region | same as Supabase (or nearest) |
| Variables | §1, secrets sealed |
| Migrations | NOT on boot. Operator runs `npm run migrate` before the first deploy. |

`railway.json` was removed: Railway's docs say config-as-code is deprecated, new services cannot use it, and it stops working on 2026-12-01. `.railway/railway.ts` (Infrastructure as Code, typed against `railway@3.11.0`) replaces it; it needs Railway CLI ≥ 5.42.1 and was **not executed** (no account).

## 5. Strict rules that apply automatically in staging and production
The server refuses to start (and names the variable, never its value) when:
missing `SUPABASE_URL`, publishable key, secret key, hook secret, issuer, or both JWT secret and JWKS · CORS empty, `*` or non-https · `DATABASE_SSL=disable` · `SMS_PROVIDER` not `twilio`/`custom` · `IDEMPOTENCY_KEY_REQUIRED=false` · non-https Supabase/JWKS URL. Production additionally refuses `DATABASE_SSL=no-verify`, `LOG_LEVEL=debug|trace` and `STAFF_SIGN_IN=phone`.

## Sources
- [Supabase — Connect to your database](https://supabase.com/docs/guides/database/connecting-to-postgres)
- [Supabase — JWT signing keys](https://supabase.com/docs/guides/auth/signing-keys)
- [Supabase — API keys](https://supabase.com/docs/guides/api/api-keys)
- [Supabase — SSL enforcement](https://supabase.com/docs/guides/platform/ssl-enforcement)
- [Supabase — Send SMS hook](https://supabase.com/docs/guides/auth/auth-hooks/send-sms-hook) · [Auth hooks](https://supabase.com/docs/guides/auth/auth-hooks)
- [Supabase — Auth rate limits (per-IP defaults, Sb-Forwarded-For)](https://supabase.com/docs/guides/auth/rate-limits) · [Custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp) · [Email templates](https://supabase.com/docs/guides/auth/auth-email-templates) · [Password security](https://supabase.com/docs/guides/auth/password-security) · [Before User Created hook](https://supabase.com/docs/guides/auth/auth-hooks/before-user-created-hook)
- [Railway — Config as code (deprecated)](https://docs.railway.com/guides/config-as-code) · [Config reference](https://docs.railway.com/reference/config-as-code)
- [Railway — Infrastructure as Code](https://docs.railway.com/infrastructure-as-code) · [IaC reference](https://docs.railway.com/infrastructure-as-code/reference)
- [Railway — Outbound networking (IPv6)](https://docs.railway.com/reference/outbound-networking)
