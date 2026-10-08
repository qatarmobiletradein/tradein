-- =====================================================================
-- 20261008001300_auth_read_functions.sql
--
-- Found on the real cloud: on Supabase the `auth` schema belongs to
-- supabase_admin and `postgres` cannot grant USAGE on it, so the API role
-- (qm_api) could not read auth.sessions / auth.users even with table grants
-- (1100, 1200). The two reads the API needs are therefore exposed as
-- SECURITY DEFINER functions owned by the migration owner, returning only
-- what the API needs, callable by qm_api only.
-- =====================================================================

-- Is this Supabase session still alive? (row exists, not past not_after,
-- still has a live refresh token — reuse detection and sign-out remove it)
create or replace function app.auth_session_alive(p_session uuid, p_user uuid)
returns boolean
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select exists (
    select 1 from auth.sessions s
     where s.id = p_session and s.user_id = p_user
       and (s.not_after is null or s.not_after > now())
       and (s.refresh_token_hmac_key is not null
            or exists (select 1 from auth.refresh_tokens r where r.session_id = s.id and not r.revoked)));
$$;

-- An Auth user holding this address that no profile uses, and whether it is
-- a removable leftover (never confirmed, or created by this API).
create or replace function app.auth_user_for_cleanup(p_email text)
returns table (id uuid, removable boolean)
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select a.id,
         not (exists (select 1 from public.app_users p where p.auth_user_id = a.id)
              or exists (select 1 from public.customers c where c.auth_user_id = a.id))
         and (a.email_confirmed_at is null or coalesce(a.raw_app_meta_data ->> 'qm_staff', '') = 'true')
    from auth.users a
   where lower(a.email) = lower(p_email);
$$;

revoke all on function app.auth_session_alive(uuid, uuid) from public, anon, authenticated;
revoke all on function app.auth_user_for_cleanup(text) from public, anon, authenticated;
grant execute on function app.auth_session_alive(uuid, uuid) to qm_api;
grant execute on function app.auth_user_for_cleanup(text) to qm_api;
