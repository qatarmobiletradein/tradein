-- =====================================================================
-- 20261008000300_rls.sql
--
-- Row Level Security — DEFENCE IN DEPTH.
--
-- The application's data path is Browser -> Railway API -> PostgreSQL.
-- Railway connects with a server-side role and performs every
-- authorisation check itself (packages/auth). These policies exist for the
-- case the API layer is bypassed or wrong: a client holding the public anon
-- key, or a signed-in user's JWT, talking to PostgREST directly.
--
-- Principles
--   * RLS is ENABLED on every table. No policy = no rows.
--   * anon and authenticated may NEVER write. Every mutation goes through
--     the API, which runs business rules, transactions and audit.
--   * Reads mirror the 3.1 scope rules (06_RBAC.gs, 06b_Authz.gs):
--       platform admins (SUPER_ADMIN, QM_ADMIN) see everything;
--       technicians see trade-in work (including the customer name and the
--       offer values they work with, as the 3.1 technician screens do), but
--       never the submitted IMEI, partner fees, the customers table,
--       vouchers or finance tables;
--       partner staff see their partner, and only their branch when they
--       are branch-bound (a blank branch on a record is NOT theirs);
--       customers see their own records.
--   * Column grants remove the most sensitive columns from the
--     authenticated role entirely (submitted IMEI, partner fees on
--     customer-visible tables). Those are served only by the API, which
--     shapes each response per audience.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Who is asking — resolved from auth.uid(), never from the request.
-- SECURITY DEFINER so policies can read app_users/customers without
-- granting those tables; search_path pinned.
-- ---------------------------------------------------------------------
create or replace function app.staff_row() returns public.app_users
language sql stable security definer set search_path = public, pg_temp as $$
  select u.* from public.app_users u
   left join public.vendors v on v.id = u.vendor_id
   left join public.branches b on b.id = u.branch_id
   where u.auth_user_id = auth.uid()
     and u.status = 'ACTIVE'
     and u.role is not null
     and (u.vendor_id is null or v.status = 'ACTIVE')
     and (u.branch_id is null or (b.active and b.vendor_id = u.vendor_id))
   limit 1
$$;

create or replace function app.current_role_name() returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((app.staff_row()).role,
                  case when exists (select 1 from public.customers c
                                     where c.auth_user_id = auth.uid() and c.status = 'ACTIVE')
                       then 'CUSTOMER' end)
$$;

create or replace function app.current_customer_id() returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select c.id from public.customers c
   where c.auth_user_id = auth.uid() and c.status = 'ACTIVE'
     and (app.staff_row()).id is null          -- staff identity wins, as identifyPhone_ did
   limit 1
$$;

create or replace function app.current_user_id() returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select (app.staff_row()).id
$$;

create or replace function app.is_platform_admin() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((app.staff_row()).role in ('SUPER_ADMIN','QM_ADMIN'), false)
$$;

create or replace function app.is_technician() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((app.staff_row()).role = 'TECHNICIAN', false)
$$;

create or replace function app.partner_id() returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select case when (app.staff_row()).role in ('VENDOR_ADMIN','VENDOR_MANAGER','VENDOR_STAFF')
              then (app.staff_row()).vendor_id end
$$;

create or replace function app.partner_branch_id() returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select case when (app.staff_row()).role in ('VENDOR_ADMIN','VENDOR_MANAGER','VENDOR_STAFF')
              then (app.staff_row()).branch_id end
$$;

