-- =====================================================================
-- supabase/seed/seed.sql — DEVELOPMENT / TEST SEED. OBVIOUSLY FICTIONAL.
--
-- Never run against production. `npm run seed:dev` refuses when
-- APP_ENV=production. Every name below is invented; phone numbers are
-- placeholders in the Qatar mobile format (they must pass the schema
-- check) and are NOT known to belong to anyone — replace them with your
-- own test handsets, and use the TEST SMS provider (or Supabase test
-- phone numbers) so no message reaches a stranger.
--
-- Profiles have no auth_user_id: each is linked to a Supabase Auth user
-- the first time somebody signs in with that phone number.
--
-- Roles: there is NO finance role in 3.1. "Finance" work (create, submit,
-- mark paid) is QM_ADMIN; APPROVING a settlement is SUPER_ADMIN only.
-- The finance user below is therefore a QM_ADMIN.
-- =====================================================================
begin;

insert into public.vendors (id, name, code, default_commission_rate, status, contact_name, settlement_terms, notes) values
  ('VND-001', 'Demo Electronics (fictional)', 'DEMO', 0.050000, 'ACTIVE', 'Demo Contact', 'Monthly, 30 days', 'Seed data — fictional partner.')
on conflict (id) do nothing;

insert into public.branches (id, vendor_id, name, code, address, location, active, display_order) values
  ('BR-0001', 'VND-001', 'Demo Mall Branch (fictional)', 'MALL', 'Unit 1, Demo Mall, Doha', 'Demo Mall', true, 1),
  ('BR-0002', 'VND-001', 'Demo Souq Branch (fictional)', 'SOUQ', 'Shop 2, Demo Souq, Doha', 'Demo Souq', true, 2)
on conflict (id) do nothing;

insert into public.app_users (id, full_name, phone, email, role, vendor_id, branch_id, status, approved_by, approved_at, notes) values
  ('USR-00001', 'Demo Platform Owner',      '+97430000001', null, 'SUPER_ADMIN',    null,      null,      'ACTIVE', 'seed', now(), 'Seed: Qatar Mobile owner / settlement approver.'),
  ('USR-00002', 'Demo Finance Officer',     '+97430000002', null, 'QM_ADMIN',       null,      null,      'ACTIVE', 'seed', now(), 'Seed: finance user (QM_ADMIN — creates, submits and pays settlements).'),
  ('USR-00003', 'Demo Technician',          '+97430000003', null, 'TECHNICIAN',     null,      null,      'ACTIVE', 'seed', now(), 'Seed.'),
  ('USR-00004', 'Demo Partner Admin',       '+97430000004', null, 'VENDOR_ADMIN',   'VND-001', null,      'ACTIVE', 'seed', now(), 'Seed: partner-wide.'),
  ('USR-00005', 'Demo Branch Manager',      '+97430000005', null, 'VENDOR_MANAGER', 'VND-001', 'BR-0001', 'ACTIVE', 'seed', now(), 'Seed: branch-bound to BR-0001.'),
  ('USR-00006', 'Demo Branch Staff (Souq)', '+97430000006', null, 'VENDOR_STAFF',   'VND-001', 'BR-0002', 'ACTIVE', 'seed', now(), 'Seed: branch-bound to BR-0002.')
on conflict (id) do nothing;

insert into public.customers (id, full_name, phone, email, status, notes) values
  ('CUS-00001', 'Demo Customer', '+97430000010', null, 'ACTIVE', 'Seed: fictional customer.')
on conflict (id) do nothing;

-- Catalogue (fictional brand).
insert into public.brands (id, name, slug, active, display_order) values
  ('BRD-001', 'Orbit (fictional)', 'orbit', true, 1)
on conflict (id) do nothing;
insert into public.categories (id, name, slug, active, display_order) values
  ('CAT-001', 'Smartphones', 'smartphones', true, 1),
  ('CAT-002', 'Tablets', 'tablets', true, 2)
on conflict (id) do nothing;
insert into public.products (id, brand_id, category_id, model, device_type, release_year, search_keywords, active, display_order) values
  ('PRD-00001', 'BRD-001', 'CAT-001', 'Orbit One', 'SMARTPHONE', 2025, 'orbit one demo', true, 1),
  ('PRD-00002', 'BRD-001', 'CAT-002', 'Orbit Tab', 'TABLET', 2024, 'orbit tab demo', true, 2)
on conflict (id) do nothing;
insert into public.product_variants (id, product_id, storage, active, display_order) values
  ('VAR-000001', 'PRD-00001', '128GB', true, 9),
  ('VAR-000002', 'PRD-00001', '256GB', true, 17),
  ('VAR-000003', 'PRD-00002', '64GB', true, 5)
on conflict (id) do nothing;
insert into public.product_colors (id, product_id, color, active, display_order) values
  ('CLR-000001', 'PRD-00001', 'Midnight', true, 1),
  ('CLR-000002', 'PRD-00001', 'Silver', true, 2)
on conflict (id) do nothing;

-- Master prices (QAR). VAR-000003 is deliberately unpriced.
insert into public.master_prices (id, product_id, variant_id, base_price, effective_from, active, created_by, notes) values
  ('MPR-000001', 'PRD-00001', 'VAR-000001', 2000.00, '2026-01-01T00:00:00+03:00', true, 'seed', 'Seed price.'),
  ('MPR-000002', 'PRD-00001', 'VAR-000002', 2400.00, '2026-01-01T00:00:00+03:00', true, 'seed', 'Seed price.')
on conflict (id) do nothing;

-- The partner-wide fee rule a new partner gets (seedVendorCommission_).
insert into public.commission_rules (id, vendor_id, commission_type, commission_value, effective_from, active, created_by, notes) values
  ('CMR-00001', 'VND-001', 'PERCENTAGE', 0.050000, '2026-01-01T00:00:00+03:00', true, 'seed', 'Default rate for this vendor.')
on conflict (id) do nothing;

insert into public.settings (key, value, type, section, description) values
  ('platform.contactPhone', '', 'STRING', 'GENERAL', 'Support phone number'),
  ('customer.estimateNote', '', 'STRING', 'CUSTOMER', 'Wording shown under an estimate'),
  ('tradein.trackWindowDays', '30', 'NUMBER', 'OPERATIONS', 'Days a trade-in stays visible to the customer')
on conflict (key) do nothing;

-- Counters continue after the seeded ids.
insert into public.id_counters (scope, last_value) values
  ('VND', 1), ('BR', 2), ('USR', 6), ('CUS', 1), ('BRD', 1), ('CAT', 2), ('PRD', 2), ('VAR', 3), ('CLR', 2), ('MPR', 2), ('CMR', 1)
on conflict (scope) do update set last_value = greatest(public.id_counters.last_value, excluded.last_value);

commit;
