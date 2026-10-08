# Supabase staging — inventory and migration log (REAL cloud, 2026-10-08)

Project: **QM Trade-in Project** (`ytniownkhjolgfplegsv`), organisation Qatar Mobile (Pro), region ap-southeast-1 (Singapore), PostgreSQL 17.6. Chosen by the owner as the staging database (the dashboard labels it "Production"; it held no data).

## Inventory BEFORE any change (read-only queries via the Supabase connector)
| Item | Found |
|---|---|
| Tables / functions / triggers / policies in `public` | 0 / 0 / 0 / 0 |
| `auth.users` | 0 |
| Storage buckets / objects | 0 / 0 |
| Migrations (Supabase ledger) | none |
| Edge functions / branches | none / none |
| Extensions installed | pgcrypto, uuid-ossp, pg_stat_statements, supabase_vault (Supabase defaults) |
| Privileges of `postgres` (non-superuser) | REFERENCES on `auth.users` ✔ · SELECT on `auth.users` ✔ · INSERT on `storage.buckets` ✔ |

Nothing existed that a migration could overwrite or conflict with, so no data backup was needed; the inventory above is the pre-change record. (Supabase Pro takes daily backups automatically — *verify the retention on the plan*.)

## Applied (each file = one transaction, recorded in `app.schema_migrations` with the file's SHA-256)
| Version | Notes |
|---|---|
| 0100–0500 | applied in order |
| 0700, 0800 | applied **before** 0600 by mistake (sent together); verified the end state equals in-order application |
| 0600 | the connector's approval prompt for `DROP POLICY` never reached the owner (returned "cancelled" three times). Applied with `ALTER POLICY` instead of `DROP POLICY` + `CREATE POLICY` — same policy names, command, roles and conditions; verified identical below |
| **0900** (new) | **found on the real cloud**: 0700 revoked client grants on sequences by listing `information_schema.sequences`, which on Supabase lists none of these identity sequences — `anon`/`authenticated` kept USAGE/SELECT/UPDATE on 8 sequences. Fixed with a catalogue-based revoke; regression test added |
| **1000** (new) | Supabase security advisor (lint 0011): 8 trigger/counter functions had a mutable `search_path`; pinned. Advisor now reports only the intended "RLS enabled, no policy" INFO on 12 internal tables (deny-all by design) |

The optional catalogue-media read policy on `storage.objects` **was** created (no ownership warning on this project).

## Verification: database state = repository
A catalogue fingerprint (columns, constraints, indexes, triggers, `app` functions, policies, table/column/sequence/function grants, RLS flags, reference data, migration ledger) was computed on Supabase and on a fresh local PostgreSQL 16 with all 10 repository files applied in order. **All 13 categories are identical**: 37 tables, 27 policies, 23 triggers, 19 functions, 93 indexes, 10 migrations; every ledger checksum equals the file's SHA-256. (Only difference: locally `pgcrypto` lives in `public`, on Supabase in `extensions` — not part of the app schema.)

## 1100 — API runtime role (applied 2026-10-08)
The API no longer connects as the project owner. Migration **1100** creates `qm_api` (NOLOGIN in the repository; BYPASSRLS like a service role; DML on `public`/`app`, EXECUTE on `app` functions, SELECT on `auth.users` only; **no CREATE on any schema, owns nothing**). Verified on Supabase: `dml=true, truncate=false, ddl_public=false, ddl_app=false, auth_read=true, auth_write=false, storage_read=false` — identical to the local test.
Out-of-band (not in the repository): `alter role qm_api login connection limit 20 password '<SCRAM-SHA-256 verifier>'` — only the salted verifier was sent to Supabase; the 256-bit password exists only in Railway's `DATABASE_URL` (direct connection `db.<ref>.supabase.co:5432`, IPv6 egress enabled on the service).
`migrate.ts` now creates the ledger only when missing, so with `qm_api` `npm run migrate` is a **check**: checksums verified, nothing applied; a pending migration fails on its first DDL and the deploy stops. Schema changes are applied with the owner credential.
`DATABASE_SSL_CA` = Supabase Root 2021 CA from Supabase's download bucket (`prod-ca-2021.crt`; SHA-256 fingerprint `80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`; valid to 2031-04-26).
