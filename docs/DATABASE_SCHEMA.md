# Database schema

Source of truth: `supabase/migrations/*.sql` (7 files, applied in order, checksummed by `npm run migrate`). Verified by applying them to a throwaway PostgreSQL 16 with a small Supabase compatibility shim (`tests/sql/00_supabase_shim.sql`). **Not yet applied to a real Supabase project.**

| Migration | Contents |
|---|---|
| `…0100_core_schema.sql` | 35 tables (36 with `…0600`), keys, CHECKs, partial unique indexes, the `settlement_lines` view |
| `…0200_integrity.sql` | transition table + triggers, frozen values, settlement locking, last SUPER_ADMIN, append-only audit, voucher immutability, `updated_at` touch, `app.next_counter` |
| `…0300_rls.sql` | RLS on every public table, read policies, column grants, helper functions in schema `app` |
| `…0400_storage.sql` | Buckets `catalog-media` (public) and `inspection-photos` (private) + policies |
| `…0500_reference_data.sql` | Default grade ladder (A–D, R) and 18 inspection rules from 3.1 |
| `…0600_hardening.sql` | Review fixes: `otp_verify_attempts` (wrong-code limit); RLS narrowed on settlements, collections and partner commercial columns |
| `…0700_staging_readiness.sql` | Revokes Supabase's default client grants on the `settlement_lines` view and sequences, and removes default privileges so a future table starts with no client access |

Note: `…0400` creates the optional catalogue read policy inside a guarded block — if the migration role does not own `storage.objects` (possible on Supabase), it is skipped with a WARNING instead of failing.

## Principles

- **Legacy IDs are the primary keys** (`USR-00001`, `VND-001`, `BR-0001`, `CUS-00001`, `TI-DEMO-000001`, `VCH-000001`, `BAT-00001`, `STL-00001`…), each with a format CHECK. A migrated record keeps the number printed on vouchers, notes and invoices.
- **Money is `numeric(12,2)`**; rates `numeric(7,6)`/`numeric(12,6)`; grade fractions `numeric(5,4)`. No float anywhere.
- New IDs come from `app.next_counter(scope)` inside the same transaction (row-locked counter; no gaps from a race, no duplicates). Clients cannot execute it.
- Rules enforced by a script lock in 3.1 are now constraints/triggers, **and** the API checks them first so people get a sentence.

## Tables

### Partners, people
| Table | Notes |
|---|---|
| `vendors` | Partners (legacy name kept). Code `^[A-Z0-9]{2,6}$`, unique case-insensitively, frozen once used in IDs. `default_commission_rate` 0–1. |
| `branches` | `unique (id, vendor_id)` so other tables can FK `(branch_id, vendor_id)` → **a branch always belongs to that partner**. |
| `app_users` | Staff profiles. `auth_user_id` → `auth.users` (linked on first verified sign-in). Role, partner, branch, status, `auth_valid_after` (revocation). `(branch_id, vendor_id)` FK. Unique phone. |
| `customers` | Customer profiles, `auth_user_id` → `auth.users`. Unique phone. |

### Catalogue and pricing
| Table | Notes |
|---|---|
| `brands`, `categories`, `products`, `product_variants`, `product_colors` | Case-insensitive uniqueness as 3.1 (brand name; brand+model; product+storage; product+colour). Variant/colour FKs are composite with `product_id`. |
| `grade_rules` | The grade ladder (score band → fraction of base price). |
| `inspection_rules` | IRL-001..018 deductions/blocking flags. |
| `master_prices`, `vendor_prices` | Effective-dated, half-open window `[from, to)`, superseded not overwritten, cancelled rows never count. |
| `commission_rules` | Partner fee rules, most specific wins (product > category > brand > partner-wide). |

