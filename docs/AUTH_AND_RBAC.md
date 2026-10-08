# Authentication and authorisation

## Authentication (Supabase Auth)

| Who | How (STAFF_SIGN_IN=password — staging and production) |
|---|---|
| Customers | phone OTP, exactly as below |
| Staff | **work email + password** (owner decision, staging phase) — see "Staff: email + password" |

With `STAFF_SIGN_IN=phone` (development/test default; refused in production) staff also use the phone OTP, as in 3.1.

**Apps Script sessions are not migrated and not accepted.** The old `sessionToken` values are not imported; the API accepts only a verified Supabase access token. Every user signs in again after cutover.

### Flow
```
Browser ──POST /v1/auth/start {phone}──▶ Railway ──▶ GoTrue /otp (create_user only if no auth user is linked yet)
                                                       │
                       GoTrue ──Send SMS hook (Standard Webhooks HMAC)──▶ Railway /v1/hooks/send-sms
                                                       │  deliverOtp(): purpose, blocked accounts, cooldown,
                                                       │  per-phone hour/day, global hour/day per purpose,
                                                       │  otp_send_log (never the code) ──▶ SmsProvider
Browser ──POST /v1/auth/verify {phone, code}──▶ Railway ──▶ GoTrue /verify ──▶ access + refresh token
                                                       │  resolvePrincipal(allowLink): link profile ↔ auth user by phone
```

