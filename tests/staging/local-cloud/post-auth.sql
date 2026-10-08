-- LOCAL EMULATION ONLY. Run as supabase_admin after Supabase Auth has migrated schema auth.
\set ON_ERROR_STOP on
-- ASSUMPTION (verify on the real staging project): the project's postgres
-- role may reference auth.users from its own tables (Supabase documents
-- profile tables with "references auth.users"). The real Auth migrations
-- grant SELECT; REFERENCES is granted here to match that documented use.
grant references on auth.users to postgres;
grant execute on all functions in schema auth to postgres, anon, authenticated, service_role;
