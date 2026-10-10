-- =====================================================================
-- 20261010000200_owner_approval_and_vendor_payment.sql
--
-- Owner decision 2026-10-10: one approval step after the evaluation and a
-- finance step after the voucher.
--
--   technician final pricing   INSPECTION_COMPLETED -> AWAITING_OWNER_APPROVAL
--   owner/admin approves       AWAITING_OWNER_APPROVAL -> FINAL_OFFER_READY
--                              (the offer is released to the customer; this is "OWNER_APPROVED")
--   owner sends back / rejects AWAITING_OWNER_APPROVAL -> INSPECTION_IN_PROGRESS | CANCELLED
--   customer accepts, hands over, Carrefour issues the voucher (unchanged) -> READY_FOR_COLLECTION
--                              ("VOUCHER_CREATED": customer and technician side complete)
--   accountant pays + receipt  READY_FOR_COLLECTION -> PAYMENT_SENT
--   vendor confirms funds      PAYMENT_SENT -> VENDOR_CONFIRMED -> CLOSED
--
-- One accountant transfer may pay several trade-ins of ONE partner: it is a
-- row of public.settlements with kind = 'VENDOR_PAYMENT' (existing table,
-- existing settlement_id link on trade_ins). The older batch settlement
-- (kind = 'BATCH', COLLECTED -> SETTLED -> CLOSED) stays for trade-ins that
-- were never owner-approved; device collection stays as a logistics record
-- and no longer moves an approved trade-in's status.
--
-- New role ACCOUNTANT: platform scope (no partner, no branch), finance only.
-- Additive and forward-only; existing rows are not rewritten.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. The ACCOUNTANT role
-- ---------------------------------------------------------------------
alter table public.app_users drop constraint if exists app_users_role_check;
alter table public.app_users add constraint app_users_role_check
  check (role in ('SUPER_ADMIN','QM_ADMIN','TECHNICIAN','ACCOUNTANT','VENDOR_ADMIN','VENDOR_MANAGER','VENDOR_STAFF'));
alter table public.app_users drop constraint if exists app_users_check1;
alter table public.app_users add constraint app_users_check1
  check (role is null
         or (role in ('VENDOR_ADMIN','VENDOR_MANAGER','VENDOR_STAFF') and vendor_id is not null)
         or (role in ('SUPER_ADMIN','QM_ADMIN','TECHNICIAN','ACCOUNTANT') and vendor_id is null and branch_id is null));

-- ---------------------------------------------------------------------
-- 2. New trade-in statuses and owner-approval / finance columns
-- ---------------------------------------------------------------------
alter table public.trade_ins drop constraint if exists trade_ins_status_check;
alter table public.trade_ins add constraint trade_ins_status_check check (status in (
  'DRAFT','PENDING_TECHNICIAN','INSPECTION_IN_PROGRESS','INSPECTION_COMPLETED','AWAITING_OWNER_APPROVAL',
  'FINAL_OFFER_READY','CUSTOMER_ACCEPTED','CUSTOMER_DECLINED','DEVICE_RECEIVED','AWAITING_VOUCHER','VOUCHER_ISSUED',
  'READY_FOR_COLLECTION','COLLECTED','SETTLED','PAYMENT_SENT','VENDOR_CONFIRMED','CLOSED','RETURN_PENDING',
  'DEVICE_RETURNED','CANCELLED'));

alter table public.trade_ins
  add column if not exists owner_approved_by    text,
  add column if not exists owner_approved_at    timestamptz,
  add column if not exists owner_decision_note  text,
  add column if not exists payment_sent_at      timestamptz,
  add column if not exists vendor_confirmed_by  text,
  add column if not exists vendor_confirmed_at  timestamptz,
  add column if not exists closed_at            timestamptz;

-- Custody states (device in our hands) now include the two finance states.
alter table public.trade_ins drop constraint if exists trade_ins_check2;
alter table public.trade_ins add constraint trade_ins_check2
  check (status not in ('DEVICE_RECEIVED','AWAITING_VOUCHER','VOUCHER_ISSUED','READY_FOR_COLLECTION',
                        'COLLECTED','SETTLED','PAYMENT_SENT','VENDOR_CONFIRMED','RETURN_PENDING') or device_received);
alter table public.trade_ins add constraint trade_ins_owner_approval_pair
  check ((owner_approved_at is null) = (owner_approved_by is null));
alter table public.trade_ins add constraint trade_ins_finance_states
  check (status not in ('PAYMENT_SENT','VENDOR_CONFIRMED')
         or (settlement_id is not null and voucher_id is not null and owner_approved_at is not null and payment_sent_at is not null));
