-- =====================================================================
-- 20261008000900_sequence_grants.sql
--
-- Found by the REAL cloud verification (Supabase, PostgreSQL 17):
-- migration 0700 revoked client grants on sequences by looping over
-- information_schema.sequences. On Supabase that view lists none of these
-- identity sequences, so the revoke did nothing there and anon /
-- authenticated kept USAGE, SELECT and UPDATE on them (Supabase's default
-- privileges). The catalogue is used directly here, which lists every
-- sequence in schema public. New sequences are already covered by the
-- default-privilege change in 0700.
-- =====================================================================

do $$
declare s text;
begin
  for s in select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'S' loop
    execute format('revoke all on sequence public.%I from anon, authenticated', s);
  end loop;
end $$;
