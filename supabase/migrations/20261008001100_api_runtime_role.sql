-- =====================================================================
-- 20261008001100_api_runtime_role.sql
--
-- A dedicated database role for the API (Railway), instead of the
-- project owner `postgres`:
--   * it can read and write the application's data (public + app),
--     bypassing RLS exactly like the server-side service role does;
--   * it CANNOT change the schema (it owns nothing), create roles, or
--     touch Supabase's own schemas — except reading auth.users, which the
--     staff sign-in clean-up needs (and nothing else in auth);
--   * schema changes keep going through the owner (`postgres`), so a leaked
--     API credential cannot drop or alter tables.
--
-- The role is created NOLOGIN and WITHOUT a password. Login and the
-- password are set out-of-band, per environment, by the operator:
--     alter role qm_api login password '<SCRAM verifier or password>';
-- No credential is ever written in this repository.
-- =====================================================================

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'qm_api') then
    create role qm_api nologin bypassrls noinherit;
  end if;
end $$;

grant usage on schema public, app to qm_api;
-- No CREATE on any schema: with this role `npm run migrate` can only verify
-- the ledger (it fails on the first DDL of a pending migration).

grant select, insert, update, delete on all tables in schema public to qm_api;
grant select, insert, update, delete on all tables in schema app to qm_api;
grant usage, select, update on all sequences in schema public to qm_api;
grant usage, select, update on all sequences in schema app to qm_api;
grant execute on all functions in schema app to qm_api;

-- Tables, sequences and functions created later by the owner.
alter default privileges for role postgres in schema public grant select, insert, update, delete on tables to qm_api;
alter default privileges for role postgres in schema app    grant select, insert, update, delete on tables to qm_api;
alter default privileges for role postgres in schema public grant usage, select, update on sequences to qm_api;
alter default privileges for role postgres in schema app    grant usage, select, update on sequences to qm_api;
alter default privileges for role postgres in schema app    grant execute on functions to qm_api;

grant select on auth.users to qm_api;