alter table public.trade_ins add constraint trade_ins_vendor_confirmed
  check (status <> 'VENDOR_CONFIRMED' or (vendor_confirmed_at is not null and vendor_confirmed_by is not null));
create index if not exists trade_ins_owner_queue_idx on public.trade_ins (created_at) where status = 'AWAITING_OWNER_APPROVAL';

-- ---------------------------------------------------------------------
-- 3. Transition table: the new edges (and the one edge that is removed:
--    an evaluation can no longer reach the customer without the owner)
-- ---------------------------------------------------------------------
delete from public.trade_in_transitions where from_status = 'INSPECTION_COMPLETED' and to_status = 'FINAL_OFFER_READY';
insert into public.trade_in_transitions (from_status, to_status) values
  ('INSPECTION_COMPLETED','AWAITING_OWNER_APPROVAL'),
  ('AWAITING_OWNER_APPROVAL','FINAL_OFFER_READY'),
  ('AWAITING_OWNER_APPROVAL','INSPECTION_IN_PROGRESS'),
  ('AWAITING_OWNER_APPROVAL','CANCELLED'),
  ('READY_FOR_COLLECTION','PAYMENT_SENT'),
  ('PAYMENT_SENT','VENDOR_CONFIRMED'),
  ('VENDOR_CONFIRMED','CLOSED')
on conflict do nothing;

-- The state machine trigger, with the approval and finance gates.
create or replace function app.enforce_trade_in_transition() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.status is distinct from old.status then
    if not exists (select 1 from public.trade_in_transitions
                    where from_status = old.status and to_status = new.status) then
      raise exception 'invalid trade-in transition % -> %', old.status, new.status
        using errcode = 'P0001', hint = 'QM_INVALID_TRANSITION';
    end if;
    -- Back to (or still before) the owner's decision: an earlier approval no longer stands.
    if new.status in ('INSPECTION_IN_PROGRESS','INSPECTION_COMPLETED','AWAITING_OWNER_APPROVAL') then
      new.owner_approved_at := null;
      new.owner_approved_by := null;
    end if;
    -- The offer reaches the customer only after the owner approved it.
    if new.status = 'FINAL_OFFER_READY' and new.owner_approved_at is null then
      raise exception 'trade-in % has not been approved by the owner', old.id
        using errcode = 'P0001', hint = 'QM_OWNER_APPROVAL_REQUIRED';
    end if;
    -- The older batch settlement is for trade-ins that never went through owner approval.
    if new.status in ('COLLECTED','SETTLED') and new.owner_approved_at is not null then
      raise exception 'trade-in % is paid through the accountant, not a settlement batch', old.id
        using errcode = 'P0001', hint = 'QM_WRONG_PAYMENT_PATH';
    end if;
    if new.status = 'CLOSED' and old.status = 'VENDOR_CONFIRMED' then
      new.closed_at := coalesce(new.closed_at, now());
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

-- ---------------------------------------------------------------------
-- 4. No voucher without the owner's approval (a second line behind the API)
-- ---------------------------------------------------------------------
create or replace function app.enforce_voucher_owner_approval() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  -- Historical rows imported from the 3.1 sheets predate this step (tools/migration sets the flag
  -- for its own transaction only).
  if coalesce(current_setting('qm.legacy_import', true), '') = 'on' then
    return new;
  end if;
  if not exists (select 1 from public.trade_ins where id = new.trade_in_id and owner_approved_at is not null) then
    raise exception 'trade-in % has not been approved by the owner; no voucher can be issued', new.trade_in_id
      using errcode = 'P0001', hint = 'QM_OWNER_APPROVAL_REQUIRED';
  end if;
  return new;
end $$;
drop trigger if exists vouchers_owner_approval on public.vouchers;
create trigger vouchers_owner_approval before insert on public.vouchers
  for each row execute function app.enforce_voucher_owner_approval();

-- ---------------------------------------------------------------------
-- 5. The accountant's transfer = a settlement of kind VENDOR_PAYMENT
-- ---------------------------------------------------------------------
alter table public.settlements
  add column if not exists kind                text not null default 'BATCH',
  add column if not exists paid_by             text,
  add column if not exists vendor_confirmed_by text,
  add column if not exists vendor_confirmed_at timestamptz,
  add column if not exists closed_at           timestamptz;
