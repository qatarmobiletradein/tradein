-- =====================================================================
-- 20261008000100_core_schema.sql
--
-- Qatar Mobile Multi-Vendor Trade-In — relational schema.
--
-- Translated from the Google Sheets model of release 3.1 (00_Config.gs,
-- SCHEMA). Every legacy identifier is kept as the primary key (USR-00001,
-- TI-CAR-000001, STL-00001 ...) so a migrated record keeps the number that
-- is printed on vouchers, collection notes and invoices.
--
-- Money is numeric(12,2). Rates and percentages are numeric with enough
-- scale for what the admin screens accept. No floating point anywhere.
--
-- Rules that the Apps Script code enforced with a script lock are enforced
-- here with keys, CHECK constraints, partial unique indexes and triggers
-- (see 20261008000200_integrity.sql). The API still checks them first so a
-- person gets a sentence rather than a constraint name.
--
-- Requires (provided by Supabase; provided by tests/sql/00_supabase_shim.sql
-- in local tests): schema auth with auth.users and auth.uid(); roles anon,
-- authenticated, service_role.
-- =====================================================================

create extension if not exists pgcrypto;

create schema if not exists app;          -- private helpers, not exposed

-- ---------------------------------------------------------------------
-- Vocabulary (CHECK lists come from 00_Config.gs)
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- Partners (legacy: Vendors) and branches
-- ---------------------------------------------------------------------
create table public.vendors (
  id                        text primary key check (id ~ '^VND-[0-9]{3,}$'),
  name                      text not null check (length(btrim(name)) >= 2),
  code                      text not null check (code ~ '^[A-Z0-9]{2,6}$'),
  logo_url                  text,
  default_commission_rate   numeric(7,6) not null default 0.05
                              check (default_commission_rate >= 0 and default_commission_rate <= 1),
  status                    text not null default 'ACTIVE' check (status in ('ACTIVE','INACTIVE')),
  contact_name              text,
  contact_phone             text,
  contact_email             text,
  settlement_terms          text,
  notes                     text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);
create unique index vendors_code_key on public.vendors (upper(code));

create table public.branches (
  id              text primary key check (id ~ '^BR-[0-9]{4,}$'),
  vendor_id       text not null references public.vendors(id),
  name            text not null check (length(btrim(name)) >= 2),
  code            text,
  address         text,
  location        text,
  contact_phone   text,
  active          boolean not null default true,
  display_order   integer not null default 99,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- Target of composite foreign keys: "this branch belongs to that partner".
  unique (id, vendor_id)
);
create index branches_vendor_idx on public.branches (vendor_id);

-- ---------------------------------------------------------------------
-- People
--
-- auth_user_id links a profile to Supabase Auth. It is NULL for a profile
-- imported from Google Sheets until that person first signs in with the
-- phone number on the profile (see packages/auth/src/principal.ts).
-- ---------------------------------------------------------------------
create table public.app_users (
  id                text primary key check (id ~ '^USR-[0-9]{5,}$'),
  auth_user_id      uuid unique references auth.users(id) on delete set null,
  full_name         text not null check (length(btrim(full_name)) >= 2),
  phone             text not null check (phone ~ '^\+974[3567][0-9]{7}$'),
  email             text,
  role              text check (role in ('SUPER_ADMIN','QM_ADMIN','TECHNICIAN',
                                         'VENDOR_ADMIN','VENDOR_MANAGER','VENDOR_STAFF')),
  vendor_id         text references public.vendors(id),
  branch_id         text,
  status            text not null default 'PENDING_APPROVAL'
                      check (status in ('PENDING_APPROVAL','ACTIVE','DISABLED','REJECTED')),
  approved_by       text,
  approved_at       timestamptz,
  last_login_at     timestamptz,
  -- Tokens issued before this instant are refused (session revocation).
  auth_valid_after  timestamptz not null default '-infinity',
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- A branch is only meaningful inside its own partner.
  foreign key (branch_id, vendor_id) references public.branches (id, vendor_id),
  -- An active account has a role (pending applicants do not, yet).
  check (status <> 'ACTIVE' or role is not null),
  -- Partner roles carry a partner; platform roles carry neither partner nor branch.
  check (role is null
         or (role in ('VENDOR_ADMIN','VENDOR_MANAGER','VENDOR_STAFF') and vendor_id is not null)
         or (role in ('SUPER_ADMIN','QM_ADMIN','TECHNICIAN') and vendor_id is null and branch_id is null)),
  check (branch_id is null or vendor_id is not null)
);
create unique index app_users_phone_key on public.app_users (phone);
create index app_users_vendor_idx on public.app_users (vendor_id, branch_id);

