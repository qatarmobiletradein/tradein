# Phase 2 changelog

Base: `QatarMobile_V3_SecurityFixed.zip` (3.1 security-fixed release, Phase 1 deliverable). Phase 2 adds a new backend; it does **not** modify the deployed Apps Script project.

## Added
- **Database** — 36-table PostgreSQL schema preserving every legacy id; exact `numeric` money; constraints and triggers for transitions, frozen values, voucher immutability, settlement locking, one live voucher per trade-in, one open trade-in per IMEI, branch-belongs-to-partner, settlement-item-belongs-to-settlement, last SUPER_ADMIN, append-only audit.
- **RLS** on every table (no client writes; scoped reads; column grants hide IMEI and partner fees). **Storage** buckets: public catalogue media, private evidence photos with signed URLs.
- **Railway API** (Fastify/TypeScript): 86 actions ported from 3.1 with the same names, REST routes for the vertical slice, Supabase Auth proxy, Send SMS hook, health/ready, graceful shutdown, structured logs.
- **Auth** — Supabase phone OTP mapped to profiles; revocation via `auth_valid_after`; `SmsProvider` (twilio, custom, test — refused in staging/production, none = fail closed); 3.1 OTP limits.
- **Authorisation helpers** for role, partner scope, branch scope, ownership, staff management, money permissions, SUPER_ADMIN protections.
- **Transactions + idempotency** for trade-in creation, offer, acceptance, device received/returned, voucher issue/void/reissue, collections, settlement create/advance; retries return the original result.
- **Audit** with actor, role, partner, branch, action, target, before/after, request id, IP, UA; denials kept even when the request rolls back; no codes/tokens/IMEIs in audit values.
- **Frontend transport** — `apps/web/qm-transport.js` implements `google.script.run.apiCall` over HTTPS; `build.mjs` serves the **checksum-verified, unchanged** 3.1 HTML. Switchable `railway` / `apps-script`.
- **Jobs** — reconciliation and purge, recorded in `job_runs`/`reconciliation_issues`.
- **Migration tooling** — dry-run / validate / apply (resumable, deterministic ids), compare, file migration.
- **Tests** — 129 automated tests on a throwaway PostgreSQL + a browser smoke test.
- **Config** — `.env.example` (browser-safe vs server-only), `railway.json`, `.nvmrc`, `.gitignore`.

## Behaviour differences from 3.1 (intentional, documented)
| Change | Reason |
|---|---|
| Sessions: Apps Script tokens → Supabase JWT; old sessions invalid | required by the brief |
| Money in exact decimals instead of float `money_()` | required ("never float"); same results for 3.1's values |
| Multi-sheet "recovery" paths for half-finished writes removed | a single transaction makes them unnecessary |
| Evidence photos: private bucket + 5-minute signed URL returned as `dataUrl` | keeps the unchanged 3.1 photo viewer working; the URL is short-lived and issued only after scope checks |
| `parseDayStart('2026-02-30')` refused instead of rolling into March | objective bug fix |
| Notification RLS stricter than the API's legacy audience fallback | defence in depth errs towards less |
| Idempotency keys optional by default | 3.1 allowed keyless calls from cached pages; `IDEMPOTENCY_KEY_REQUIRED=true` enforces them |

## Fixes from the independent review (all re-tested)
| Finding | Fix |
|---|---|
| `TRUST_PROXY=true` let a client pick its IP via `X-Forwarded-For` and evade per-IP limits | `TRUST_PROXY_HOPS` (default 1) |
| Sign-in reachable through `/v1/actions/auth.*` without the auth rate limit | removed from the compatibility endpoint |
| No wrong-code limit (Supabase verifies codes) | 3.1 `MAX_ATTEMPTS` restored in the API (`otp_verify_attempts`, concurrent-safe, audited) |
| RLS let VENDOR_STAFF read settlements, partners read collection notes and partner terms | narrowed to mirror the API (`…0600_hardening.sql`) |
| `PENDING` accepted as a collection outcome (also in 3.1) — released the device but left the line pending | refused with a sentence |
| Partner staff could discover SUPER_ADMIN ids (also in 3.1) | same "not found" as any out-of-scope id |
| RLS header comment overstated what technicians cannot see | corrected |

## Not changed (preserved as 3.1)
Roles and grants; trade-in and settlement state machines (28 + settlement edges); grading engine, ladder and inspection rules; pricing precedence and effective windows; partner fee precedence and rounding; voucher numbering (`<CODE>-yyyyMMdd-nnnn`, Qatar date); settlement visibility policy A; `cancelTradeIn` not exposed; settlement approval SUPER_ADMIN-only.

## Known gaps
See `ARCHITECTURE.md` → "Known architectural limits" and `TEST_RESULTS.md` → "NOT EXECUTED".
