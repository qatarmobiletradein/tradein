# Supabase setup

**Superseded for staging by `STAGING_DEPLOYMENT.md` (steps) and `CLOUD_CONFIGURATION.md` (settings).** No Supabase project has been created or touched by this work.

Corrections to the Phase 2 version of this page:
- Connection: the **session pooler** (port 5432, user `postgres.<ref>`, IPv4) or the **direct** connection (IPv6 unless the IPv4 add-on). Not the transaction pooler (6543) for migrations. Copy hosts from the dashboard's Connect dialog.
- TLS: enable SSL enforcement and set `DATABASE_SSL_CA` to the downloaded CA so the certificate is verified.
- Keys: prefer the new publishable/secret keys; they are sent only in the `apikey` header. Legacy anon/service_role keys still work (Supabase is deprecating them by end of 2026).
- JWT: prefer asymmetric signing keys via `SUPABASE_JWKS_URL` (`/auth/v1/.well-known/jwks.json`); the legacy secret may be set at the same time during a rotation.
- Send SMS hook: the API answers refusals with `200 {"error":{"http_code","message"}}` (verified against the open-source Auth server; not yet against Supabase Cloud). Hooks must answer within 5 s.
- Migration runner vs Supabase CLI: use one per database. The runner (`npm run migrate`) is the tested path.
- Storage: buckets are created by migration `…0400`; the optional catalogue read policy may be skipped with a WARNING if the migration role does not own `storage.objects`.

Checks after setup are automated: `npm run verify:staging` groups `db` (D-01…D-06) and `rls` (R-01…R-09).
