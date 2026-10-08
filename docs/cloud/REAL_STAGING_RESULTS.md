# Real staging results — Qatar Mobile Trade-In (2026-10-08)

**Environment tested:** Railway `QatarMobile-TradeIn-Staging` / service `qm-api` / environment `staging` (asia-southeast1, Singapore) → Supabase project `QM Trade-in Project` (`ytniownkhjolgfplegsv`, ap-southeast-1, PostgreSQL 17.6).
**API:** `https://qm-api-staging.up.railway.app` — commit `d92222b`, deployment `8d761233`.
**Data:** fictional seed only (`VND-001`, `VND-002`, `*.example.test`, test IMEIs prefixed `99`). No production data was touched.

Rule used: **PASS only if it ran against the real cloud named above.** Anything that only ran locally is marked so.

## Summary
| Area | Result | Where it ran |
|---|---|---|
| Deploy, `/health`, `/ready` | **PASS** | Railway → Supabase |
| Migrations (11) + DB state = repository | **PASS** | Supabase |
| Staff email + password sign-in | **PASS** | Railway API → Supabase Auth |
| Staff password set/reset by 6-digit **email code** | **NOT EXECUTED** (no email sender yet) | — |
| Customer SMS sign-in | **NOT EXECUTED** (no SMS provider; phone provider off) | — |
| Token validation (ES256/JWKS, issuer, audience, tampering) | **PASS** | real Supabase tokens |
| Expired token | see A-07 below | real Supabase token |
| Role / partner / branch mapping | **PASS** (11 profiles) | cloud |
| Disabled users, revocation, sign-out everywhere | **PASS** | cloud |
| Refresh-token reuse | **FAIL** (Supabase setting) | cloud |
| RLS (direct Supabase access) | **PASS** (9 checks) | Supabase REST |
| Storage | **PASS** (4 checks) | Supabase Storage |
| Idempotency | **PASS** (12 checks) | cloud |
| Concurrency | **PASS** (6 checks) | cloud |
| Vertical flow | **PASS** (8 steps) | cloud |
| Financial validation | **PASS** | cloud API + database |
| Negative tests | **PASS** (11 checks) | cloud |
| Client-IP spoofing (`X-Forwarded-For`) | **PASS** | cloud |
| `SUPABASE_AUTH_FORWARD_CLIENT_IP` | **NOT EXECUTED** (Supabase IP forwarding not switched on) | — |

**Counts:** verification suite **81 PASS · 0 FAIL · 2 SKIPPED** (both SKIPs closed separately below) · database checks **6/6 PASS** · extra cloud checks **6 PASS · 1 FAIL** · local suite **187/187**.

## 1. Deployment
| ID | Check | Result | Evidence |
|---|---|---|---|
| DEP-01 | Image builds on Railway from `qatarmobiletradein/tradein@main` (Dockerfile, pinned Node 22.22 base) | PASS | build ≈30 s, image 82 MB |
| DEP-02 | Pre-deploy `npm run migrate` as the API role: checksums verified, nothing applied | PASS | `target: qm_api@db.ytniownkhjolgfplegsv.supabase.co … applied 0, alreadyApplied 11` |
| DEP-03 | Database TLS verified against Supabase Root 2021 CA (`DATABASE_SSL=require` + `DATABASE_SSL_CA`) | PASS | connection succeeded; an earlier attempt without the CA failed with `self-signed certificate in certificate chain` (fails closed) |
| DEP-04 | Fictional seed loaded as `qm_api` | PASS | `Fictional base + staging seed loaded.` |
| DEP-05 | `GET /health` | PASS | 200 `{"ok":true,"service":"qm-api","status":"up"}` |
| DEP-06 | `GET /ready` | PASS | 200 `database:true, idempotencyKeysRequired:true, staffSignIn:password, sms:not configured`, `environment: staging` |
| DEP-07 | Railway health check on `/ready` gates the deploy | PASS | deployment `SUCCESS` only after `/ready` 200 |
| DEP-08 | API refuses to start without `SUPABASE_SECRET_KEY` | PASS | `Refusing to start: SUPABASE_SERVICE_ROLE_KEY is required outside development.` |
| DEP-09 | API database role `qm_api`: DML yes, DDL/TRUNCATE no, owns nothing, `auth.users` read-only | PASS | catalogue query on Supabase = local test |
| DEP-10 | Security headers (HSTS, CSP, nosniff, frame-ancestors none), no `X-Powered-By` | PASS | P-04 |

