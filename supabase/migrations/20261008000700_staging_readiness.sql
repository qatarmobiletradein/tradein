-- =====================================================================
-- 20261008000700_staging_readiness.sql
--
-- Deployment-readiness review (staging preparation):
--
--   1. The 0300 revoke loop covered TABLES only. The settlement_lines view
--      and the identity sequences still carried Supabase's default grants
--      to anon/authenticated. The view is security_invoker (so RLS and
--      column grants of the caller apply anyway), but nothing a client
--      does not need should be granted: revoked.
--   2. Supabase grants anon/authenticated ALL on every NEW table, sequence
--      and function created in schema public (default privileges). A table
--      added by a future migration would therefore start readable by the
--      Data API until someone remembered to revoke it. The default is
--      removed for objects created by the migration role, so a new table
--      starts with NO client access (fail closed) and must be granted
--      explicitly, as every existing table is.
-- =====================================================================

revoke all on public.settlement_lines from anon, authenticated;

do $$
declare s text;
begin
  for s in select sequence_name from information_schema.sequences where sequence_schema = 'public' loop
    execute format('revoke all on sequence public.%I from anon, authenticated', s);
  end loop;
end $$;

-- Applies to objects created later by the role running this migration
-- (the role that runs every migration).
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;
-- PostgreSQL itself grants EXECUTE on every new function to PUBLIC (which anon and
-- authenticated inherit). That is a GLOBAL default, which a per-schema REVOKE cannot
-- remove, so it is revoked globally for the migration role: any function a later
-- migration adds (in any schema) must be granted explicitly, like the existing ones.
alter default privileges revoke execute on functions from public;