### The transaction
| Table | Key constraints |
|---|---|
| `trade_ins` | Status CHECK (17 statuses from 3.1). **`trade_ins_open_imei_key`**: one open trade-in per IMEI (terminal set CANCELLED/CLOSED/CUSTOMER_DECLINED, as `createTradeIn_`). `operation_id` unique (idempotency). `(branch_id, vendor_id)` FK. `total_settlement = final_customer_value + commission_value`. No voucher and no custody status without `device_received`. `SETTLED` requires `settlement_id`. |
| `trade_in_transitions` | The 28 allowed edges of 3.1 `TRADEIN_FLOW`; a trigger refuses any other (`QM_INVALID_TRANSITION`). |
| `inspections` | One per trade-in (`unique trade_in_id`). |
| `inspection_photos` | One row per evidence photo (replaces `PhotoFileIDs`/`PhotoMeta`): object path, MIME, size, SHA-256, legacy Drive id. |

### Money documents
| Table | Key constraints |
|---|---|
| `vouchers` | **`vouchers_number_key`** unique voucher number. **`vouchers_one_live_per_tradein`**: one `ISSUED` voucher per trade-in. `(trade_in_id, vendor_id)` and `(branch_id, vendor_id)` FKs. Figures immutable once issued (`QM_VOUCHER_IMMUTABLE`); voided is final (`QM_VOUCHER_VOIDED`). Void ↔ reissue linked both ways. |
| `collections`, `collection_items` | Collection notes and their lines. Lines FK `(batch_id, vendor_id)` and `(trade_in_id, vendor_id)` → **an item belongs to its note and its partner**. `collection_items_one_pending`: a device is pending on at most one note. |
| `settlements` | Status flow DRAFT→SUBMITTED→APPROVED→PAID→CLOSED (+CANCELLED) enforced by trigger. Totals CHECK. APPROVED+ requires approver; PAID+ requires payment reference. |
| settlement items | **Not a separate table** (3.1 kept `SettlementID` on the trade-in). `trade_ins (settlement_id, vendor_id)` FK → `settlements (id, vendor_id)`: **an item belongs to its settlement and the same partner**. Only `COLLECTED` trade-ins can be claimed (`QM_NOT_SETTLEABLE`); items cannot leave a SUBMITTED-or-later settlement (`QM_SETTLEMENT_LOCKED`). View `settlement_lines` (security_invoker) lists them. |

### Platform
| Table | Notes |
|---|---|
| `notifications`, `notification_reads` | Audience-scoped notifications; per-principal read rows replace the comma-separated `ReadBy`. |
| `audit_logs` | **Append-only** (update/delete refused by trigger, `QM_AUDIT_APPEND_ONLY`). Actor id/role, partner, branch, action, target, before/after, request id, IP, user agent, timestamp. |
| `settings` | Key/value settings (editable keys whitelisted in code). |
| `idempotency_keys` | Scope hash, request hash, stored response, expiry. |
| `otp_send_log` | Every send attempt (phone, purpose, result). **Never the code.** |
| `otp_verify_attempts` | Verify attempts per phone (reserved before the check, marked on success) for the 3.1 wrong-code limit. Never the code. |
| `id_counters` | Counters behind human-readable IDs. |
| `job_runs`, `reconciliation_issues` | Job visibility (failed jobs are visible rows). |
| `migration_runs`, `migration_checkpoints`, `migration_row_errors`, `legacy_file_map` | Migration bookkeeping. |

## Brief → constraint map

| Requirement | Where |
|---|---|
| Unique voucher number | `vouchers_number_key` |
| Idempotency | `idempotency_keys` + `operation_id` partial unique indexes on trade_ins, vouchers, collections, settlements |
| Valid states | status CHECKs + `trade_in_transitions` trigger + settlement transition trigger |
| Branch belongs to partner | composite FK `(branch_id, vendor_id)` on users, trade-ins, vouchers, collections |
| Settlement items belong to their settlement | composite FK `trade_ins(settlement_id, vendor_id)` + claim trigger |
| One active voucher per trade-in | `vouchers_one_live_per_tradein` |
| Duplicate active IMEI | `trade_ins_open_imei_key` (+ concurrency test) |
| Last SUPER_ADMIN | trigger with advisory lock (`QM_LAST_SUPER_ADMIN`) |

## Decisions to note

- No new business rules were invented. Where 3.1 relied on a script lock or a recovery path for half-finished multi-sheet writes, a transaction + constraint replaces it.
- `parseDayStart('2026-02-30')` is now refused instead of rolling over (an objective bug fix; documented in `PHASE2_CHANGELOG.md`).