- **Profile mapping.** `app_users.auth_user_id` / `customers.auth_user_id` reference `auth.users(id)`. On the first verified sign-in the profile with that phone is linked. If the same phone exists as staff and customer, staff wins (as 3.1).
- **Registration.** Customer: `auth.register` → code → verify → ACTIVE customer with a session. Staff: PENDING_APPROVAL with **no role and no session**; sign-in is refused until an administrator approves and chooses the role.
- **Refused states.** Disabled, pending, deactivated partner/branch, unknown user → no session.
- **Revocation.** `auth_valid_after` on the profile. Any role/status/partner/branch change, logout-all, disabling a customer or deactivating a partner/branch sets it to `now()`; every request compares the token `iat` and refuses older tokens. *(Limit: `auth_valid_after` only rejects tokens issued **before** the revocation. Logout-all also calls GoTrue's global sign-out, but that call is best-effort; if it fails, a surviving refresh token could mint a fresh access token that the API would accept for a still-ACTIVE account. Disabled/pending accounts are always refused regardless of token. Verify GoTrue refresh-token revocation in staging.)*
- **Token verification** (`packages/auth/src/jwt.ts`): JWKS (ES256/RS256, recommended) and/or the legacy HS256 secret — both may be configured during a signing-key rotation; the token header only selects the key source, each source has a fixed algorithm list (no algorithm confusion, `none` never accepted). Checks signature, `exp`, `aud`, `iss`, required claims, `role = authenticated` (anon/service-role refused) and refuses anonymous sign-ins (`is_anonymous`).

### Staff: email + password (`apps/api/src/services/staff-auth.ts`)
```
Browser ──POST /v1/auth/staff/reset/start {email}──▶ Railway: ACTIVE staff with that address?
                     (same reply either way)          │ yes: set up the Supabase Auth user with the SECRET key
                                                      │      (create, or move an existing one to this address
                                                      │       with a fresh unknowable password) ──▶ GoTrue /recover
                                                      │      ──▶ "Reset password" e-mail with a 6-digit code
Browser ──POST /v1/auth/staff/reset/finish {email, code, password}──▶ GoTrue /verify (recovery) ──▶ PUT /user
                                                      │  logout global; auth_valid_after; then sign in ↓
Browser ──POST /v1/auth/staff/login {email, password}──▶ GoTrue /token?grant_type=password ──▶ resolvePrincipal
```
- **Who is staff.** A staff profile is accepted only for a Supabase session that (a) belongs to the Auth user the API itself linked to that profile (`auth_user_id`; never linked from a token claim, never by phone), (b) was established with a password (`amr` contains `password` — a phone-code or password-recovery session is refused), and (c) still carries the profile's email. Otherwise the request is refused (`STAFF_METHOD`).
- **No SMS for staff.** `auth.start` answers a staff number with `useStaffSignIn`; the Send SMS hook refuses staff numbers even if Supabase Auth is called directly.
- **Applicants** must give a work email; administrators must give one when creating staff; it is unique (case-insensitive) and validated. Changing it ends the person's sessions; the next "set or reset" moves their Auth user to the new address with a fresh password, so an old password never carries over.
- **Limits** (reserved before Supabase is asked, under a lock per address, so concurrent attempts all count): wrong passwords `STAFF_LOGIN_MAX_FAILURES` (5) per 15 min then pause; reset e-mails 1/60 s and 5/hour per address (kept even when the e-mail fails, so an outage cannot be used to hammer); wrong reset codes 5 since the last e-mail; reset e-mails for all staff together `STAFF_RESET_EMAILS_PER_HOUR` (25, reserved under one lock). Addresses are stored hashed in `staff_auth_attempts` (deleted after 90 days by the hourly job); passwords and codes are never stored, logged or audited. Supabase's own 429 never costs the person an attempt.
- **Same reply, same speed.** "Set or reset" answers at once for every address; looking the address up, setting up the Auth user and the e-mail happen after the reply (finished before shutdown).
- **Address changes.** When an administrator changes a staff email, the profile is unlinked from its Auth user immediately — the old password and any refresh token issued for it can never yield this profile's session again. The person sets a password for the new address (a fresh Auth user).
- **Stray Auth users.** "Allow new users to sign up" must stay on for customers, so anyone can create an Auth user with an email directly. It can never be a staff session (rule a). If it holds a staff address, no profile uses it, and it either never confirmed the address or is one the API manages (`app_metadata.qm_staff`), the API deletes it during set-up; otherwise set-up is refused and `STAFF_SIGNIN_CONFLICT` is audited for an administrator.
- **Addresses** are ASCII only (case-folding of other letters differs between JavaScript and Supabase Auth).
- **Supabase's per-IP limits.** All Auth calls come from the API's IP. Either switch on Supabase's IP forwarding and `SUPABASE_AUTH_FORWARD_CLIENT_IP` (the API then sends `Sb-Forwarded-For` with the new secret key), or raise Supabase's per-IP limits — see `CLOUD_CONFIGURATION.md` §2. Without one of these, a burst from a few clients can exhaust Supabase's shared limits for everyone.
- **Known disclosure (accepted, same class as 3.1's "no account for this number"):** `auth.start` says a number is a staff number. A determined attacker who knows staff addresses can use up the platform's hourly reset-email budget (refused sends are audited); raise the Supabase e-mail limit and `STAFF_RESET_EMAILS_PER_HOUR` together.
- **Not built:** multi-factor authentication. Supabase offers TOTP MFA; recommended for SUPER_ADMIN before production.

### SMS
`apps/api/src/lib/sms/provider.ts` — `SmsProvider` interface with:
| Provider | Use |
|---|---|
| `twilio` | Production implementation (credentials from env). |
| `custom` | Production implementation for an https SMS gateway. |
| `test` | Captures codes in memory for automated tests. **`loadConfig` refuses it when `APP_ENV` is `staging` or `production`; `APP_ENV` defaults to `production`.** |
| `none` | Default. Fails closed: the hook refuses, no code is sent. |

OTP limits keep the 3.1 principles: TTL, resend cooldown, per-number hourly/daily ceilings, global hourly/daily ceilings with a separate (lower) registration budget, and the **wrong-code limit** (`OTP_MAX_ATTEMPTS`, default 5 since the last code sent; then "Too many incorrect attempts. Ask for a new code."; attempts are reserved under a per-number lock so concurrent guesses all count; `OTP_FAILED`/`OTP_LOCKED_OUT` audited with a masked number). All clamped so a typo cannot disable a limit. The code is never logged, stored or audited.

Send SMS hook protocol: success `200 {}`; a refusal `200 {"error":{"http_code","message"}}`, which Supabase Auth relays (a non-2xx answer would become a generic 500 and 429/503 would be retried) — verified against the open-source Auth server v2.170.0 in the local emulation, not yet against Supabase Cloud. A caller who goes to Supabase Auth directly still meets the same hook policy (disabled accounts refused, limits applied), and a Supabase session for a number with no profile is refused by the API and sees nothing through the Data API.

Sign-in actions are served **only** by `/v1/auth/*` (stricter rate limit). Per-IP limits use the client IP as seen by the trusted proxy hops (`TRUST_PROXY_HOPS`, default 1), so a client-supplied `X-Forwarded-For` cannot reset them. *I'm not certain Railway adds exactly one hop; verify in staging.*

> `OTP_TTL_MINUTES` only sets the SMS wording; the real expiry is Supabase Auth's own OTP expiry setting — keep them equal.

> I'm not certain the twilio/custom providers work against the live services — they were not executed (no credentials, by design). See `TEST_RESULTS.md`.

## Authorisation — three layers

| Layer | Authoritative? | Implementation |
|---|---|---|
| Frontend | **No.** Visibility only. | unchanged 3.1 screens |
| Railway API | **Yes.** | registry roles + `packages/auth/src/authz.ts` |
| Database | Backstop | constraints/triggers + RLS (`…0300_rls.sql`) |

### Roles (3.1 vocabulary)
`SUPER_ADMIN` (platform owner), `QM_ADMIN` (Qatar Mobile admin — this is the **finance user**), `TECHNICIAN`, `VENDOR_ADMIN` (partner-wide), `VENDOR_MANAGER` and `VENDOR_STAFF` (may be branch-bound), `CUSTOMER`.

> **Business decision to confirm:** 3.1 has no separate FINANCE role. Finance work is done by `QM_ADMIN`; **settlement approval is SUPER_ADMIN-only** (3.1 rule, preserved). The seed's "finance user" is therefore a `QM_ADMIN`. If you want a distinct finance role, that is a new rule and was not invented here.

### Reusable helpers (`packages/auth/src/authz.ts`)
| Need | Helper |
|---|---|
| Role | `requireRole`, `roleAllows`, `requirePlatform`, `isPlatformAdmin` |
| Partner scope | `scopeVendor` — partner staff are pinned to their own partner; a requested partner id is ignored/refused |
| Branch scope | `scopeBranch`, `assertBranchBelongsTo`, `isBranchScoped` |
| Object scope | `loadTradeInScoped`, `loadVoucherScoped`, `loadBatchScoped` (row read `FOR UPDATE`; out of scope → "not found", audited) |
| Customer ownership | `loadTradeInScoped` for customers compares `customer_id` with the principal |
| Managing other users | `requireCanManageStaff`, `requireCanAdministerTarget`, `requireCanGrantRole` (`ROLE_GRANTS`), `resolveAssignableScope`, `requireBranchAdmin` |
| Financial permissions | registry roles on money actions + `requireSettlementApprover` + `settlementVisibleTo` (policy A) |
| SUPER_ADMIN protection | only a SUPER_ADMIN may change a SUPER_ADMIN; nobody changes their own role; last active SUPER_ADMIN protected by a DB trigger with an advisory lock; partner staff get the same "not found" for an owner as for a non-existent id (so owners cannot be discovered — a deliberate change from 3.1) |
| Sensitive fields | `canSeeFullImei` — technicians never receive the submitted IMEI |

**Rule that matters most:** partner, branch and role always come from the principal (database, via a verified token). The only ids taken from a request are the object being acted on, and that object is loaded with scope. A branch user submitting another branch's id gets "not found" (tested).

### ROLE_GRANTS (who may assign what; from 3.1 `00_Config.gs`)
| Actor | May assign |
|---|---|
| SUPER_ADMIN | all staff roles |
| QM_ADMIN | QM_ADMIN, TECHNICIAN, VENDOR_ADMIN, VENDOR_MANAGER, VENDOR_STAFF |
| VENDOR_ADMIN | VENDOR_MANAGER, VENDOR_STAFF (own partner) |
| VENDOR_MANAGER | VENDOR_STAFF (own partner, own branch if bound) |

## RLS (defence in depth)

Enabled on **every** public table; `anon`/`authenticated` have **no write** privilege anywhere. Read policies mirror 3.1 scope:
- platform admins: all; technicians: trade-in work (incl. customer name and offer values, as their 3.1 screens) but no submitted IMEI, partner fees, customers table, vouchers or finance tables;
- partner staff: own partner; branch-bound: own branch only (a blank branch is not theirs); settlements only for partner admins/managers (policy A); collection notes platform-admin only; partner notes/terms/fee rate not granted — all mirroring the API;
- customers: their own rows;
- anon: active catalogue, public partner/branch columns (never fee rates).

Column grants withhold the submitted IMEI and partner-fee columns from `authenticated` entirely. Covered tables include profiles (`app_users`, `customers`), `trade_ins`, `branches`, `vendors`, `vouchers`, `collections`/`collection_items`, `settlements`, `inspection_photos` (attachments), plus notifications and audit. Internal tables (idempotency, OTP log, counters, jobs, migration) have no policy → invisible. `app.next_counter` is not executable by clients.

The Railway server connects as the **table owner / service role**, which bypasses RLS by design and authorises everything itself. *Hardening not done:* a dedicated least-privilege database role for the API.

## Service role key
Only on Railway (`SUPABASE_SERVICE_ROLE_KEY`, sealed variable). Not in `apps/web`, not in the built HTML, not in logs (redacted), not in docs.
