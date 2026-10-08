-- =====================================================================
-- 20261008000200_integrity.sql
--
-- Workflow and integrity rules enforced by the database itself, as a
-- second line behind the API. Each one is a rule the 3.1 Apps Script code
-- already enforced; none is new business logic.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Trade-in state machine (00_Config.gs, TRADEIN_FLOW)
-- ---------------------------------------------------------------------
create table public.trade_in_transitions (
  from_status text not null,
  to_status   text not null,
  primary key (from_status, to_status)
);

insert into public.trade_in_transitions (from_status, to_status) values
  ('DRAFT','PENDING_TECHNICIAN'), ('DRAFT','CANCELLED'),
  ('PENDING_TECHNICIAN','INSPECTION_IN_PROGRESS'), ('PENDING_TECHNICIAN','CANCELLED'),
  ('INSPECTION_IN_PROGRESS','INSPECTION_COMPLETED'), ('INSPECTION_IN_PROGRESS','CANCELLED'),
  ('INSPECTION_COMPLETED','FINAL_OFFER_READY'), ('INSPECTION_COMPLETED','INSPECTION_IN_PROGRESS'),
  ('INSPECTION_COMPLETED','CANCELLED'),
  ('FINAL_OFFER_READY','CUSTOMER_ACCEPTED'), ('FINAL_OFFER_READY','CUSTOMER_DECLINED'),
  ('FINAL_OFFER_READY','INSPECTION_IN_PROGRESS'),
  ('CUSTOMER_ACCEPTED','DEVICE_RECEIVED'), ('CUSTOMER_ACCEPTED','CANCELLED'),
  ('CUSTOMER_DECLINED','CLOSED'),
  ('DEVICE_RECEIVED','AWAITING_VOUCHER'), ('DEVICE_RECEIVED','VOUCHER_ISSUED'),
  ('DEVICE_RECEIVED','RETURN_PENDING'),
  ('AWAITING_VOUCHER','VOUCHER_ISSUED'), ('AWAITING_VOUCHER','RETURN_PENDING'),
  ('VOUCHER_ISSUED','READY_FOR_COLLECTION'), ('VOUCHER_ISSUED','AWAITING_VOUCHER'),
  ('READY_FOR_COLLECTION','COLLECTED'), ('READY_FOR_COLLECTION','AWAITING_VOUCHER'),
  ('COLLECTED','SETTLED'),
  ('SETTLED','CLOSED'),
  ('RETURN_PENDING','DEVICE_RETURNED'),
  ('DEVICE_RETURNED','CANCELLED');

create or replace function app.enforce_trade_in_transition() returns trigger
language plpgsql as $$
begin
  if new.status is distinct from old.status then
    if not exists (select 1 from public.trade_in_transitions
                    where from_status = old.status and to_status = new.status) then
      raise exception 'invalid trade-in transition % -> %', old.status, new.status
        using errcode = 'P0001', hint = 'QM_INVALID_TRANSITION';
    end if;
  end if;
  -- Money is frozen once a voucher exists or the device is collected.
  if old.voucher_id is not null and new.voucher_id is not distinct from old.voucher_id and (
       new.final_customer_value is distinct from old.final_customer_value or
       new.commission_value     is distinct from old.commission_value or
       new.total_settlement     is distinct from old.total_settlement) then
    raise exception 'trade-in % has a live voucher; its value cannot change', old.id
      using errcode = 'P0001', hint = 'QM_VALUE_FROZEN';
  end if;
  new.updated_at := now();
  return new;
end $$;

create trigger trade_ins_transition
  before update on public.trade_ins
  for each row execute function app.enforce_trade_in_transition();

-- ---------------------------------------------------------------------
-- 2. Settlement state machine (18_Settlements.gs, SETTLEMENT_FLOW)
-- ---------------------------------------------------------------------
create or replace function app.enforce_settlement_transition() returns trigger
language plpgsql as $$
declare
  ok boolean;
begin
  if new.status is distinct from old.status then
    ok := (old.status, new.status) in (
      ('DRAFT','SUBMITTED'), ('DRAFT','CANCELLED'),
      ('SUBMITTED','APPROVED'), ('SUBMITTED','DRAFT'),
      ('APPROVED','PAID'),
      ('PAID','CLOSED'));
    if not ok then
      raise exception 'invalid settlement transition % -> %', old.status, new.status
        using errcode = 'P0001', hint = 'QM_INVALID_TRANSITION';
    end if;
  end if;
  -- Approved, paid and closed settlements are financially frozen.
  if old.status in ('APPROVED','PAID','CLOSED') and (
       new.settlement_total     is distinct from old.settlement_total or
       new.customer_value_total is distinct from old.customer_value_total or
       new.commission_total     is distinct from old.commission_total or
       new.trade_in_count       is distinct from old.trade_in_count or
       new.vendor_id            is distinct from old.vendor_id) then
    raise exception 'settlement % is locked', old.id using errcode = 'P0001', hint = 'QM_SETTLEMENT_LOCKED';
  end if;
  new.updated_at := now();
  return new;
end $$;