## 2. Database
| ID | Check | Result |
|---|---|---|
| DB-01 | Ledger has 11 migrations, each checksum = SHA-256 of the repository file | PASS |
| DB-02 | Catalogue fingerprint (tables, columns, FKs, unique/check constraints, indexes, RLS flags, policies, functions, triggers, grants, reference data) identical to a fresh local build of the repository (13 categories; 37 tables, 27 policies, 23 triggers, 19 functions, 93 indexes) | PASS (run before 1100; 1100 verified separately, DEP-09) |
| D-01 | 12 reconciliation invariants (single live voucher, voucher links, duplicate open IMEI, settlement count/total, cancelled/paid settlements, collection lines, trade-in total = value + fee, orphan photos) — 0 issues | PASS |
| D-02 | Every settlement header equals its lines (4 settled trade-ins, 8,400 QAR across `STL-00001` PAID 2,100 · `STL-00002` 2,100 · `STL-00003` 4,200) | PASS |
| D-03 | RLS on every public table; no INSERT/UPDATE/DELETE/TRUNCATE grant to `anon`/`authenticated` | PASS |
| D-04 | Buckets: `catalog-media` public 2 MB, `inspection-photos` private 4 MB, image MIME types only | PASS |
| D-05 | Migrations all applied, checksums recorded | PASS |
| D-06 | No JWT/code in audit (`jwt_in_audit = 0` over 180 audit rows); OTP tables have no code/token column | PASS |
| DB-03 | ID counters never behind data | PASS |
| DB-04 | Supabase security advisor | INFO only for intended deny-all internal tables (12) · **WARN: leaked-password protection off** (Auth setting → blocker list) |

D-01…D-06 ran through the Supabase connector (read-only SQL) because the test machine cannot open a database socket; the SQL is the verification tool's own.

## 3. Authentication (real Supabase Auth)
How tokens were obtained — **disclosed test-fixture step**: there is no SMS provider and no staff email sender yet, so:
- **Staff (9):** the live API created each staff member's Supabase Auth user itself (`POST /v1/auth/staff/reset/start` → admin API with the `sb_secret_` key → `app_metadata.qm_staff`, email confirmed, linked to `app_users.auth_user_id`). A random test password was then set **as a bcrypt hash only** directly in `auth.users` (stands in for the emailed code), and every staff member signed in through the **live API** `POST /v1/auth/staff/login` → Supabase password grant.
- **Customers (2):** Auth users created in `auth.users` with a fictional `*@customer.example.test` email and a hashed test password (phone sign-in is disabled on the project), linked to `customers.auth_user_id` (stands in for the SMS verify step), signed in directly at Supabase Auth.
- No code, password or token is printed in any report. The fixture passwords are scrambled after the run (see §9).