-- "Is this partner-scoped row inside the caller's scope?"
-- A branch-bound user is refused rows with a blank branch (3.1 rule).
create or replace function app.in_partner_scope(p_vendor_id text, p_branch_id text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select app.partner_id() is not null
     and p_vendor_id = app.partner_id()
     and (app.partner_branch_id() is null or p_branch_id = app.partner_branch_id())
$$;

create or replace function app.is_partner_manager() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((app.staff_row()).role in ('VENDOR_ADMIN','VENDOR_MANAGER'), false)
$$;

revoke all on function app.staff_row() from public;
grant usage on schema app to anon, authenticated, service_role;
grant execute on all functions in schema app to anon, authenticated, service_role;
-- ...except the ones that write or are internal: functions are executable by
-- PUBLIC by default, so revoke from PUBLIC explicitly.
revoke execute on function app.next_counter(text, bigint) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Enable RLS everywhere and start from nothing.
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- The service role used by Railway bypasses RLS (Supabase grants it
-- BYPASSRLS). It still needs table privileges.
grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

grant usage on schema public to anon, authenticated;

-- ---------------------------------------------------------------------
-- PUBLIC CATALOGUE — readable before sign-in (apiPublicCatalogTree_,
-- apiPublicVendorContext_). Price-free and commission-free by column grant.
-- ---------------------------------------------------------------------
grant select (id, name, slug, logo_url, active, display_order) on public.brands to anon, authenticated;
create policy brands_public_read on public.brands for select to anon, authenticated using (active);

grant select (id, name, slug, parent_category_id, image_url, icon_url, description, active, display_order)
  on public.categories to anon, authenticated;
create policy categories_public_read on public.categories for select to anon, authenticated using (active);

grant select (id, brand_id, category_id, model, model_code, device_type, release_year, main_image_url,
              search_keywords, active, display_order) on public.products to anon, authenticated;
create policy products_public_read on public.products for select to anon, authenticated using (active);

grant select (id, product_id, storage, active, display_order) on public.product_variants to anon, authenticated;
create policy variants_public_read on public.product_variants for select to anon, authenticated using (active);

grant select (id, product_id, color, image_url, active, display_order) on public.product_colors to anon, authenticated;
create policy colors_public_read on public.product_colors for select to anon, authenticated using (active);

-- Partners: the public view is name, code and logo (publicVendorView_).
grant select (id, name, code, logo_url, status) on public.vendors to anon;
create policy vendors_public_read on public.vendors for select to anon using (status = 'ACTIVE');

-- Signed-in users: administrators see every partner; partner staff see
-- their own partner, including its commercial terms (as in 3.1).
grant select on public.vendors to authenticated;
create policy vendors_staff_read on public.vendors for select to authenticated
  using (app.is_platform_admin() or id = app.partner_id());

grant select (id, vendor_id, name, address, location, contact_phone, active) on public.branches to anon;
create policy branches_public_read on public.branches for select to anon using (active);

grant select on public.branches to authenticated;
create policy branches_staff_read on public.branches for select to authenticated
  using (app.is_platform_admin()
         or (vendor_id = app.partner_id()
             and (app.partner_branch_id() is null or id = app.partner_branch_id())));

-- ---------------------------------------------------------------------
-- PEOPLE
-- ---------------------------------------------------------------------
grant select (id, full_name, phone, email, role, vendor_id, branch_id, status, approved_at,
              last_login_at, created_at, updated_at) on public.app_users to authenticated;
create policy app_users_read on public.app_users for select to authenticated
  using (
    auth_user_id = auth.uid()
    or app.is_platform_admin()
    -- Partner managers: own partner, never platform roles, own branch if bound.
    or (app.is_partner_manager()
        and vendor_id = app.partner_id()
        and coalesce(role, '') not in ('SUPER_ADMIN','QM_ADMIN','TECHNICIAN')
        and (app.partner_branch_id() is null or branch_id = app.partner_branch_id()))
  );

grant select (id, full_name, phone, email, status, last_login_at, created_at, updated_at)
  on public.customers to authenticated;
create policy customers_read on public.customers for select to authenticated
  using (auth_user_id = auth.uid() or app.is_platform_admin());

-- ---------------------------------------------------------------------
-- TRADE-INS. imei, serial_number and the partner-fee columns are not
-- granted to authenticated at all (column list below).
-- ---------------------------------------------------------------------
grant select (id, customer_id, vendor_id, branch_id, product_id, variant_id, color_id,
              brand_snapshot, category_snapshot, model_snapshot, storage_snapshot, color_snapshot,
              customer_name, condition_answers, estimated_grade, estimated_value,
              grade_code, final_customer_value, price_variance, price_variance_pct, currency,
              status, device_received, device_received_at, accepted_at, declined_at,
              collected_at, inspection_id, voucher_id, collection_batch_id, settlement_id,
              technician, created_at, updated_at)
  on public.trade_ins to authenticated;

create policy trade_ins_read on public.trade_ins for select to authenticated
  using (
    app.is_platform_admin()
    or app.is_technician()
    or app.in_partner_scope(vendor_id, branch_id)
    or customer_id = app.current_customer_id()
  );

grant select (id, trade_in_id, technician, started_at, completed_at, imei_match, answers,
              battery_health, activation_lock, condition_score, grade_code, blocked_reason,
              status, created_at, updated_at)
  on public.inspections to authenticated;
create policy inspections_read on public.inspections for select to authenticated
  using (app.is_platform_admin() or app.is_technician());

grant select (id, inspection_id, trade_in_id, category, label, mime_type, size_bytes, uploaded_by, uploaded_at)
  on public.inspection_photos to authenticated;
create policy inspection_photos_read on public.inspection_photos for select to authenticated
  using (app.is_platform_admin() or app.is_technician());

-- ---------------------------------------------------------------------
-- VOUCHERS: customers see their own (without partner fees, by column
-- grant); partner staff by scope; admins all. Technicians: none (3.1).
-- ---------------------------------------------------------------------
grant select (id, trade_in_id, customer_id, vendor_id, branch_id, voucher_number, customer_value,
              currency, issued_at, status, voided_at, replaced_by_voucher_id, replaces_voucher_id)
  on public.vouchers to authenticated;
create policy vouchers_read on public.vouchers for select to authenticated
  using (
    app.is_platform_admin()
    or app.in_partner_scope(vendor_id, branch_id)
    or customer_id = app.current_customer_id()
  );

-- ---------------------------------------------------------------------
-- COLLECTIONS: admins and partner staff in scope. A note for ALL branches
-- (blank branch) is vendor-wide and hidden from branch-bound users.
-- ---------------------------------------------------------------------
grant select on public.collections to authenticated;
create policy collections_read on public.collections for select to authenticated
  using (app.is_platform_admin() or app.in_partner_scope(vendor_id, branch_id));

grant select (id, batch_id, trade_in_id, vendor_id, branch_id, device_snapshot, grade_code,
              customer_value, commission_value, settlement_value, currency, item_status,
              collected_by, collected_at, exception_reason, created_at, updated_at)
  on public.collection_items to authenticated;
create policy collection_items_read on public.collection_items for select to authenticated
  using (app.is_platform_admin() or app.in_partner_scope(vendor_id, branch_id));

-- ---------------------------------------------------------------------
-- SETTLEMENTS (finance). Option A from 3.1: partner-wide staff see their
-- partner's settlements; a branch-bound user only those whose every line
-- is in their branch. Technicians and customers: none.
-- ---------------------------------------------------------------------
create or replace function app.settlement_visible(p_settlement_id text, p_vendor_id text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select app.is_platform_admin()
      or (app.partner_id() is not null and p_vendor_id = app.partner_id()
          and (app.partner_branch_id() is null
               or (exists (select 1 from public.trade_ins t where t.settlement_id = p_settlement_id)
                   and not exists (select 1 from public.trade_ins t
                                    where t.settlement_id = p_settlement_id
                                      and t.branch_id is distinct from app.partner_branch_id()))))
$$;
grant execute on function app.settlement_visible(text, text) to authenticated;

grant select on public.settlements to authenticated;
create policy settlements_read on public.settlements for select to authenticated
  using (app.settlement_visible(id, vendor_id));

-- ---------------------------------------------------------------------
-- NOTIFICATIONS (26_Notifications.gs, visibleNotifications_)
-- ---------------------------------------------------------------------
grant select on public.notifications to authenticated;
create policy notifications_read on public.notifications for select to authenticated
  using (
    case audience_type
      when 'CUSTOMER' then audience_id = app.current_customer_id()
      when 'USER'     then audience_id = app.current_user_id()
      when 'PLATFORM' then app.is_platform_admin() or (app.is_technician() and entity_type = 'TRADEIN')
      when 'VENDOR'   then app.is_platform_admin()
                        or (app.is_technician() and entity_type = 'TRADEIN')
                        or (audience_id = app.partner_id()
                            and (app.partner_branch_id() is null
                                 or branch_id = app.partner_branch_id()))
      else false
    end
  );

grant select on public.notification_reads to authenticated;
create policy notification_reads_own on public.notification_reads for select to authenticated
  using (principal_id = coalesce(app.current_user_id(), app.current_customer_id()));

-- ---------------------------------------------------------------------
-- PRICING AND RULES: administrators only. (Technicians are deliberately
-- NOT given inspection impacts — 15_Inspections.gs.)
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['grade_rules','inspection_rules','master_prices','vendor_prices','commission_rules','settings']
  loop
    execute format('grant select on public.%I to authenticated', t);
    execute format('create policy %I on public.%I for select to authenticated using (app.is_platform_admin())',
                   t || '_admin_read', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- AUDIT: administrators only, read-only.
-- ---------------------------------------------------------------------
grant select on public.audit_logs to authenticated;
create policy audit_logs_admin_read on public.audit_logs for select to authenticated
  using (app.is_platform_admin());

-- Internal tables (idempotency_keys, otp_send_log, id_counters, job_runs,
-- reconciliation_issues, migration_*, legacy_file_map,
-- trade_in_transitions): RLS enabled, no policy, no grant. Invisible.

-- settlement_lines (a security_invoker view over trade_ins) is NOT granted
-- to authenticated: it carries partner-fee columns that role cannot read.
-- Settlement statements are served by the API.
