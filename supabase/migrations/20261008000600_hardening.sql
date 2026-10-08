-- =====================================================================
-- 20261008000600_hardening.sql
--
-- Findings of the independent Phase 2 review:
--   1. OTP verification attempts (3.1 CFG.OTP.MAX_ATTEMPTS, 04_Auth.gs):
--      wrong codes since the last code was SENT are counted per number;
--      at the limit the number must request a new code. Supabase Auth
--      verifies the code itself, so the API keeps this count.
--   2. RLS was wider than the API for partner staff on finance tables and
--      partner commercial fields. Narrowed to mirror the API exactly.
-- =====================================================================

create table public.otp_verify_attempts (
  id          bigint generated always as identity primary key,
  phone       text not null,
  -- A row is reserved BEFORE the code is checked (so concurrent guesses
  -- all count) and marked succeeded only when the code was right.
  succeeded   boolean not null default false,
  created_at  timestamptz not null default now()
);
create index otp_verify_attempts_phone_idx on public.otp_verify_attempts (phone, created_at desc);
alter table public.otp_verify_attempts enable row level security;
revoke all on public.otp_verify_attempts from anon, authenticated;
grant all on public.otp_verify_attempts to service_role;
grant usage, select on all sequences in schema public to service_role;

-- ---------------------------------------------------------------------
-- Partners: signed-in partner staff get the same public columns plus
-- contacts; commercial terms, notes and the fee rate are API-only
-- (admin.vendors is platform-admin only).
-- ---------------------------------------------------------------------
revoke select on public.vendors from authenticated;
grant select (id, name, code, logo_url, status, contact_name, contact_phone, contact_email, created_at, updated_at)
  on public.vendors to authenticated;

-- ---------------------------------------------------------------------
-- Collection notes: the API exposes them to platform admins only
-- (admin.collections). RLS now matches.
-- ---------------------------------------------------------------------
drop policy if exists collections_read on public.collections;
create policy collections_read on public.collections for select to authenticated
  using (app.is_platform_admin());

drop policy if exists collection_items_read on public.collection_items;
create policy collection_items_read on public.collection_items for select to authenticated
  using (app.is_platform_admin());

-- ---------------------------------------------------------------------
-- Settlements: the API allows partner ADMINS and MANAGERS
-- (vendor.settlements), not VENDOR_STAFF, under policy A.
-- ---------------------------------------------------------------------
drop policy if exists settlements_read on public.settlements;
create policy settlements_read on public.settlements for select to authenticated
  using (app.is_platform_admin()
         or (app.is_partner_manager() and app.settlement_visible(id, vendor_id)));
