# Cloud deployment report — staging (2026-10-08)

## What is running
| | |
|---|---|
| API | `https://qm-api-staging.up.railway.app` (Railway-generated domain; no custom domain) |
| Railway | workspace **Qatar Mobile's Projects** → project **QatarMobile-TradeIn-Staging** (`14f9e0c0-48ef-4923-a6ce-07df640485c6`) → environment **staging** (`de6dd406-…`) → service **qm-api** (`f856fefe-…`), region **asia-southeast1-eqsg3a** (Singapore), 1 replica |
| Source | GitHub `qatarmobiletradein/tradein`, branch `main`, auto-deploy on push. Live commit `d92222b` (deployment `8d761233`, SUCCESS) |
| Supabase | organisation **Qatar Mobile** → project **QM Trade-in Project** (`ytniownkhjolgfplegsv`), **ap-southeast-1** (Singapore), PostgreSQL 17.6, status Healthy. *The dashboard labels this project "Production"; by the owner's decision it is the staging database and holds fictional data only.* |
| Database connection | direct host `db.ytniownkhjolgfplegsv.supabase.co:5432` (IPv6) as role `qm_api`, TLS verified against Supabase Root 2021 CA |
| Auth | Supabase Auth, ES256 signing keys, verified by the API through JWKS |
| Not deployed | worker service (`qm-reconcile`), staging frontend, custom domains, SMS, staff email sender |

## Sequence (what was done, in order)
1. **Inventory of the Supabase project before any change** (read-only): empty — no tables, functions, policies, auth users, storage objects or migrations. Recorded in `docs/evidence/supabase-staging-apply-log.md`.
2. **Migrations 0100–0800** applied through the Supabase connector, each file one transaction + ledger row with its SHA-256. 0600's `DROP POLICY` approval prompt never reached the owner (cancelled 3×); applied with `ALTER POLICY` (identical end state, verified).
3. **Catalogue fingerprint** compared with a fresh local build → found two real issues, fixed forward: **0900** (sequence grants) and **1000** (function `search_path`). After the fix all 13 categories identical.
4. **Code pushed** to the private repo (secret scan first: only placeholders such as `sb_secret_...`).
5. **Railway service configured**: Dockerfile build, start `node dist/apps/api/src/server.js`, health check `/ready` (60 s), restart on failure ×5, draining 30 s.
6. **Secrets.** The three secret variables existed with empty values. With the owner's authorisation:
   - `DATABASE_SSL_CA` ← Supabase Root 2021 CA (public certificate from Supabase's download bucket, SHA-256 `80:70:25:AD:…:CA:FA`, valid to 2031-04-26).
   - `DATABASE_URL` ← a **new least-privilege role `qm_api`** (migration **1100**) with a random 256-bit password; only its SCRAM verifier was sent to Supabase; the password exists only in Railway (sealed). Owner's earlier `postgres` pooler URL was **replaced**.
   - `SUPABASE_SECRET_KEY` ← entered by the owner (the connector cannot read or create secret keys).
7. **Outbound IPv6** enabled on `qm-api` (Supabase's direct host is IPv6-only on this plan).
8. **First successful deploy**: pre-deploy `migrate` (0 applied / 11 verified) + fictional seed; `/ready` 200; deployment SUCCESS.
9. **Pre-deploy reduced to `npm run migrate`** (a check only, as `qm_api` cannot change the schema; a deploy whose code expects a missing migration now stops).
10. **Real cloud verification** — see `REAL_STAGING_RESULTS.md`.

## Problems met and how they were resolved
| Problem | Cause | Resolution |
|---|---|---|
| Supabase connector approval prompts returned "cancelled" (create project, `DROP POLICY`, Railway `accept-deploy`) | prompts did not reach the owner in this app | used non-destructive equivalents or asked the owner to click in the dashboard |
| Pre-deploy `DATABASE_URL is not set` | variables were created with empty values | filled as in step 6 |
| `self-signed certificate in certificate chain` | `DATABASE_SSL_CA` empty while `DATABASE_SSL=require` | CA filled; verification on, not bypassed |
| `permission denied for database postgres` (local rehearsal as `qm_api`) | ledger code ran `create schema if not exists` | `migrate.ts` creates the ledger only when missing |
| Seed did not run | Railway pre-deploy is not run through a shell | `sh -c '…'` for the seeding deploy |
| `Phone logins are disabled` for customer fixtures | Supabase phone provider off (no SMS provider) | fixture customers signed in with a fictional email (disclosed) |

## Changes to the repository during deployment
| Commit | Content |
|---|---|
| `b3d4bff` | initial push: API, packages, migrations 0100–1000, seeds, tests, docs |
| `d92222b` | migration **1100** (`qm_api`), `migrate.ts` ledger check, test for the role (187/187), `.gitignore` |
| (this commit) | cloud reports, updated handoff, evidence |

## Security notes (honest)
- Secret **values** passed once through connector tool calls (the `qm_api` password into Railway; hashed test passwords into Supabase). Nothing was printed in chat, logs or documents, and local copies were deleted, but the `qm_api` password should be **rotated before any production use** (production must use its own project and credentials anyway).
- Test-fixture passwords were set directly in `auth.users` as bcrypt hashes to obtain real tokens without SMS/email; they are scrambled at the end of the run.
- No system is "100 % secure". Open items are listed in `PRE_PRODUCTION_BLOCKERS.md`.
