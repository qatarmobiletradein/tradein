-- =====================================================================
-- 20261008001200_session_check_and_mfa.sql
--
-- 1. The API refuses access tokens whose Supabase session was signed out
--    or revoked (refresh-token reuse detection revokes the whole session):
--    the runtime role may READ auth.sessions and auth.refresh_tokens
--    (nothing else in auth; no write).
-- 2. Authenticator-app (TOTP) step for SUPER_ADMIN: wrong codes are
--    counted per account. The account is stored only as a SHA-256 key; no
--    code or secret is ever stored. API-only: RLS on, no client grants.
-- =====================================================================

do $$
begin
  if to_regclass('auth.sessions') is not null then
    execute 'grant select on auth.sessions to qm_api';
  end if;
  if to_regclass('auth.refresh_tokens') is not null then
    execute 'grant select on auth.refresh_tokens to qm_api';
  end if;
end $$;

create table public.mfa_attempts (
  id           bigint generated always as identity primary key,
  account_key  text not null check (account_key ~ '^[0-9a-f]{64}$'),
  succeeded    boolean not null default false,
  created_at   timestamptz not null default now()
);
create index mfa_attempts_key_idx on public.mfa_attempts (account_key, created_at desc);
alter table public.mfa_attempts enable row level security;
revoke all on public.mfa_attempts from anon, authenticated;
grant all on public.mfa_attempts to service_role;
grant select, insert, update, delete on public.mfa_attempts to qm_api;
