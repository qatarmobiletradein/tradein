# Data migration — Google Sheets (3.1) → Supabase PostgreSQL

**Migration has NOT been performed.** The tooling exists and was tested only on a fictional export against a throwaway local database. Nothing was read from or written to production.

## Inputs
1. **Export** — produced by the 3.1 owner-only function `migrationExportSheet_(name, offset, limit)` (`03_Migrations.gs`), run by the owner from the Apps Script editor, one JSON file per sheet (`<Sheet>.json`, or chunked `<Sheet>.<n>.json`). The export contains customer PII: store it encrypted, on an operator machine, never in the repository, delete after cutover.
2. **Evidence photos** — downloaded from Drive by an operator into a local folder, each file named by its Drive file id.

`Sessions`, `OtpCodes`, `Idempotency` are **never migrated** (3.1 refuses to export them; the importer ignores them with a warning). Everyone signs in again with Supabase Auth.

## Tools
| Command | Writes? | Purpose |
|---|---|---|
| `npm run import:sheets -- --dir X --mode dry-run` | nothing (no database) | maps every row, reports invalid rows, duplicates, ignored sheets |
| `npm run import:sheets -- --dir X --mode validate` | rolled back | inserts everything inside one transaction so **every constraint and trigger runs**, then rolls back |
| `npm run import:sheets -- --dir X --mode apply [--resume <runId>]` | yes | checkpoints per chunk; `--resume` continues an INTERRUPTED run (rehearsed: killed mid-run, resumed, no duplicates) |
| `npm run compare:sheets -- --dir X` | nothing | counts, exact financial totals, mismatches, orphans, duplicates, invalid states, broken file references |
| `npm run import:files -- --dir P [--apply]` | storage + DB | photos → private `inspection-photos` bucket, byte-validated, `legacy_file_map`; resumable; the Storage project must be the same project as the database |

**Target guard (all writing modes, and `validate`):** the command prints the target without the password; a non-local database needs `MIGRATION_TARGET_CONFIRM=<Supabase project ref>` (the database is always named `postgres` on Supabase, so the name cannot identify it); anything in `QM_PROTECTED_TARGETS` is refused; URL parameters or `PG*` variables that could redirect the connection are refused; TLS is verified by default (`DATABASE_SSL_CA`).

**Fictional exports for rehearsals:** `npm run make:fictional-export -- --out <dir> [--dirty]`; full CLI rehearsal: `npm run rehearse:migration`.

Reports go to `./migration-reports/` (JSON + `failed-rows.csv`). Run bookkeeping is in `migration_runs`, `migration_checkpoints`, `migration_row_errors`.

## Guarantees (tested on fictional data)
- **Deterministic ID mapping:** legacy id = new primary key. No generated ids for imported rows.
- **Idempotent apply:** re-running inserts nothing new (`on conflict do nothing` by legacy id).
- **Transactional group:** trade-ins, inspections, vouchers, collections, collection items and settlements are applied in one transaction with deferred FKs, so cross-references resolve or nothing is written.
- **Money exact:** values parsed as decimals into integer cents; no float.
- **Counters continued:** after apply, every `id_counters` scope is set past the highest imported number, so the next `TI-…`, `VCH-…`, `STL-…` does not collide.
- **Phones normalised** to E.164; invalid numbers are reported (masked to last 4 digits), not guessed.
- **Staff e-mails** are lower-cased and must be valid and unique: staff sign in with them (email + password). A malformed one rejects that user row with a clear message; duplicates are refused by the unique index. Fix them in the sheet, then re-run `dry-run`/`validate`.
- **Duplicates** in the export (same id twice, two open trade-ins for one IMEI, duplicate voucher numbers, duplicate phones) are reported before any write.
- **Invalid states** (unknown status, voucher without received device, etc.) are refused by the same constraints the live system uses.

## Not done / limits
- Never run against a real export. Column names follow 3.1 `SCHEMA`; *I'm not certain every historical row in production conforms* — that is what `dry-run` and `validate` are for.
- Partial rows that 3.1 left after an interrupted multi-sheet write may fail constraints. They will appear in `failed-rows.csv`; each needs a human decision (no automatic repair was invented).
- Drive download is a manual operator step (no Google credentials in this repo by design).
- Profiles are imported without `auth_user_id`. Customers link on their first verified SMS sign-in (tested). Staff get their Supabase Auth user the first time they use "Set or reset password" with the address on their profile (tested locally and with the real open-source Auth server).

## Procedure
See `CUTOVER_PLAN.md` steps 4–9.
