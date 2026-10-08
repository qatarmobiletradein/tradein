-- =====================================================================
-- LOCAL EMULATION ONLY — never run against Supabase.
--
-- Recreates the parts of a Supabase project's database that matter to
-- this application, with Supabase's privilege model as closely as we can
-- reproduce it from public information:
--   * the superuser is supabase_admin; the project's "postgres" role is a
--     normal role (CREATEROLE, CREATEDB, BYPASSRLS) — so the migrations are
--     exercised WITHOUT superuser rights, as on Supabase;
--   * anon / authenticated / service_role / authenticator (PostgREST);
--   * schema auth owned by supabase_auth_admin and filled by the REAL
--     Supabase Auth (GoTrue) migrations at start-up;
--   * schema storage owned by supabase_storage_admin (a minimal copy of
--     buckets/objects; the Storage API itself is stood in by the gateway);
--   * pgcrypto in schema extensions; Supabase-style default privileges.
-- Passwords are throwaway values generated per run by run.sh.
-- =====================================================================
\set ON_ERROR_STOP on

create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create role authenticator login noinherit password :'pw';
grant anon, authenticated, service_role to authenticator;
create role supabase_auth_admin login noinherit createrole password :'pw';
create role supabase_storage_admin nologin noinherit;
create role postgres login createrole createdb bypassrls password :'pw';

grant create, connect on database postgres to postgres, supabase_auth_admin;
alter schema public owner to postgres;
create schema extensions;
create extension pgcrypto with schema extensions;
grant usage on schema extensions to postgres, anon, authenticated, service_role;
alter database postgres set search_path = "$user", public, extensions;

create schema auth authorization supabase_auth_admin;
grant usage on schema auth to postgres, anon, authenticated, service_role;
alter role supabase_auth_admin set search_path = auth;

create schema storage authorization supabase_storage_admin;
create table storage.buckets (
  id text primary key, name text not null, owner uuid, public boolean default false,
  file_size_limit bigint, allowed_mime_types text[], created_at timestamptz default now(), updated_at timestamptz default now()
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text, owner uuid,
  created_at timestamptz default now(), updated_at timestamptz default now(), metadata jsonb,
  unique (bucket_id, name)
);
alter table storage.buckets owner to supabase_storage_admin;
alter table storage.objects owner to supabase_storage_admin;
alter table storage.objects enable row level security;
alter table storage.buckets enable row level security;
grant usage on schema storage to postgres, anon, authenticated, service_role;
grant select, insert, update on storage.buckets to postgres;
grant select on storage.objects to postgres;
grant all on storage.objects, storage.buckets to service_role;
grant select, insert, update, delete on storage.objects to anon, authenticated;
grant select on storage.buckets to anon, authenticated;

-- Supabase: everything NEW that postgres creates in public is granted to the API roles.
alter default privileges for role postgres in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