| ID | Check | Result | Evidence |
|---|---|---|---|
| A-ME (×11) | each token accepted; role, partner and branch read from the database (SUPER_ADMIN, 2× QM_ADMIN, TECHNICIAN, 2× VENDOR_ADMIN, VENDOR_MANAGER, 2× VENDOR_STAFF, 2× CUSTOMER) | PASS | |
| A-01 | issuer/audience/alg | PASS | `alg=ES256 iss=https://ytniownkhjolgfplegsv.supabase.co/auth/v1 aud=authenticated` (JWKS, no shared secret) |
| A-02…A-06 | no token, garbage, tampered signature, escalated claims, `alg:none` → 401 | PASS | |
| A-07 | expired token → 401 | see §8 | |
| A-08 | publishable key is not a user token | PASS | |
| A-09 | sign-in endpoints rate limited, never return a code | PASS | |
| A-10 | a staff phone number cannot get an SMS code | PASS | |
| A-11 / A-12 | wrong password vs unknown address: same answer; reset start: same reply, sends nothing for unknown | PASS | |
| A-13 | repeated wrong passwords pause that address (429) | PASS | |
| A-14 | Supabase password session carries `amr=password` + email (what the API's staff rule relies on) | PASS | |
| AUTH-PROV | API provisions staff Auth users through Supabase admin API with an `sb_secret_` key | PASS | 9/9 linked, `qm_staff=true`, confirmed (closes the "not verified on Supabase Cloud" note in CLOUD_CONFIGURATION.md) |
| AUTH-MAIL | reset e-mail when no sender is configured: nothing delivered, recorded as not delivered | PASS (behaviour) | Supabase built-in mailer refused `.test` addresses then hit its rate limit; audit `delivered:false`; no `RESET_EMAIL` slot consumed |
| X-01 | disabled staff: existing token refused at once; password sign-in refused | PASS | before 200 → after 401; login 422 |
| X-02 | re-enabled staff: pre-disable token stays dead; new sign-in works | PASS | old 401, new 200 |
| X-03 | disabled customer: existing token **and a brand-new Supabase token** refused | PASS | 401 / 401 |
| X-04 | re-enabled customer signs in again | PASS | |
| X-05 | spent refresh token refused after the reuse window | **FAIL** | API refresh works (200, new token 200), but Supabase accepted the spent refresh token again 20 s later → refresh-token reuse detection appears **off** (or reuse interval > 20 s) in Supabase Auth settings. The API forwards refresh to Supabase unchanged. Fix = Supabase setting (blocker list). |
| X-06 | sign out everywhere: token and refresh token stop working; other users unaffected | PASS | 401 / 401 / other 200 |
| N-11 | customer cannot act as staff | PASS | |
| — | an **SMS** session cannot become staff | NOT EXECUTED on cloud (needs an SMS session); PASS locally (staff-password suite) |
| — | a **reset (recovery)** session cannot become staff | NOT EXECUTED on cloud (needs an emailed code); PASS locally |

## 4. Client IP / rate limiting
| ID | Check | Result | Evidence |
|---|---|---|---|
| X-07 | a client-supplied `X-Forwarded-For` does not get around the API's per-IP sign-in limit | PASS | 24 attempts each with a different spoofed `X-Forwarded-For` drew one shared counter 19→0, then 429 at attempt 21 — identical to no header (`TRUST_PROXY_HOPS=1`). |
| — | `SUPABASE_AUTH_FORWARD_CLIENT_IP=true` (Supabase's own per-IP limits per end user) | NOT EXECUTED | Supabase "IP address forwarding" is not switched on (dashboard-only setting). Until it is, Supabase's per-IP Auth limits are shared by every user behind Railway; the API's own per-address and per-IP limits remain in force (A-09, A-13, X-07). |

## 5. RLS (direct Supabase REST with the publishable key and real user tokens)
R-01 anon reads nothing private · R-02 catalogue public, partner fee hidden · R-03 nobody writes directly · R-04 customer sees only own rows · R-05 branch staff only their branch, never the IMEI · R-06 partner admin only their partner · R-07 finance per business permissions · R-08 QM admin/SUPER_ADMIN read across partners · R-09 internal counter RPC not callable — **all PASS**.

## 6. Storage
S-01 technician upload; disguised SVG refused · S-02 private photo via short-lived signed URL, scope enforced · S-03 private bucket not public/listable · S-04 catalogue image public, uploads only via API — **all PASS**.

## 7. Business flow, financial validation, idempotency, concurrency, negative
- **Vertical flow F-01…F-08 PASS:** customer trade-in `TI-DEMO-000001` → inspection + offer (value 2,000 + fee 100 = **2,100 QAR**) → customer accepts (replay-safe, other customer refused) → device received → branch voucher `DEMO-20261008-0001` (other branch refused, duplicate prevented) → collection `BAT-00001` → settlement `STL-00001` (1 line, 2,100 QAR) → QM admin refused approval, platform owner approved, finance paid.
- **Financial:** F-02/F-07 totals + D-01/D-02 (total = value + fee for every trade-in; every settlement header = sum of its lines) — PASS.
- **Idempotency I-01…I-12 PASS** (`IDEMPOTENCY_KEY_REQUIRED=true`: 10 money/state actions refuse a missing key with 428 and do nothing; reads need none; malformed key refused).
- **Concurrency C-01…C-06 PASS:** same IMEI ×5 → one trade-in; same voucher ×5 → one live voucher; same collection ×3 → each device on one note; same settlement ×3 → each device in one settlement; same key ×5 → one effect; void + reissue chain intact.
- **Negative N-01…N-11 PASS:** cross-branch, cross-partner, branch-id tampering, lower role vs SUPER_ADMIN, duplicate IMEI, key reuse with different payload (409), duplicate collection/settlement, invalid transitions, unauthorised finance, customer as staff.

## 8. Expired token (A-07)
Run at the end of the session with a real token issued at 03:32 UTC (exp 04:32 UTC) — result recorded in `docs/evidence/cloud-verify-expired-token.md`.

## 9. Not executed (exact list)
1. Customer SMS OTP sign-in end to end (no SMS provider; Supabase phone provider disabled).
2. Staff password **set/reset by 6-digit email code** end to end (no staff email sender configured; Microsoft Graph not configured by instruction). The endpoints ran; delivery and code verification did not.
3. "SMS session cannot become staff" on the cloud (local PASS).
4. "Reset/recovery session cannot become staff" on the cloud (local PASS).
5. `SUPABASE_AUTH_FORWARD_CLIENT_IP` on the cloud (Supabase IP forwarding off).
6. Railway worker service (`qm-reconcile` hourly job) — not deployed; its invariant SQL ran read-only (D-01).
7. SUPER_ADMIN MFA — not built (pre-production item, not a staging blocker).
8. Staging frontend — none deployed; `CORS_ALLOWED_ORIGINS` is a placeholder.
9. Load / performance test; backup restore / PITR drill.
10. Custom domains (`api.qatarmobile.qa`, `tradein.qatarmobile.qa`) — deliberately not connected.
11. Production data migration and cutover — deliberately not done.

## 10. Findings raised by the cloud run
| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | Migration 0700 did not revoke client grants on identity sequences on Supabase | Medium | fixed: migration 0900 + test |
| 2 | 8 trigger/counter functions had a mutable `search_path` (advisor lint 0011) | Low | fixed: migration 1000 |
| 3 | API connected as the schema owner | Medium | fixed: migration 1100 (`qm_api`, no DDL) |
| 4 | Railway pre-deploy commands are not run through a shell (`&&` was passed as arguments) | Low | fixed: `sh -c` for the seed run; now `npm run migrate` only |
| 5 | Supabase refresh-token reuse accepted after 20 s | Medium | **open** (Supabase Auth setting) |
| 6 | Leaked-password protection off | Low | **open** (Supabase Auth setting) |
| 7 | Audit action `STAFF_PASSWORD_RESET_SENT` is written even when delivery failed (details correctly say `delivered:false`) | Low | open (rename to `…_REQUESTED` in a later change) |
