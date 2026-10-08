# Architecture — Phase 2

Status: **built and tested locally; not deployed.** Not run against a real Supabase project or Railway. See `TEST_RESULTS.md` for exactly what was executed.

## Data path

```
Browser (the unchanged 3.1 screens + qm-transport.js)
   │  HTTPS, Authorization: Bearer <Supabase access token>, Idempotency-Key
   ▼
Railway: apps/api (Node 20, Fastify, TypeScript)
   │  every business rule, authorisation check, transaction and audit write
   ▼
Supabase PostgreSQL (schema, constraints, triggers, RLS as defence in depth)
Supabase Auth (customers: phone OTP, Send SMS hook → Railway → SmsProvider; staff: email + password, reset code by e-mail via your SMTP)
Supabase Storage (catalog-media: public; inspection-photos: private, signed URLs)
```

The browser never talks to PostgREST or Storage with privileged keys. It holds only the API base URL and the user's own Supabase session tokens. The service role key exists only on Railway.

## Repository layout

| Path | What it is |
|---|---|
| `apps/api` | Fastify server: routes, the action registry, services (one per 3.1 module), jobs |
| `apps/web` | Build step that serves the **unchanged** 3.1 HTML with a transport shim (no redesign) |
| `packages/domain` | Pure 3.1 business rules: roles, transitions, grading, questionnaire, pricing, partner fees |
| `packages/database` | Pool, transactions with retry, advisory locks, counters, migration runner |
| `packages/auth` | JWT verification, principal resolution, the reusable authorisation helpers |
| `packages/validation` | Zod schemas for every action's input (unknown keys stripped) |
| `packages/shared` | Money (exact integer cents), time (Qatar business days), text, errors, config, logger |
| `supabase/migrations` | 7 SQL migrations (schema, integrity, RLS, storage, reference data, review hardening, staging readiness) |
| `supabase/seed` | Obviously fictional seed data |
| `tools/migration` | Google Sheets → PostgreSQL importer, comparison, file migration |
| `tests` | unit, integration (HTTP through the real app), DB/RLS, browser smoke |
| `docs` | these documents |

## Request lifecycle (every authenticated action)

1. **Edge controls** — helmet headers, CORS allow-list, global + auth-route rate limits, body size limit, `X-Request-Id` (caller value kept only if well-formed).
2. **Token** — `packages/auth/jwt.ts` verifies signature (HS256 secret or JWKS), `aud`, `iss`, expiry, `role = authenticated`. The service-role token is refused.
3. **Registry lookup** — `apps/api/src/registry*.ts` maps the action name to `{roles, schema, idem, run}`. Unknown actions and forbidden actions look identical.
4. **Validation** — Zod parses the params; unknown keys are dropped.
5. **Transaction** — `withTransaction` opens a transaction (statement and lock timeouts; retries serialisation failures and deadlocks).
6. **Principal** — re-read from the database **inside** that transaction: status, role, partner, branch, and `auth_valid_after` (revocation). A disabled user, a deactivated partner or branch, or a token issued before a revocation is refused.
7. **Idempotency** (money/state actions) — advisory lock on the key scope; a stored result is replayed, a different payload with the same key is a 409.
8. **Authorisation** — role from the registry, then object scope (`loadTradeInScoped`, `scopeBranch`, …) on rows read `FOR UPDATE`.
9. **Business logic** — ported from 3.1, using `packages/domain`.
10. **Audit** — written in the same transaction. Refusals are written afterwards on a separate connection so they survive the rollback.
11. **Response** — the 3.1 response shape `{ ok, ... }`; errors are a sentence and a code, never a stack trace.

## Why two URL shapes

- `POST /v1/actions/:action` — the compatibility endpoint used by the 3.1 frontend through the shim (same action names as 3.1's `apiCall`).
- REST routes (`/v1/customer/...`, `/v1/tech/...`, `/v1/vendor/...`, `/v1/admin/...`) for the vertical slice.

Both resolve to the **same registry entry**, so there is exactly one implementation of every rule.

## Defence in depth

| Layer | Role |
|---|---|
| Frontend | Only shows/hides. **Never** authorisation. |
| Railway API | The authority: role, partner scope, branch scope, ownership, money permissions, SUPER_ADMIN protections. |
| PostgreSQL constraints/triggers | Valid transitions, frozen values, voucher immutability, append-only audit, last SUPER_ADMIN, uniqueness. These hold even if the API has a bug. |
| RLS | If someone bypasses the API with an anon key or a user JWT: no writes at all, scoped reads, sensitive columns not granted. |

## Money

Integer cents in TypeScript (`number` within safe range; ratios via `BigInt`), `numeric(12,2)` in PostgreSQL (never `float`/`real`). Rounding is half-up, matching 3.1 `money_()` for the values 3.1 produced, without float drift. Fractions (grade multipliers) are stored as `numeric` and handled as basis points ×10⁴; partner fee rates as micro-units ×10⁶.

## Jobs and observability

- `npm run job:reconcile` — integrity checks (counts, orphans, invalid states, money mismatches, counters behind data) recorded in `job_runs` and `reconciliation_issues`, plus an audit row.
- `npm run job:purge` — expired idempotency keys and OTP send log.
- `npm run worker` — optional long-running service doing both on a timer.
- Structured JSON logs (pino) with `reqId`; redaction of authorization headers, tokens, codes, secrets.
- `/health` (process up) and `/ready` (database reachable; SMS configured or not).

## Known architectural limits (honest list)

- **Not executed against Supabase Cloud or Railway.** Since the staging-readiness stage, the GoTrue endpoints and the Send SMS hook were exercised against the open-source Supabase Auth server (v2.170.0) and RLS through real PostgREST (v12.2.12) in a local emulation; Storage REST is still only emulated, and the hosted services may run newer versions. Verify in staging (`npm run verify:staging`).
- **Supabase privilege model is assumed, not observed.** The emulation runs migrations as a non-superuser `postgres` with REFERENCES on `auth.users` and INSERT on `storage.buckets` granted; a real project may differ (see `STAGING_DEPLOYMENT.md` §2).
- Evidence photos are uploaded to Storage inside the database transaction. If the transaction then rolls back, the object can remain as an orphan. The reconciliation job does not yet sweep Storage.
- Refresh-token revocation relies on GoTrue's global logout plus the `auth_valid_after` check on every request. In the emulation, logout-all made the old refresh token unusable (E-08); if GoTrue's logout call fails it is best-effort.
- Notification RLS is stricter than the API's legacy fallback (direct reads may show fewer rows than the API) — safe direction.
- A serialisation/deadlock retry re-runs the whole action, so an upload inside it can leave an extra orphaned Storage object (data stays correct). No Storage sweep yet.
- All Supabase Auth calls come from Railway's IP, so Supabase's own per-IP auth limits act as one shared bucket for all users; the API's per-IP, per-number and wrong-code limits are the real controls. Review Supabase's auth rate-limit settings in staging. *(I'm not certain whether GoTrue can be told the client IP in this setup.)*
- Kept from 3.1 (would be new rules, so not changed — business decision): `tech.checkImei` and `tech.uploadPhotos` work in any trade-in state; submitting a trade-in reveals whether that IMEI already has an open trade-in ("There is already an open trade-in for this device").
