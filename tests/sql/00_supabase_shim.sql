-- =====================================================================
-- 00_supabase_shim.sql — TEST ONLY. Never run against Supabase.
--
-- A plain PostgreSQL has none of the objects Supabase provides. This file
-- creates the minimum the migrations and RLS tests rely on, modelled on
-- Supabase's own definitions:
--   roles anon, authenticated, service_role (service_role has BYPASSRLS)
--   auth.users, auth.uid(), auth.jwt()  — claims read from the
--     request.jwt.claims setting, exactly how PostgREST passes them
--   storage.buckets, storage.objects
-- =====================================================================
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end $$;

create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key,
  phone text unique,
  email text,
  email_confirmed_at timestamptz,
  raw_app_meta_data jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;

create schema if not exists storage;
create table if not exists storage.buckets (
  id text primary key, name text not null, public boolean default false,
  file_size_limit bigint, allowed_mime_types text[], created_at timestamptz default now()
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id), name text, owner uuid,
  created_at timestamptz default now(), metadata jsonb
);
alter table storage.objects enable row level security;
grant usage on schema storage to anon, authenticated, service_role;
grant select on storage.objects to anon, authenticated;
grant all on storage.objects, storage.buckets to service_role;

-- Supabase grants the API roles everything on NEW objects in schema public
-- (default privileges for the role that creates them). Imitated here so the
-- tests prove the migrations take those grants away again.
alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