alter table public.settlements add constraint settlements_kind_check check (kind in ('BATCH','VENDOR_PAYMENT'));
-- A batch settlement still needs the owner's approval before it is paid; a vendor payment
-- was approved trade-in by trade-in by the owner before the voucher existed.
alter table public.settlements drop constraint if exists settlements_check2;
alter table public.settlements add constraint settlements_check2
  check (kind = 'VENDOR_PAYMENT' or status not in ('APPROVED','PAID','CLOSED')
         or (approved_by is not null and approved_at is not null));
alter table public.settlements add constraint settlements_vendor_payment_states
  check (kind <> 'VENDOR_PAYMENT' or (status in ('PAID','CLOSED') and paid_by is not null));
alter table public.settlements add constraint settlements_vendor_payment_confirmed
  check (kind <> 'VENDOR_PAYMENT' or status <> 'CLOSED' or (vendor_confirmed_by is not null and vendor_confirmed_at is not null));

-- A trade-in is claimed by a settlement of its own partner (FK, unchanged) and only on the right path.
create or replace function app.enforce_settlement_claim() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare
  s_status text;
  s_kind   text;
begin
  if old.settlement_id is not null and new.settlement_id is distinct from old.settlement_id then
    select status, kind into s_status, s_kind from public.settlements where id = old.settlement_id;
    if s_kind = 'VENDOR_PAYMENT' or s_status in ('SUBMITTED','APPROVED','PAID','CLOSED') then
      raise exception 'trade-in % belongs to % settlement %', old.id, s_status, old.settlement_id
        using errcode = 'P0001', hint = 'QM_SETTLEMENT_LOCKED';
    end if;
  end if;
  if new.settlement_id is not null and old.settlement_id is distinct from new.settlement_id then
    select kind into s_kind from public.settlements where id = new.settlement_id;
    if s_kind = 'VENDOR_PAYMENT' then
      if old.status <> 'READY_FOR_COLLECTION' or new.status <> 'PAYMENT_SENT'
         or new.voucher_id is null or new.owner_approved_at is null then
        raise exception 'trade-in % cannot be paid: it needs the owner''s approval and a live voucher (it is %)', new.id, old.status
          using errcode = 'P0001', hint = 'QM_NOT_PAYABLE';
      end if;
    elsif new.status <> 'COLLECTED' or new.owner_approved_at is not null then
      raise exception 'only COLLECTED trade-ins outside the approval workflow can be batch-settled (% is %)', new.id, new.status
        using errcode = 'P0001', hint = 'QM_NOT_SETTLEABLE';
    end if;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------
-- 6. Payment receipts: private bucket, one row per stored file
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('payment-receipts', 'payment-receipts', false, 5242880,
        array['application/pdf','image/png','image/jpeg','image/webp','image/heic','image/heif'])
on conflict (id) do update
  set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
-- payment-receipts: no policy for anon/authenticated = no access. Read only through
-- short-lived signed URLs the API issues after its own scope check.

create table if not exists public.payment_receipts (
  id             uuid primary key default gen_random_uuid(),
  settlement_id  text not null,
  vendor_id      text not null references public.vendors(id),
  bucket         text not null default 'payment-receipts' check (bucket = 'payment-receipts'),
  object_path    text not null unique,
  file_name      text,
  mime_type      text not null check (mime_type in ('application/pdf','image/png','image/jpeg','image/webp','image/heic','image/heif')),
  size_bytes     integer not null check (size_bytes > 0 and size_bytes <= 5242880),
  sha256         text not null,
  uploaded_by    text not null,
  uploaded_at    timestamptz not null default now(),
  foreign key (settlement_id, vendor_id) references public.settlements (id, vendor_id)
);
create index if not exists payment_receipts_settlement_idx on public.payment_receipts (settlement_id);
alter table public.payment_receipts enable row level security;
revoke all on public.payment_receipts from anon, authenticated;

-- A receipt is evidence: once the partner confirmed the money, it is kept as it is.
create or replace function app.protect_payment_receipts() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'payment receipts are append-only' using errcode = 'P0001', hint = 'QM_RECEIPT_APPEND_ONLY';
end $$;
drop trigger if exists payment_receipts_append_only on public.payment_receipts;
create trigger payment_receipts_append_only before update or delete on public.payment_receipts
  for each row execute function app.protect_payment_receipts();

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'qm_api') then
    grant select, insert on public.payment_receipts to qm_api;
    grant execute on function app.enforce_voucher_owner_approval() to qm_api;
    grant execute on function app.protect_payment_receipts() to qm_api;
  end if;
end $$;
revoke all on function app.enforce_voucher_owner_approval() from public;
revoke all on function app.protect_payment_receipts() from public;
