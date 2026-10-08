-- =====================================================================
-- 20261008000800_staff_email_sign_in.sql
--
-- Owner decision (staging phase): STAFF sign in with email + password
-- through Supabase Auth; customers keep the 3.1 SMS code.
--
--   1. A staff email is now a sign-in identifier: at most one staff
--      profile per address (case-insensitive), and it must look like an
--      address. Customers' optional emails are untouched.
--   2. staff_auth_attempts: per-address bookkeeping for the API's own
--      limits (wrong passwords, reset codes requested, wrong reset codes,
--      and RESET_EMAIL: reset e-mails actually handed to Supabase Auth,
--      counted for the platform-wide hourly cap).
--      The address is stored only as a SHA-256 of its lower-case form;
--      no password or code is ever stored here (Supabase Auth checks them).
--      API-only: RLS on, no client grants.
-- =====================================================================

alter table public.app_users
  add constraint app_users_email_format
  check (email is null or (length(email) <= 254 and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'));

create unique index app_users_email_key on public.app_users (lower(btrim(email))) where email is not null;

create table public.staff_auth_attempts (
  id          bigint generated always as identity primary key,
  email_key   text not null check (email_key ~ '^[0-9a-f]{64}$'),
  kind        text not null check (kind in ('LOGIN', 'RESET_SEND', 'RESET_VERIFY', 'RESET_EMAIL')),
  -- Reserved BEFORE Supabase Auth is asked (so concurrent attempts all count),
  -- marked succeeded only when Auth accepted it.
  succeeded   boolean not null default false,
  created_at  timestamptz not null default now()
);
create index staff_auth_attempts_key_idx on public.staff_auth_attempts (email_key, kind, created_at desc);
create index staff_auth_attempts_kind_idx on public.staff_auth_attempts (kind, created_at desc);
alter table public.staff_auth_attempts enable row level security;
revoke all on public.staff_auth_attempts from anon, authenticated;
grant all on public.staff_auth_attempts to service_role;
