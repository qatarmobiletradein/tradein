-- Product images 2026-10-10: official manufacturer renders served by qm-web at /catalog/<file>
-- (apps/web/catalog, sources in SOURCES.json). Idempotent: only products WITHOUT an image are set,
-- so an image chosen later in Admin is never overwritten.
do $$
declare r record; n_set int := 0; n_kept int := 0; n_missing int := 0; pid text;
begin
  for r in select * from (values
    ('iPhone 13 mini', 'iphone-13-mini.webp'),
    ('iPhone 13', 'iphone-13.webp'),
    ('iPhone 13 Pro', 'iphone-13-pro.webp'),
    ('iPhone 13 Pro Max', 'iphone-13-pro-max.webp'),
    ('iPhone 14', 'iphone-14.webp'),
    ('iPhone 14 Plus', 'iphone-14-plus.webp'),
    ('iPhone 14 Pro', 'iphone-14-pro.webp'),
    ('iPhone 14 Pro Max', 'iphone-14-pro-max.webp'),
    ('iPhone 15', 'iphone-15.webp'),
    ('iPhone 15 Plus', 'iphone-15-plus.webp'),
    ('iPhone 15 Pro', 'iphone-15-pro.webp'),
    ('iPhone 15 Pro Max', 'iphone-15-pro-max.webp'),
    ('iPhone 16', 'iphone-16.webp'),
    ('iPhone 16 Plus', 'iphone-16-plus.webp'),
    ('iPhone 16 Pro', 'iphone-16-pro.webp'),
    ('iPhone 16 Pro Max', 'iphone-16-pro-max.webp'),
    ('iPhone 16e', 'iphone-16e.webp'),
    ('iPhone 17', 'iphone-17.webp'),
    ('iPhone Air', 'iphone-air.webp'),
    ('iPhone 17 Pro', 'iphone-17-pro.webp'),
    ('iPhone 17 Pro Max', 'iphone-17-pro-max.webp'),
    ('iPhone 17e', 'iphone-17e.webp'),
    ('iPhone 18 Pro', 'iphone-18-pro.webp'),
    ('iPhone 18 Pro Max', 'iphone-18-pro-max.webp'),
    ('iPhone Duo', 'iphone-duo.webp'),
    ('Galaxy S22', 'galaxy-s22.webp'),
    ('Galaxy S22+', 'galaxy-s22-plus.webp'),
    ('Galaxy S22 Ultra', 'galaxy-s22-ultra.webp'),
    ('Galaxy S23', 'galaxy-s23.webp'),
    ('Galaxy S23+', 'galaxy-s23-plus.webp'),
    ('Galaxy S23 Ultra', 'galaxy-s23-ultra.webp'),
    ('Galaxy S24', 'galaxy-s24.webp'),
    ('Galaxy S24+', 'galaxy-s24-plus.webp'),
    ('Galaxy S24 Ultra', 'galaxy-s24-ultra.webp'),
    ('Galaxy S25', 'galaxy-s25.webp'),
    ('Galaxy S25+', 'galaxy-s25-plus.webp'),
    ('Galaxy S25 Ultra', 'galaxy-s25-ultra.webp'),
    ('Galaxy S26', 'galaxy-s26.webp'),
    ('Galaxy S26+', 'galaxy-s26-plus.webp'),
    ('Galaxy S26 Ultra', 'galaxy-s26-ultra.webp'),
    ('Galaxy Z Fold5', 'galaxy-z-fold5.webp'),
    ('Galaxy Z Flip5', 'galaxy-z-flip5.webp'),
    ('Galaxy Z Fold6', 'galaxy-z-fold6.webp'),
    ('Galaxy Z Flip6', 'galaxy-z-flip6.webp'),
    ('Galaxy Z Fold7', 'galaxy-z-fold7.webp'),
    ('Galaxy Z Flip7', 'galaxy-z-flip7.webp'),
    ('Galaxy Z Fold8', 'galaxy-z-fold8.webp'),
    ('Galaxy Z Flip8', 'galaxy-z-flip8.webp')
  ) as t(model, file) loop
    select p.id into pid from public.products p join public.brands b on b.id = p.brand_id
     where b.name in ('Apple','Samsung') and lower(btrim(p.model)) = lower(r.model);
    if pid is null then n_missing := n_missing + 1; continue; end if;
    update public.products set main_image_url = 'https://qmtradein.com/catalog/' || r.file, updated_at = now()
     where id = pid and coalesce(btrim(main_image_url), '') = '';
    if found then n_set := n_set + 1; else n_kept := n_kept + 1; end if;
  end loop;
  if n_missing > 0 then raise exception '% image rows did not match a catalogue model', n_missing; end if;
  insert into public.audit_logs (actor_id, actor_name, actor_role, action, object_type, object_id, details)
    values ('SYSTEM', 'Operator (owner request)', 'SYSTEM', 'PRODUCT_IMAGES_SET', 'CATALOGUE', 'product_images_2026-10-10',
      jsonb_build_object('set', n_set, 'kept', n_kept, 'base', 'https://qmtradein.com/catalog/'));
end $$;
