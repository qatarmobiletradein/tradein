-- =====================================================================
-- supabase/seed/staging_extra.sql — STAGING SEED (applied after seed.sql)
-- by `npm run seed:staging`. OBVIOUSLY FICTIONAL. NO REAL CUSTOMER DATA.
--
-- Adds what the staging verification needs beyond the base seed:
--   a SECOND partner with its own branch (cross-partner denial tests),
--   a second QM_ADMIN (operations; USR-00002 stays the finance user),
--   branch staff in BR-0001 (same-branch staff vs manager checks),
--   a second partner admin, and a second customer (cross-customer tests).
--
-- Phone numbers here are placeholders (they satisfy the schema check and
-- are not known to belong to anyone). Real SMS cannot reach them: map the
-- profiles you want to sign in with to YOUR testers' handsets with
--   npm run seed:staging -- --testers staging-testers.json
-- (that file is git-ignored; see staging-testers.example.json).
-- =====================================================================
begin;

insert into public.vendors (id, name, code, default_commission_rate, status, contact_name, settlement_terms, notes) values
  ('VND-002', 'Second Demo Partner (fictional)', 'DEMB', 0.040000, 'ACTIVE', 'Demo Contact B', 'Monthly, 30 days', 'Staging seed — fictional partner for cross-partner tests.')
on conflict (id) do nothing;

insert into public.branches (id, vendor_id, name, code, address, location, active, display_order) values
  ('BR-0003', 'VND-002', 'Second Partner Branch (fictional)', 'BMAIN', 'Unit 3, Demo Plaza, Doha', 'Demo Plaza', true, 1)
on conflict (id) do nothing;

insert into public.app_users (id, full_name, phone, email, role, vendor_id, branch_id, status, approved_by, approved_at, notes) values
  ('USR-00007', 'Demo QM Operations Admin', '+97430000007', null, 'QM_ADMIN',     null,      null,      'ACTIVE', 'seed', now(), 'Staging seed: second Qatar Mobile admin (operations).'),
  ('USR-00008', 'Demo Branch Staff (Mall)', '+97430000008', null, 'VENDOR_STAFF', 'VND-001', 'BR-0001', 'ACTIVE', 'seed', now(), 'Staging seed: branch-bound to BR-0001.'),
  ('USR-00009', 'Second Partner Admin',     '+97430000009', null, 'VENDOR_ADMIN', 'VND-002', null,      'ACTIVE', 'seed', now(), 'Staging seed: partner-wide admin of VND-002.')
on conflict (id) do nothing;

-- Staff sign in with email + password in staging: every seeded staff profile gets a
-- FICTIONAL address on the reserved .test domain (never deliverable). Map the profiles
-- your testers use to their real work addresses with seed:staging --testers.
update public.app_users set email = lower(id) || '@staff.example.test'
 where id in ('USR-00001','USR-00002','USR-00003','USR-00004','USR-00005','USR-00006','USR-00007','USR-00008','USR-00009')
   and email is null;

insert into public.customers (id, full_name, phone, email, status, notes) values
  ('CUS-00002', 'Second Demo Customer', '+97430000011', null, 'ACTIVE', 'Staging seed: fictional customer for cross-customer tests.')
on conflict (id) do nothing;

insert into public.commission_rules (id, vendor_id, commission_type, commission_value, effective_from, active, created_by, notes) values
  ('CMR-00002', 'VND-002', 'PERCENTAGE', 0.040000, '2026-01-01T00:00:00+03:00', true, 'seed', 'Default rate for this vendor.')
on conflict (id) do nothing;

-- Marks this database as fictional staging data (checked before any re-seed).
insert into public.settings (key, value, type, section, description) values
  ('environment.marker', 'STAGING-FICTIONAL', 'STRING', 'SYSTEM', 'Staging database seeded with fictional data only')
on conflict (key) do nothing;

insert into public.id_counters (scope, last_value) values
  ('VND', 2), ('BR', 3), ('USR', 9), ('CUS', 2), ('CMR', 2)
on conflict (scope) do update set last_value = greatest(public.id_counters.last_value, excluded.last_value);

commit;
