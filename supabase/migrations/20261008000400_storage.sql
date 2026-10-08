-- =====================================================================
-- 20261008000400_storage.sql
--
-- Supabase Storage buckets.
--
--   catalog-media      PUBLIC   brand logos, product and colour photos,
--                               partner logos. Fetched by a customer's
--                               browser before sign-in (3.1 "PUBLIC" media).
--   inspection-photos  PRIVATE  evidence of a customer's device, often with
--                               a lock screen or IMEI label in frame. Never
--                               public. Read only through short-lived signed
--                               URLs that the API issues after the same scope
--                               check as tech.viewPhoto (3.1 "PRIVATE" media).
--
-- There are deliberately NO insert/update/delete policies on storage.objects
-- for anon or authenticated: uploads go through the API, which validates the
-- file type by its bytes, the size, and the caller's authority, then writes
-- with server credentials. Private files therefore cannot be written or read
-- by a browser holding only the anon key or a user JWT.
--
-- File size limits mirror 3.1 (MEDIA.MAX_IMAGE_BYTES = 2 MB public,
-- MAX_PHOTO_BYTES = 4 MB evidence). SVG is excluded everywhere (3.1 image
-- policy: raster only).
-- =====================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('catalog-media', 'catalog-media', true, 2097152,
   array['image/png','image/jpeg','image/gif','image/webp','image/heic','image/heif','image/bmp']),
  ('inspection-photos', 'inspection-photos', false, 4194304,
   array['image/png','image/jpeg','image/gif','image/webp','image/heic','image/heif','image/bmp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Public bucket objects are served by the public URL endpoint. A SELECT
-- policy is still declared for catalog-media so list/download through the
-- API surface behaves the same for anon and signed-in users.
--
-- storage.objects belongs to Supabase's storage admin role, and only a
-- table's owner may create a policy on it. If the migration role is not
-- allowed to (Supabase has changed these privileges over time), this
-- OPTIONAL read policy is skipped with a WARNING instead of failing the
-- whole migration: public files are still served by the public URL, and
-- nothing about the private bucket depends on it. Anything else fails.
do $$
begin
  drop policy if exists qm_catalog_media_read on storage.objects;
  create policy qm_catalog_media_read on storage.objects
    for select to anon, authenticated
    using (bucket_id = 'catalog-media');
exception when insufficient_privilege then
  raise warning 'qm: storage policy qm_catalog_media_read NOT created (not owner of storage.objects). Optional: create a SELECT policy for bucket catalog-media in Dashboard > Storage > Policies.';
end $$;

-- inspection-photos: no policy for anon/authenticated = no access.