create table public.customers (
  id              text primary key check (id ~ '^CUS-[0-9]{5,}$'),
  auth_user_id    uuid unique references auth.users(id) on delete set null,
  full_name       text not null check (length(btrim(full_name)) >= 2),
  phone           text not null check (phone ~ '^\+974[3567][0-9]{7}$'),
  email           text,
  status          text not null default 'ACTIVE' check (status in ('ACTIVE','DISABLED')),
  last_login_at   timestamptz,
  auth_valid_after timestamptz not null default '-infinity',
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index customers_phone_key on public.customers (phone);

-- ---------------------------------------------------------------------
-- Catalogue
-- ---------------------------------------------------------------------
create table public.brands (
  id             text primary key check (id ~ '^BRD-[0-9]{3,}$'),
  name           text not null check (length(btrim(name)) >= 2),
  slug           text,
  logo_url       text,
  active         boolean not null default true,
  display_order  integer not null default 99,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create unique index brands_name_key on public.brands (lower(btrim(name)));

create table public.categories (
  id                  text primary key check (id ~ '^CAT-[0-9]{3,}$'),
  name                text not null check (length(btrim(name)) >= 2),
  slug                text,
  parent_category_id  text references public.categories(id),
  image_url           text,
  icon_url            text,
  description         text,
  active              boolean not null default true,
  display_order       integer not null default 99,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check (parent_category_id is null or parent_category_id <> id)
);

create table public.products (
  id               text primary key check (id ~ '^PRD-[0-9]{5,}$'),
  brand_id         text not null references public.brands(id),
  category_id      text references public.categories(id),
  model            text not null check (length(btrim(model)) >= 2),
  model_code       text,
  device_type      text check (device_type in ('SMARTPHONE','TABLET','WATCH','LAPTOP','AUDIO','OTHER')),
  release_year     integer check (release_year between 1990 and 2100),
  main_image_url   text,
  search_keywords  text,
  active           boolean not null default true,
  display_order    integer not null default 99,
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create unique index products_brand_model_key on public.products (brand_id, lower(btrim(model)));

create table public.product_variants (
  id             text primary key check (id ~ '^VAR-[0-9]{6,}$'),
  product_id     text not null references public.products(id),
  storage        text not null check (length(storage) >= 1),
  active         boolean not null default true,
  display_order  integer not null default 99,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (id, product_id)
);
create unique index product_variants_storage_key on public.product_variants (product_id, lower(storage));

create table public.product_colors (
  id             text primary key check (id ~ '^CLR-[0-9]{6,}$'),
  product_id     text not null references public.products(id),
  color          text not null check (length(btrim(color)) >= 1),
  image_url      text,
  active         boolean not null default true,
  display_order  integer not null default 99,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (id, product_id)
);
create unique index product_colors_color_key on public.product_colors (product_id, lower(btrim(color)));

-- ---------------------------------------------------------------------
-- Pricing configuration
-- ---------------------------------------------------------------------
create table public.grade_rules (
  id                  text primary key check (id ~ '^GRD-[0-9]{3,}$'),
  grade_code          text not null unique check (grade_code ~ '^[A-Z][A-Z0-9]{0,3}$'),
  grade_name          text not null,
  percentage_of_base  numeric(5,4) not null check (percentage_of_base >= 0 and percentage_of_base <= 1),
  min_score           numeric(5,2) not null check (min_score >= 0 and min_score <= 100),
  display_order       integer not null default 99,
  is_terminal         boolean not null default false,
  active              boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check (not is_terminal or percentage_of_base = 0)
);

create table public.inspection_rules (
  id             text primary key check (id ~ '^IRL-[0-9]{3,}$'),
  code           text not null unique check (code ~ '^[A-Z][A-Z0-9_]*$'),
  group_name     text not null default '',
  question       text not null,
  input_type     text not null default 'SWITCH' check (input_type in ('SWITCH','PERCENTAGE','LOCK')),
  good_label     text not null default '',
  bad_label      text not null default '',
  score_impact   numeric(5,2) not null check (score_impact >= 0 and score_impact <= 100),
  is_blocking    boolean not null default false,
  display_order  integer not null default 99,
  active         boolean not null default true,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- EffectiveTo ENDS a price; active=false means the row was CANCELLED and
-- never counted (10_Pricing.gs). The window is [effective_from, effective_to).
create table public.master_prices (
  id              text primary key check (id ~ '^MPR-[0-9]{6,}$'),
  product_id      text not null references public.products(id),
  variant_id      text not null,
  base_price      numeric(12,2) not null check (base_price >= 0),
  currency        char(3) not null default 'QAR',
  effective_from  timestamptz not null,
  effective_to    timestamptz,
  active          boolean not null default true,
  superseded_by   text references public.master_prices(id),
  created_by      text,
  updated_by      text,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  foreign key (variant_id, product_id) references public.product_variants (id, product_id),
  check (effective_to is null or effective_to >= effective_from)
);
create index master_prices_lookup on public.master_prices (variant_id, effective_from desc) where active;

create table public.vendor_prices (
  id              text primary key check (id ~ '^VPR-[0-9]{6,}$'),
  vendor_id       text not null references public.vendors(id),
  product_id      text not null references public.products(id),
  variant_id      text not null,
  base_price      numeric(12,2) not null check (base_price >= 0),
  currency        char(3) not null default 'QAR',
  effective_from  timestamptz not null,
  effective_to    timestamptz,
  active          boolean not null default true,
  superseded_by   text references public.vendor_prices(id),
  created_by      text,
  updated_by      text,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  foreign key (variant_id, product_id) references public.product_variants (id, product_id),
  check (effective_to is null or effective_to >= effective_from)
);
create index vendor_prices_lookup on public.vendor_prices (vendor_id, variant_id, effective_from desc) where active;

-- Partner fee ("commission") rules, most specific wins (12_CommissionRules.gs).
create table public.commission_rules (
  id                text primary key check (id ~ '^CMR-[0-9]{5,}$'),
  vendor_id         text not null references public.vendors(id),
  brand_id          text references public.brands(id),
  category_id       text references public.categories(id),
  product_id        text references public.products(id),
  commission_type   text not null default 'PERCENTAGE' check (commission_type in ('PERCENTAGE','FIXED')),
  commission_value  numeric(12,6) not null check (commission_value >= 0),
  effective_from    timestamptz not null,
  effective_to      timestamptz,
  active            boolean not null default true,
  superseded_by     text references public.commission_rules(id),
  created_by        text,
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (commission_type <> 'PERCENTAGE' or commission_value <= 1),
  check (effective_to is null or effective_to >= effective_from)
);
create index commission_rules_lookup on public.commission_rules (vendor_id, effective_from desc) where active;

-- ---------------------------------------------------------------------
-- The transaction
-- ---------------------------------------------------------------------
create table public.trade_ins (
  id                          text primary key check (id ~ '^TI-[A-Z0-9]{2,6}-[0-9]{6,}$'),
  customer_id                 text not null references public.customers(id),
  vendor_id                   text not null references public.vendors(id),
  branch_id                   text not null,
  product_id                  text not null references public.products(id),
  variant_id                  text not null,
  color_id                    text,

  brand_snapshot              text,
  category_snapshot           text,
  model_snapshot              text,
  storage_snapshot            text,
  color_snapshot              text,

  -- Digits only. Written once by the customer; compared, never shown to a
  -- technician (15_Inspections.gs).
  imei                        text check (imei is null or imei ~ '^[0-9]{15}$'),
  serial_number               text,
  customer_name               text,
  customer_phone              text,

  condition_answers           jsonb not null default '{}'::jsonb,
  estimated_score             numeric(5,2),
  estimated_grade             text,
  estimated_value             numeric(12,2) check (estimated_value is null or estimated_value >= 0),

  -- Frozen at the final offer (14_TradeIns.gs, submitFinalOffer_).
  base_price_snapshot         numeric(12,2),
  price_effective_date        timestamptz,
  pricing_source              text check (pricing_source in ('VENDOR_OVERRIDE','MASTER','NONE')),
  pricing_rule_id             text,
  condition_score             numeric(5,2),
  grade_code                  text,
  grade_percentage_snapshot   numeric(5,4),
  calculated_grade_value      numeric(12,2),
  grade_override_from         text,
  grade_override_to           text,
  grade_override_reason       text,
  grade_override_by           text,
  grade_override_at           timestamptz,
  manual_adjustment           numeric(12,2) not null default 0,
  manual_adjustment_reason    text,
  manual_adjustment_by        text,
  final_customer_value        numeric(12,2) check (final_customer_value is null or final_customer_value >= 0),
  price_variance              numeric(12,2),
  price_variance_pct          numeric(9,2),
  commission_rule_id          text,
  commission_type_snapshot    text check (commission_type_snapshot in ('PERCENTAGE','FIXED')),
  commission_rate_snapshot    numeric(12,6),
  commission_value            numeric(12,2) check (commission_value is null or commission_value >= 0),
  total_settlement            numeric(12,2),
  currency                    char(3) not null default 'QAR',

  status                      text not null check (status in (
                                'DRAFT','PENDING_TECHNICIAN','INSPECTION_IN_PROGRESS','INSPECTION_COMPLETED',
                                'FINAL_OFFER_READY','CUSTOMER_ACCEPTED','CUSTOMER_DECLINED','DEVICE_RECEIVED',
                                'AWAITING_VOUCHER','VOUCHER_ISSUED','READY_FOR_COLLECTION','COLLECTED','SETTLED',
                                'CLOSED','RETURN_PENDING','DEVICE_RETURNED','CANCELLED')),
  device_received             boolean not null default false,
  device_received_by          text,
  device_received_at          timestamptz,
  device_returned_by          text,
  device_returned_at          timestamptz,
  return_reason               text,
  collected_at                timestamptz,
  collected_by                text,

  inspection_id               text,
  voucher_id                  text,
  collection_batch_id         text,
  settlement_id               text,
  technician                  text,
  accepted_at                 timestamptz,
  declined_at                 timestamptz,
  decline_reason              text,
  legacy_drive_folder_id      text,
  notes                       text,
  operation_id                text,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),

  unique (id, vendor_id),
  foreign key (branch_id, vendor_id)  references public.branches (id, vendor_id),
  foreign key (variant_id, product_id) references public.product_variants (id, product_id),
  foreign key (color_id, product_id)  references public.product_colors (id, product_id),

  -- Settlement = customer value + partner fee, whenever both are known.
  check (final_customer_value is null or commission_value is null or total_settlement is null
         or total_settlement = final_customer_value + commission_value),
  -- No voucher, and no custody state, without the device in our hands.
  check (voucher_id is null or device_received),
  check (status not in ('DEVICE_RECEIVED','AWAITING_VOUCHER','VOUCHER_ISSUED','READY_FOR_COLLECTION',
                        'COLLECTED','SETTLED','RETURN_PENDING') or device_received),
  check (status <> 'SETTLED' or settlement_id is not null)
);
create index trade_ins_customer_idx   on public.trade_ins (customer_id, created_at desc);
create index trade_ins_vendor_idx     on public.trade_ins (vendor_id, branch_id, status);
create index trade_ins_status_idx     on public.trade_ins (status, created_at desc);
create index trade_ins_settlement_idx on public.trade_ins (settlement_id) where settlement_id is not null;
create index trade_ins_batch_idx      on public.trade_ins (collection_batch_id) where collection_batch_id is not null;
create unique index trade_ins_operation_key on public.trade_ins (operation_id) where operation_id is not null;

-- ONE OPEN TRADE-IN PER DEVICE. The same terminal set createTradeIn_ uses.
create unique index trade_ins_open_imei_key on public.trade_ins (imei)
  where imei is not null and status not in ('CANCELLED','CLOSED','CUSTOMER_DECLINED');

create table public.inspections (
  id               text primary key check (id ~ '^INS-[0-9]{6,}$'),
  trade_in_id      text not null unique references public.trade_ins(id),
  technician       text,
  started_at       timestamptz,
  completed_at     timestamptz,
  scanned_imei     text check (scanned_imei is null or scanned_imei ~ '^[0-9]{15}$'),
  imei_match       boolean not null default false,
  answers          jsonb not null default '{}'::jsonb,
  battery_health   integer check (battery_health between 0 and 100),
  activation_lock  boolean not null default false,
  condition_score  numeric(5,2),
  grade_code       text,
  blocked_reason   text,
  rules_version    text,
  technician_notes text,
  status           text not null default 'IN_PROGRESS' check (status in ('IN_PROGRESS','COMPLETED')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
alter table public.trade_ins
  add constraint trade_ins_inspection_fk foreign key (inspection_id)
  references public.inspections(id) deferrable initially deferred;

-- Replaces PhotoFileIDs / PhotoMeta (one row per evidence photograph).
create table public.inspection_photos (
  id                     uuid primary key default gen_random_uuid(),
  inspection_id          text not null references public.inspections(id),
  trade_in_id            text not null references public.trade_ins(id),
  bucket                 text not null default 'inspection-photos' check (bucket = 'inspection-photos'),
  object_path            text not null unique,
  category               text not null default 'OTHER'
                           check (category in ('FRONT','BACK','SCREEN','IMEI','DAMAGE','ACCESSORIES','OTHER')),
  label                  text,
  mime_type              text not null check (mime_type in ('image/png','image/jpeg','image/gif','image/webp','image/heic','image/heif','image/bmp')),
  size_bytes             integer not null check (size_bytes > 0 and size_bytes <= 4194304),
  sha256                 text,
  uploaded_by            text,
  uploaded_at            timestamptz not null default now(),
  legacy_drive_file_id   text unique
);
create index inspection_photos_trade_in_idx on public.inspection_photos (trade_in_id);

create table public.vouchers (
  id                        text primary key check (id ~ '^VCH-[0-9]{6,}$'),
  trade_in_id               text not null,
  customer_id               text references public.customers(id),
  vendor_id                 text not null references public.vendors(id),
  branch_id                 text not null,
  voucher_number            text not null,
  customer_value            numeric(12,2) not null check (customer_value >= 0),
  commission_type_snapshot  text,
  commission_rate_snapshot  numeric(12,6),
  commission_value          numeric(12,2) not null default 0,
  total_settlement          numeric(12,2) not null,
  currency                  char(3) not null default 'QAR',
  issued_by                 text,
  issued_at                 timestamptz not null default now(),
  status                    text not null default 'ISSUED' check (status in ('ISSUED','VOIDED')),
  voided_by                 text,
  voided_at                 timestamptz,
  void_reason               text,
  replaced_by_voucher_id    text references public.vouchers(id),
  replaces_voucher_id       text references public.vouchers(id),
  notes                     text,
  operation_id              text,
  foreign key (trade_in_id, vendor_id) references public.trade_ins (id, vendor_id),
  foreign key (branch_id, vendor_id)   references public.branches (id, vendor_id),
  check (total_settlement = customer_value + commission_value),
  check (status <> 'VOIDED' or (voided_at is not null and void_reason is not null))
);
create unique index vouchers_number_key on public.vouchers (voucher_number);
-- ONE LIVE VOUCHER PER TRADE-IN (a voided one does not count).
create unique index vouchers_one_live_per_tradein on public.vouchers (trade_in_id) where status = 'ISSUED';
create unique index vouchers_operation_key on public.vouchers (operation_id) where operation_id is not null;
create index vouchers_vendor_idx on public.vouchers (vendor_id, branch_id, issued_at desc);

alter table public.trade_ins
  add constraint trade_ins_voucher_fk foreign key (voucher_id)
  references public.vouchers(id) deferrable initially deferred;

create table public.collections (
  id                       text primary key check (id ~ '^BAT-[0-9]{5,}$'),
  vendor_id                text not null references public.vendors(id),
  branch_id                text,
  trade_in_ids             text[] not null default '{}',      -- the printed list
  device_count             integer not null default 0,
  expected_device_count    integer not null default 0,
  collected_device_count   integer not null default 0,
  missing_device_count     integer not null default 0,
  exception_device_count   integer not null default 0,
  customer_value_total     numeric(12,2) not null default 0,
  commission_total         numeric(12,2) not null default 0,
  settlement_total         numeric(12,2) not null default 0,
  expected_amount          numeric(12,2) not null default 0,
  actual_amount            numeric(12,2) not null default 0,
  currency                 char(3) not null default 'QAR',
  status                   text not null default 'READY_FOR_COLLECTION' check (status in (
                             'DRAFT','READY_FOR_COLLECTION','PARTIALLY_COLLECTED','COLLECTED',
                             'COLLECTION_EXCEPTION','CANCELLED','CLOSED')),
  created_by               text,
  created_at               timestamptz not null default now(),
  collected_by             text,
  collected_at             timestamptz,
  closed_at                timestamptz,
  cancelled_by             text,
  cancelled_at             timestamptz,
  cancel_reason            text,
  notes                    text,
  operation_id             text,
  unique (id, vendor_id),
  foreign key (branch_id, vendor_id) references public.branches (id, vendor_id)
);
create unique index collections_operation_key on public.collections (operation_id) where operation_id is not null;
create index collections_vendor_idx on public.collections (vendor_id, branch_id, status);

create table public.collection_items (
  id                text primary key check (id ~ '^CLI-[0-9]{7,}$'),
  batch_id          text not null,
  trade_in_id       text not null,
  vendor_id         text not null references public.vendors(id),
  branch_id         text,
  device_snapshot   text,
  imei              text,
  grade_code        text,
  customer_value    numeric(12,2) not null default 0,
  commission_value  numeric(12,2) not null default 0,
  settlement_value  numeric(12,2) not null default 0,
  currency          char(3) not null default 'QAR',
  item_status       text not null default 'PENDING'
                      check (item_status in ('PENDING','COLLECTED','MISSING','REJECTED','EXCEPTION')),
  collected_by      text,
  collected_at      timestamptz,
  exception_reason  text,
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- A line belongs to a note of the same partner, about a device of the same partner.
  foreign key (batch_id, vendor_id)    references public.collections (id, vendor_id),
  foreign key (trade_in_id, vendor_id) references public.trade_ins (id, vendor_id),
  check (item_status = 'PENDING' or item_status = 'COLLECTED' or exception_reason is not null)
);
-- A DEVICE IS PENDING ON AT MOST ONE NOTE.
create unique index collection_items_one_pending on public.collection_items (trade_in_id)
  where item_status = 'PENDING';
create index collection_items_batch_idx on public.collection_items (batch_id);

alter table public.trade_ins
  add constraint trade_ins_batch_fk foreign key (collection_batch_id)
  references public.collections(id) deferrable initially deferred;

create table public.settlements (
  id                     text primary key check (id ~ '^STL-[0-9]{5,}$'),
  vendor_id              text not null references public.vendors(id),
  period_from            timestamptz not null,
  period_to              timestamptz not null,
  trade_in_count         integer not null default 0 check (trade_in_count >= 0),
  customer_value_total   numeric(12,2) not null default 0,
  commission_total       numeric(12,2) not null default 0,
  settlement_total       numeric(12,2) not null default 0,
  currency               char(3) not null default 'QAR',
  status                 text not null default 'DRAFT'
                           check (status in ('DRAFT','SUBMITTED','APPROVED','PAID','CLOSED','CANCELLED')),
  collection_batch_ids   text[] not null default '{}',
  created_by             text,
  created_at             timestamptz not null default now(),
  submitted_at           timestamptz,
  approved_by            text,
  approved_at            timestamptz,
  paid_at                timestamptz,
  payment_reference      text,
  cancelled_by           text,
  cancelled_at           timestamptz,
  cancel_reason          text,
  notes                  text,
  operation_id           text,
  updated_at             timestamptz not null default now(),
  unique (id, vendor_id),
  check (period_to >= period_from),
  check (settlement_total = customer_value_total + commission_total),
  check (status not in ('APPROVED','PAID','CLOSED') or (approved_by is not null and approved_at is not null)),
  check (status not in ('PAID','CLOSED') or (paid_at is not null and length(btrim(coalesce(payment_reference,''))) > 0)),
  check (status <> 'CANCELLED' or cancelled_at is not null)
);
create unique index settlements_operation_key on public.settlements (operation_id) where operation_id is not null;
create index settlements_vendor_idx on public.settlements (vendor_id, status, created_at desc);

-- A trade-in can only be claimed by a settlement of ITS OWN partner.
alter table public.trade_ins
  add constraint trade_ins_settlement_fk foreign key (settlement_id, vendor_id)
  references public.settlements (id, vendor_id) deferrable initially deferred;

-- Settlement lines: the trade-ins a settlement claimed (one source of truth).
create view public.settlement_lines with (security_invoker = true) as
  select t.settlement_id, t.id as trade_in_id, t.vendor_id, t.branch_id,
         t.brand_snapshot, t.model_snapshot, t.storage_snapshot, t.grade_code,
         t.final_customer_value as customer_value, t.commission_rate_snapshot as commission_rate,
         t.commission_value, t.total_settlement, t.collected_at, t.collected_by,
         t.collection_batch_id, t.created_at
    from public.trade_ins t
   where t.settlement_id is not null;

-- ---------------------------------------------------------------------
-- System
-- ---------------------------------------------------------------------
create table public.notifications (
  id             text primary key check (id ~ '^NTF-[0-9]{7,}$'),
  audience_type  text not null check (audience_type in ('USER','CUSTOMER','VENDOR','PLATFORM')),
  audience_id    text,
  branch_id      text,
  kind           text not null,
  title          text not null,
  message        text not null,
  entity_type    text,
  entity_id      text,
  created_by     text not null default 'system',
  created_at     timestamptz not null default now(),
  check (audience_type = 'PLATFORM' or audience_id is not null)
);
create index notifications_audience_idx on public.notifications (audience_type, audience_id, created_at desc);

-- Replaces the comma-separated ReadBy column.
create table public.notification_reads (
  notification_id  text not null references public.notifications(id) on delete cascade,
  principal_id     text not null,
  read_at          timestamptz not null default now(),
  primary key (notification_id, principal_id)
);

create table public.audit_logs (
  id              bigint generated always as identity primary key,
  legacy_log_id   text unique,
  occurred_at     timestamptz not null default now(),
  request_id      text,
  actor_id        text,
  actor_name      text,
  actor_role      text,
  vendor_id       text,
  branch_id       text,
  action          text not null,
  object_type     text,
  object_id       text,
  old_value       jsonb,
  new_value       jsonb,
  details         jsonb,
  ip_address      text,
  user_agent      text
);
create index audit_logs_object_idx on public.audit_logs (object_id, occurred_at);
create index audit_logs_action_idx on public.audit_logs (action, occurred_at desc);
create index audit_logs_time_idx   on public.audit_logs (occurred_at desc);

create table public.settings (
  key          text primary key,
  value        text not null default '',
  type         text not null default 'STRING' check (type in ('STRING','NUMBER','BOOLEAN','JSON')),
  section      text,
  description  text,
  updated_by   text,
  updated_at   timestamptz not null default now()
);

-- Idempotent requests (28_Idempotency.gs, now one transaction per request).
create table public.idempotency_keys (
  id               text primary key,          -- sha256(principal|action|target|key)
  principal_type   text not null,
  principal_id     text not null,
  action           text not null,
  target_id        text not null default '',
  request_hash     text not null,
  status           text not null check (status in ('COMPLETED')),
  response_status  integer not null,
  response         jsonb not null,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null
);
create index idempotency_keys_expiry on public.idempotency_keys (expires_at);

-- Every one-time-code send attempt. The code itself is never stored here.
create table public.otp_send_log (
  id          bigint generated always as identity primary key,
  phone       text not null,
  purpose     text not null check (purpose in ('LOGIN','REGISTER')),
  channel     text not null check (channel in ('SMS','TEST')),
  outcome     text not null check (outcome in ('SENT','RATE_LIMITED','REFUSED','FAILED')),
  reason      text,
  created_at  timestamptz not null default now()
);
create index otp_send_log_phone_idx   on public.otp_send_log (phone, created_at desc);
create index otp_send_log_purpose_idx on public.otp_send_log (purpose, created_at desc) where outcome = 'SENT';

-- Sequence counters for human-readable ids (TI-CAR-000042, CAR-20261008-0007 ...).
create table public.id_counters (
  scope       text primary key,
  last_value  bigint not null default 0 check (last_value >= 0)
);

-- Background job and reconciliation visibility.
create table public.job_runs (
  id           bigint generated always as identity primary key,
  job          text not null,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  status       text not null default 'RUNNING' check (status in ('RUNNING','SUCCEEDED','FAILED')),
  summary      jsonb,
  error        text
);
create index job_runs_job_idx on public.job_runs (job, started_at desc);

create table public.reconciliation_issues (
  id         bigint generated always as identity primary key,
  run_id     bigint not null references public.job_runs(id) on delete cascade,
  kind       text not null,
  object_id  text,
  detail     text
);

-- Migration bookkeeping (tools/migration). Never exposed.
create table public.migration_runs (
  id            bigint generated always as identity primary key,
  source_label  text not null,
  mode          text not null check (mode in ('DRY_RUN','VALIDATE','APPLY')),
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  status        text not null default 'RUNNING' check (status in ('RUNNING','SUCCEEDED','FAILED','PARTIAL')),
  summary       jsonb
);
create table public.migration_checkpoints (
  run_id     bigint not null references public.migration_runs(id) on delete cascade,
  sheet      text not null,
  next_row   integer not null default 0,
  primary key (run_id, sheet)
);
create table public.migration_row_errors (
  id         bigint generated always as identity primary key,
  run_id     bigint not null references public.migration_runs(id) on delete cascade,
  sheet      text not null,
  row_number integer,
  legacy_id  text,
  error      text not null
);
create table public.legacy_file_map (
  legacy_drive_file_id  text primary key,
  bucket                text not null,
  object_path           text not null,
  sha256                text,
  size_bytes            integer,
  migrated_at           timestamptz not null default now()
);
