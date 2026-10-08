# Railway deployment

**Superseded for staging by `STAGING_DEPLOYMENT.md` (steps) and `CLOUD_CONFIGURATION.md` (settings).** Not deployed.

What changed since Phase 2:
- `railway.json` was **removed**. Railway's documentation states config-as-code is deprecated, new services cannot opt into it, and existing files stop working on 2026-12-01; `NIXPACKS` is no longer a listed builder.
- The service is built from the repository **`Dockerfile`** (Railway builds a Dockerfile whenever it finds one): pinned `node:22.22.0-bookworm-slim` by digest, multi-stage, production dependencies only, runs as the `node` user, `CMD node dist/apps/api/src/server.js` (exec form, so SIGTERM reaches Node for the graceful shutdown).
- Optional **Infrastructure as Code**: `.railway/railway.ts` (`railway config plan` / `apply`, Railway CLI ≥ 5.42.1). Staging only; secrets are `preserve()`d; describes the whole project (resources not in it are deleted on apply). Not executed.
- Health check `/ready` (database, environment, SMS configured). Liveness `/health`.
- Migrations are never run on boot: `npm run migrate` from an operator machine (target-confirmed by project ref). A Railway pre-deploy migration step is deliberately not configured.
- Client IP: `TRUST_PROXY_HOPS=1` (verify on Railway).
- Database: session pooler (IPv4) by default; direct connection only with outbound IPv6 enabled on the service.

Built and run locally from the shipped Dockerfile (image ≈ 337 MB, `node_modules` 23 MB): see `STAGING_TEST_RESULTS.md`.
