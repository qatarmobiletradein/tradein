-- =====================================================================
-- 20261008001000_function_search_path.sql
--
-- Supabase security advisor on the real staging project (lint 0011,
-- "function_search_path_mutable"): the trigger and counter functions ran
-- with the caller's search_path. They already name every table with its
-- schema, so nothing changes in behaviour; pinning the path removes the
-- possibility of an object earlier on a caller's path being picked up.
-- (The SECURITY DEFINER helpers in 0300 were already pinned.)
-- =====================================================================

alter function app.enforce_trade_in_transition()   set search_path = pg_catalog, public, pg_temp;
alter function app.enforce_settlement_transition() set search_path = pg_catalog, public, pg_temp;
alter function app.enforce_settlement_claim()      set search_path = pg_catalog, public, pg_temp;
alter function app.protect_last_super_admin()      set search_path = pg_catalog, public, pg_temp;
alter function app.audit_is_append_only()          set search_path = pg_catalog, public, pg_temp;
alter function app.enforce_voucher_rules()         set search_path = pg_catalog, public, pg_temp;
alter function app.touch_updated_at()              set search_path = pg_catalog, public, pg_temp;
alter function app.next_counter(text, bigint)      set search_path = pg_catalog, public, pg_temp;
