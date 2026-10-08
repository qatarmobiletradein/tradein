# Qatar Mobile Multi-Vendor Trade-In — Railway + Supabase (staging-ready)

Railway API (Node/TypeScript/Fastify) + Supabase (PostgreSQL, Auth, RLS, Storage), serving the **unchanged** 3.1 frontend through a transport shim. Customers sign in with an SMS code; staff with their work email and a password.

**Status: staging-ready, NOT deployed.** Built, tested locally, and run against a local emulation of the cloud (shipped Docker image, open-source Supabase Auth + PostgREST, TLS PostgreSQL). Not run on Supabase Cloud or Railway. Data not migrated. See `docs/STAGING_TEST_RESULTS.md`.

## Quick start (local, fictional data)
```bash
npm ci
npm run typecheck && npm run build
npm run test:db              # 185 automated tests on a throwaway PostgreSQL 16 (needs PG server binaries)
npm run test:ui              # browser smoke: customers by SMS code, staff by phone (3.1 mode) and by email + password
npm run rehearse:staging     # the staging verification against a local server
npm run rehearse:migration   # migration CLIs on fictional exports (incl. kill + resume)
npm run emulate:staging      # Docker image + Supabase Auth (GoTrue) + PostgREST + TLS DB + browser (needs Docker)
npm run openapi              # regenerate docs/openapi.json
```
The test scripts refuse to run if `DATABASE_URL` is already set, so they cannot be pointed at a real database.

## Staging
`docs/STAGING_DEPLOYMENT.md` (steps) · `docs/CLOUD_CONFIGURATION.md` (every setting, frontend-safe vs server-only) · `npm run seed:staging` · `npm run verify:staging` · `docs/PRE_PRODUCTION_CHECKLIST.md` · `docs/API_HANDOFF.md`.

## Layout
`apps/api` · `apps/web` · `packages/{domain,database,auth,validation,shared}` · `supabase/{migrations,seed}` · `tools/migration` · `tests` · `docs`

## Docs
| | |
|---|---|
| [ARCHITECTURE](docs/ARCHITECTURE.md) | data path, request lifecycle, known limits |
| [DATABASE_SCHEMA](docs/DATABASE_SCHEMA.md) | tables and the constraint for each brief rule |
| [AUTH_AND_RBAC](docs/AUTH_AND_RBAC.md) | Supabase Auth, SMS, roles, helpers, RLS |
| [API](docs/API.md) | every endpoint and action with roles |
| [RAILWAY_DEPLOYMENT](docs/RAILWAY_DEPLOYMENT.md) | prepared, not deployed |
| [SUPABASE_SETUP](docs/SUPABASE_SETUP.md) | project, auth hook, storage |
| [DATA_MIGRATION](docs/DATA_MIGRATION.md) | Sheets → PostgreSQL tooling |
| [CUTOVER_PLAN](docs/CUTOVER_PLAN.md) | 13 steps, not executed |
| [TEST_RESULTS](docs/TEST_RESULTS.md) | Phase 2 record |
| [PHASE2_CHANGELOG](docs/PHASE2_CHANGELOG.md) | changes and intentional differences from 3.1 |
| [STAGING_DEPLOYMENT](docs/STAGING_DEPLOYMENT.md) | exact staging steps (not yet performed) |
| [CLOUD_CONFIGURATION](docs/CLOUD_CONFIGURATION.md) | variables and platform settings |
| [STAGING_TEST_RESULTS](docs/STAGING_TEST_RESULTS.md) | what ran, where, and what did not |
| [PRE_PRODUCTION_CHECKLIST](docs/PRE_PRODUCTION_CHECKLIST.md) | the gate before production |
| [API_HANDOFF](docs/API_HANDOFF.md) · [openapi.json](docs/openapi.json) | for management / integrators |
| [STAGING_CHANGELOG](docs/STAGING_CHANGELOG.md) | this stage's fixes |

Secrets: environment variables only (`.env.example` lists them, with placeholders). The service role key must never reach the browser.