create trigger settlements_transition
  before update on public.settlements
  for each row execute function app.enforce_settlement_transition();

-- A trade-in cannot leave a settlement that is approved or later.
create or replace function app.enforce_settlement_claim() returns trigger
language plpgsql as $$
declare
  s_status text;
begin
  if old.settlement_id is not null and new.settlement_id is distinct from old.settlement_id then
    select status into s_status from public.settlements where id = old.settlement_id;
    if s_status in ('SUBMITTED','APPROVED','PAID','CLOSED') then
      raise exception 'trade-in % belongs to % settlement %', old.id, s_status, old.settlement_id
        using errcode = 'P0001', hint = 'QM_SETTLEMENT_LOCKED';
    end if;
  end if;
  if new.settlement_id is not null and old.settlement_id is distinct from new.settlement_id
     and new.status <> 'COLLECTED' then
    raise exception 'only COLLECTED trade-ins can be settled (% is %)', new.id, new.status
      using errcode = 'P0001', hint = 'QM_NOT_SETTLEABLE';
  end if;
  return new;
end $$;

create trigger trade_ins_settlement_claim
  before update of settlement_id on public.trade_ins
  for each row execute function app.enforce_settlement_claim();

-- ---------------------------------------------------------------------
-- 3. The last active SUPER_ADMIN (06_RBAC.gs, assertNotLastSuperAdmin_)
--
-- An advisory lock serialises every change to a super-admin row, so two
-- owners demoting each other at the same moment cannot both succeed: the
-- second re-checks after the first has committed.
-- ---------------------------------------------------------------------
create or replace function app.protect_last_super_admin() returns trigger
language plpgsql as $$
begin
  if (old.role = 'SUPER_ADMIN' and old.status = 'ACTIVE') and
     (tg_op = 'DELETE' or new.role is distinct from 'SUPER_ADMIN' or new.status <> 'ACTIVE') then
    perform pg_advisory_xact_lock(hashtext('qm.super_admin'));
    if not exists (select 1 from public.app_users
                    where role = 'SUPER_ADMIN' and status = 'ACTIVE'
                      and id <> old.id) then
      raise exception 'This is the last active super administrator.'
        using errcode = 'P0001', hint = 'QM_LAST_SUPER_ADMIN';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

create trigger app_users_last_super_admin
  after update or delete on public.app_users
  for each row execute function app.protect_last_super_admin();

-- ---------------------------------------------------------------------
-- 4. Append-only audit trail (20_Audit.gs: "IT IS APPEND-ONLY")
-- ---------------------------------------------------------------------
create or replace function app.audit_is_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'audit_logs is append-only' using errcode = 'P0001', hint = 'QM_AUDIT_APPEND_ONLY';
end $$;

create trigger audit_logs_no_update before update or delete on public.audit_logs
  for each row execute function app.audit_is_append_only();
create trigger audit_logs_no_truncate before truncate on public.audit_logs
  for each statement execute function app.audit_is_append_only();

-- ---------------------------------------------------------------------
-- 5. Vouchers: once voided, a voucher stays voided and its money is fixed.
-- ---------------------------------------------------------------------
create or replace function app.enforce_voucher_rules() returns trigger
language plpgsql as $$
begin
  if old.status = 'VOIDED' and new.status <> 'VOIDED' then
    raise exception 'voucher % is voided', old.id using errcode = 'P0001', hint = 'QM_VOUCHER_VOIDED';
  end if;
  if new.customer_value is distinct from old.customer_value or
     new.commission_value is distinct from old.commission_value or
     new.total_settlement is distinct from old.total_settlement or
     new.voucher_number is distinct from old.voucher_number or
     new.trade_in_id is distinct from old.trade_in_id then
    raise exception 'voucher % is a printed document; its figures cannot change', old.id
      using errcode = 'P0001', hint = 'QM_VOUCHER_IMMUTABLE';
  end if;
  return new;
end $$;

create trigger vouchers_rules before update on public.vouchers
  for each row execute function app.enforce_voucher_rules();

-- ---------------------------------------------------------------------
-- 6. updated_at maintenance for the remaining mutable tables
-- ---------------------------------------------------------------------
create or replace function app.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['vendors','branches','app_users','customers','brands','categories',
                           'products','product_variants','product_colors','grade_rules',
                           'inspection_rules','master_prices','vendor_prices','commission_rules',
                           'inspections','collection_items']
  loop
    execute format('create trigger %I before update on public.%I
                    for each row execute function app.touch_updated_at()', t || '_touch', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 7. Counters for human-readable ids. Called inside the caller's
--    transaction: the row lock serialises concurrent callers, and a
--    rolled-back transaction gives its number back.
-- ---------------------------------------------------------------------
create or replace function app.next_counter(p_scope text, p_floor bigint default 0)
returns bigint language plpgsql as $$
declare v bigint;
begin
  insert into public.id_counters (scope, last_value) values (p_scope, greatest(p_floor, 0) + 1)
  on conflict (scope) do update
    set last_value = greatest(public.id_counters.last_value, p_floor) + 1
  returning last_value into v;
  return v;
end $$;
