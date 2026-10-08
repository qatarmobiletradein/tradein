# Qatar Mobile Trade-In API — handoff

For management and integration teams. Technical reference: `docs/openapi.json` (OpenAPI 3.1, generated from the code, validated by the test suite) and `docs/API.md`.

> **Status (2026-10-08):** staging-ready, **not deployed**. No staging or production URL exists yet. Nothing here has run on Supabase Cloud or Railway.

## At a glance
| | |
|---|---|
| Staging API URL | `https://<STAGING-API-HOST>` *(assigned at deployment)* |
| Production API URL | `https://<PRODUCTION-API-HOST>` *(next phase)* |
| API version | `4.1.0-staging`, path prefix `/v1` |
| Format | JSON over HTTPS; every response carries `X-Request-Id` |
| Authentication | Supabase Auth → Bearer access token (JWT). **Customers**: SMS code to their mobile. **Staff**: work email + password. |
| Data | Supabase PostgreSQL (row-level security as a second line of defence), Supabase Storage |
| Hosting | Railway (container built from this repository's Dockerfile) |

## What the API does
- **Customers**: estimate a device, submit a trade-in, follow it, accept or decline the offer, see the voucher.
- **Technicians**: inspection queue, IMEI check, inspection answers, evidence photos, final offer, device received / returned.
- **Partners (vendors)**: branch queues, issue / void / reissue vouchers, staff and branches, settlements view, reports.
- **Qatar Mobile admins**: everything above plus catalogue, pricing, grade ladder, inspection rules, partner fees, imports, customers, staff approval, collections, settlements, reports, audit, settings.
- **Operations**: `/health`, `/ready`; hourly reconciliation job.

## Endpoint groups
| Group | Paths | Who |
|---|---|---|
| Operations | `GET /health`, `GET /ready` | anyone (no data) |
| Sign-in (customers) | `POST /v1/auth/start · verify · register · refresh · logout · logout-all` | public (rate-limited) |
| Sign-in (staff) | `POST /v1/auth/staff/login · staff/reset/start · staff/reset/finish` | public (rate-limited) |
| Public | `GET /v1/public/vendor-context · catalog · questions` | public (no prices, no fees) |
| Actions | `POST /v1/actions/<action>` — 86 actions (`customer.*`, `tech.*`, `vendor.*`, `admin.*`, `search.*`, `notify.*`, `me.*`) | by role |
| Resource routes | `/v1/customer/…`, `/v1/tech/…`, `/v1/vendor/…`, `/v1/admin/…`, `/v1/me`, `/v1/notifications` | by role |
| Hook | `POST /v1/hooks/send-sms` | Supabase Auth only (signed) |

The resource routes and the action endpoint run the **same code**; the action names are those the existing screens already use.

## Security model
- **Three layers.** The frontend only shows or hides; the **API decides** every permission; the database enforces integrity rules and row-level security even if the API were bypassed.
- **Who you are** comes from a verified token; **what you may touch** (role, partner, branch) is re-read from the database on every request. A branch user who sends another branch's id gets "not found".
- **Roles**: SUPER_ADMIN (platform owner, approves settlements), QM_ADMIN (Qatar Mobile admin / finance), TECHNICIAN, VENDOR_ADMIN (partner-wide), VENDOR_MANAGER and VENDOR_STAFF (may be bound to one branch), CUSTOMER.
- **Sessions** are revoked immediately when a role, status, partner or branch changes, or on "sign out everywhere".
- **Secrets** live only in Railway's sealed variables. The browser holds the API address and the person's own session.
- **Not claimed:** that the system is 100 % secure. No penetration test has been performed.

## Staff sign-in (email + password)
| Step | Call | Answer |
|---|---|---|
| Sign in | `POST /v1/auth/staff/login {email, password}` | the same session object as customers (`token`, `refreshToken`, `portal`, `user`). A wrong password and an unknown address get the same 422 sentence. |
| First password, or forgotten | `POST /v1/auth/staff/reset/start {email}` | always the same 200 sentence; for an ACTIVE staff address Supabase Auth e-mails a 6-digit code |
| …then | `POST /v1/auth/staff/reset/finish {email, code, password}` | password set, every earlier session of that person ended, signed in |
- A staff mobile number on `/v1/auth/start` gets 422 with `"useStaffSignIn": true` — no SMS is sent (also not if Supabase Auth is called directly).
- Passwords: at least 12 characters, letters and a number, not containing the address (Supabase's own policy on top).
- Staff accounts are created by administrators (or approved applicants) **with a work email**; changing a person's email ends their sessions and they set a password for the new address.

## Rate limiting
| Scope | Default |
|---|---|
| All requests, per client IP | 300 / minute |
| Sign-in routes, per client IP | 20 / minute |
| Codes per phone number | 1 per 60 s, 6 / hour, 12 / day |
| All codes, platform-wide | 300 / hour, 2,000 / day (registration: 60 / hour, 300 / day) |
| Wrong codes | 5 since the last code sent, then a new code is needed |
| Staff wrong passwords, per address | 5 in 15 minutes, then sign-in for that address pauses (a password reset lifts it) |
| Staff reset e-mails, per address | 1 per 60 s, 5 / hour (Supabase's own e-mail limit on top) |
| Staff reset e-mails, all staff | 25 / hour (`STAFF_RESET_EMAILS_PER_HOUR`, below the project's e-mail limit) |
| Staff wrong reset codes | 5 since the last code e-mailed |
Exceeding a limit returns HTTP 429 with a sentence.

## Idempotency (money and custody actions)
18 actions — trade-in creation, inspection completion, final offer, acceptance/decline, device received/returned, voucher issue/void/reissue, price/grade overrides, collection notes, settlements (create, submit, approve, pay), staff changes — require an `Idempotency-Key` header in staging and production:
- missing key → **428**, nothing done;
- same key, same request → the **original result** again (marked `"replayed": true`), nothing done twice;
- same key, different request → **409**.
The existing screens already send these keys.

## Errors
`{ "ok": false, "message": "<a sentence for a person>", "code": "<CODE>" }` — never a stack trace, table or constraint name. Codes: `VALIDATION` 400 · `UNAUTHENTICATED` 401 (`"reauth": true`) · `FORBIDDEN` 403 · `NOT_FOUND` 404 (also for objects outside your scope) · `CONFLICT` / `IDEMPOTENCY_KEY_REUSED` 409 · `BUSINESS_RULE` 422 · `IDEMPOTENCY_KEY_REQUIRED` 428 · `RATE_LIMITED` 429 · `UNAVAILABLE` 503 · `INTERNAL` 500.

## Example
```http
POST /v1/actions/customer.acceptOffer
Authorization: Bearer <access token>
Idempotency-Key: k3f9c2a1b0e4d5c6a7b8
Content-Type: application/json

{ "params": { "tradeInId": "TI-DEMO-000001" } }
```
```json
{ "ok": true, "message": "Offer accepted. Hand the device over at the shop to receive your voucher." }
```

## Support and ownership *(to be completed by the business)*
| Topic | Owner |
|---|---|
| Product / business rules | `<name>` |
| API and database operations | `<name>` |
| Supabase and Railway accounts (billing, access) | `<name>` |
| Incident contact and escalation | `<name / phone rota>` |
| SMS provider account | `<name>` |
Logs: Railway service logs (JSON, one line per request with `reqId`). Integrity: the `job_runs` and `reconciliation_issues` tables. Audit trail: `admin.audit` action.
