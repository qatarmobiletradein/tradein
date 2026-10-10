-- Qatar Mobile Trade-In — real catalogue: Apple iPhone 13–18 generations, Samsung Galaxy S22–S26, Galaxy Z Fold/Flip 5–8.
-- Source: the owner's file QM_TradeIn_Apple_Samsung_Catalogue_2026-10-10.xlsx (48 models, 710 storage×colour rows),
-- converted to supabase/data/catalogue_2026-10-10.json. Idempotent: matches on the existing unique keys
-- (brand name; brand + model; product + storage; product + colour) and inserts only what is missing — safe to rerun.
-- No prices, grade rules or images are touched. RAM is not stored (the schema has no RAM field); it is kept in the product note.
do $$
declare
  r record; s int; bid text; pid text; cat text; n_prod int := 0; n_var int := 0; n_col int := 0; d_prod int := 0; d_var int := 0; d_col int := 0;
begin
  select id into cat from public.categories where lower(btrim(name)) = 'smartphones';
  if cat is null then
    cat := 'CAT-' || lpad(app.next_counter('CAT', 0)::text, 3, '0');
    insert into public.categories (id, name, slug, active, display_order) values (cat, 'Smartphones', 'smartphones', true, 1);
  end if;
  for r in select * from (values ('Apple','apple',1), ('Samsung','samsung',2)) as t(name, slug, ord) loop
    if not exists (select 1 from public.brands where lower(btrim(name)) = lower(r.name)) then
      insert into public.brands (id, name, slug, active, display_order) values ('BRD-' || lpad(app.next_counter('BRD', 0)::text, 3, '0'), r.name, r.slug, true, r.ord);
    end if;
  end loop;

  for r in select * from (values
    ('Apple', 'iPhone 13 mini', 2021, 25, 'apple iphone 13 mini', 'iPhone · generation 13 · source https://support.apple.com/en-qa/111872', array['128GB','256GB','512GB']::text[], array[9,17,33]::int[], array['Pink','Blue','Midnight','Starlight','(PRODUCT)RED','Green']::text[]),
    ('Apple', 'iPhone 13', 2021, 24, 'apple iphone 13', 'iPhone · generation 13 · source https://support.apple.com/en-qa/111872', array['128GB','256GB','512GB']::text[], array[9,17,33]::int[], array['Pink','Blue','Midnight','Starlight','(PRODUCT)RED','Green']::text[]),
    ('Apple', 'iPhone 13 Pro', 2021, 23, 'apple iphone 13 pro', 'iPhone · generation 13 · source https://support.apple.com/en-us/111871', array['128GB','256GB','512GB','1TB']::text[], array[9,17,33,65]::int[], array['Graphite','Gold','Silver','Sierra Blue','Alpine Green']::text[]),
    ('Apple', 'iPhone 13 Pro Max', 2021, 22, 'apple iphone 13 pro max', 'iPhone · generation 13 · source https://support.apple.com/en-us/111871', array['128GB','256GB','512GB','1TB']::text[], array[9,17,33,65]::int[], array['Graphite','Gold','Silver','Sierra Blue','Alpine Green']::text[]),
    ('Apple', 'iPhone 14', 2022, 21, 'apple iphone 14', 'iPhone · generation 14 · source https://support.apple.com/en-us/111850', array['128GB','256GB','512GB']::text[], array[9,17,33]::int[], array['Midnight','Purple','Starlight','(PRODUCT)RED','Blue','Yellow']::text[]),
    ('Apple', 'iPhone 14 Plus', 2022, 20, 'apple iphone 14 plus', 'iPhone · generation 14 · source https://support.apple.com/en-us/111850', array['128GB','256GB','512GB']::text[], array[9,17,33]::int[], array['Midnight','Purple','Starlight','(PRODUCT)RED','Blue','Yellow']::text[]),
    ('Apple', 'iPhone 14 Pro', 2022, 19, 'apple iphone 14 pro', 'iPhone · generation 14 · source https://support.apple.com/en-us/111849', array['128GB','256GB','512GB','1TB']::text[], array[9,17,33,65]::int[], array['Deep Purple','Gold','Silver','Space Black']::text[]),
    ('Apple', 'iPhone 14 Pro Max', 2022, 18, 'apple iphone 14 pro max', 'iPhone · generation 14 · source https://support.apple.com/en-us/111849', array['128GB','256GB','512GB','1TB']::text[], array[9,17,33,65]::int[], array['Deep Purple','Gold','Silver','Space Black']::text[]),
    ('Apple', 'iPhone 15', 2023, 17, 'apple iphone 15', 'iPhone · generation 15 · source https://support.apple.com/en-us/111831', array['128GB','256GB','512GB']::text[], array[9,17,33]::int[], array['Black','Blue','Green','Yellow','Pink']::text[]),
    ('Apple', 'iPhone 15 Plus', 2023, 16, 'apple iphone 15 plus', 'iPhone · generation 15 · source https://support.apple.com/en-us/111831', array['128GB','256GB','512GB']::text[], array[9,17,33]::int[], array['Black','Blue','Green','Yellow','Pink']::text[]),
    ('Apple', 'iPhone 15 Pro', 2023, 15, 'apple iphone 15 pro', 'iPhone · generation 15 · source https://support.apple.com/en-us/111829', array['128GB','256GB','512GB','1TB']::text[], array[9,17,33,65]::int[], array['Black Titanium','White Titanium','Blue Titanium','Natural Titanium']::text[]),
    ('Apple', 'iPhone 15 Pro Max', 2023, 14, 'apple iphone 15 pro max', 'iPhone · generation 15 · source https://support.apple.com/en-us/111828', array['256GB','512GB','1TB']::text[], array[17,33,65]::int[], array['Black Titanium','White Titanium','Blue Titanium','Natural Titanium']::text[]),
    ('Apple', 'iPhone 16', 2024, 13, 'apple iphone 16', 'iPhone · generation 16 · source https://www.apple.com/qa/iphone-16/specs/', array['128GB','256GB','512GB']::text[], array[9,17,33]::int[], array['Black','White','Pink','Teal','Ultramarine']::text[]),
    ('Apple', 'iPhone 16 Plus', 2024, 12, 'apple iphone 16 plus', 'iPhone · generation 16 · source https://www.apple.com/qa/iphone-16/specs/', array['128GB','256GB','512GB']::text[], array[9,17,33]::int[], array['Black','White','Pink','Teal','Ultramarine']::text[]),
    ('Apple', 'iPhone 16 Pro', 2024, 11, 'apple iphone 16 pro', 'iPhone · generation 16 · source https://support.apple.com/en-us/121031', array['128GB','256GB','512GB','1TB']::text[], array[9,17,33,65]::int[], array['Black Titanium','White Titanium','Natural Titanium','Desert Titanium']::text[]),
    ('Apple', 'iPhone 16 Pro Max', 2024, 10, 'apple iphone 16 pro max', 'iPhone · generation 16 · source https://support.apple.com/en-us/121032', array['256GB','512GB','1TB']::text[], array[17,33,65]::int[], array['Black Titanium','White Titanium','Natural Titanium','Desert Titanium']::text[]),
    ('Apple', 'iPhone 16e', 2025, 9, 'apple iphone 16e 16', 'iPhone · generation 16 · source https://support.apple.com/en-us/122208', array['128GB','256GB','512GB']::text[], array[9,17,33]::int[], array['Black','White']::text[]),
    ('Apple', 'iPhone 17', 2025, 8, 'apple iphone 17', 'iPhone · generation 17 · source https://www.apple.com/qa/iphone-17/specs/', array['256GB','512GB']::text[], array[17,33]::int[], array['Black','White','Mist Blue','Sage','Lavender']::text[]),
    ('Apple', 'iPhone 17e', 2026, 7, 'apple iphone 17e 17', 'iPhone · generation 17 · source https://www.apple.com/iphone-17e/specs/', array['256GB','512GB']::text[], array[17,33]::int[], array['Black','White','Soft Pink']::text[]),
    ('Apple', 'iPhone Air', 2025, 6, 'apple iphone air 17', 'iPhone · generation 17 · source https://www.apple.com/qa/iphone-air/specs/ · Apple markets this model as iPhone Air; included with the 17-era lineup.', array['256GB','512GB','1TB']::text[], array[17,33,65]::int[], array['Space Black','Cloud White','Light Gold','Sky Blue']::text[]),
    ('Apple', 'iPhone 17 Pro', 2025, 5, 'apple iphone 17 pro', 'iPhone · generation 17 · source https://www.apple.com/qa/iphone-17-pro/specs/', array['256GB','512GB','1TB']::text[], array[17,33,65]::int[], array['Silver','Cosmic Orange','Deep Blue']::text[]),
    ('Apple', 'iPhone 17 Pro Max', 2025, 4, 'apple iphone 17 pro max', 'iPhone · generation 17 · source https://www.apple.com/qa/iphone-17-pro/specs/', array['256GB','512GB','1TB','2TB']::text[], array[17,33,65,129]::int[], array['Silver','Cosmic Orange','Deep Blue']::text[]),
    ('Apple', 'iPhone 18 Pro', 2026, 3, 'apple iphone 18 pro', 'iPhone · generation 18 · source https://www.apple.com/qa/iphone-18-pro/specs/ · storage/colours from the owner catalogue file 2026-10-10, not independently re-verified', array['256GB','512GB','1TB','2TB']::text[], array[17,33,65,129]::int[], array['Black','Silver','Glacier','Burgundy']::text[]),
    ('Apple', 'iPhone 18 Pro Max', 2026, 2, 'apple iphone 18 pro max', 'iPhone · generation 18 · source https://www.apple.com/qa/iphone-18-pro/specs/ · storage/colours from the owner catalogue file 2026-10-10, not independently re-verified', array['256GB','512GB','1TB','2TB']::text[], array[17,33,65,129]::int[], array['Black','Silver','Glacier','Burgundy']::text[]),
    ('Apple', 'iPhone Duo', 2026, 1, 'apple iphone duo 18', 'iPhone · generation 18 · source https://www.apple.com/iphone-duo/specs/ · storage/colours from the owner catalogue file 2026-10-10, not independently re-verified · Official 2026 foldable model. No standard/base iPhone 18 was listed on Apple''s current lineup at file creation.', array['256GB','512GB','1TB','2TB']::text[], array[17,33,65,129]::int[], array['Night Sky','Star White']::text[]),
    ('Samsung', 'Galaxy S22', 2022, 23, 'samsung galaxy s22 s', 'Galaxy S · generation S22 · RAM 8GB (not stored: the catalogue has no RAM field) · source https://www.samsung.com/ae/support/mobile-devices/how-many-and-what-colors-are-supported-by-galaxy-s22-series-in-the-market/', array['128GB','256GB']::text[], array[9,17]::int[], array['Phantom Black','Phantom White','Green','Pink Gold','Violet','Sky Blue','Graphite','Cream']::text[]),
    ('Samsung', 'Galaxy S22+', 2022, 22, 'samsung galaxy s22 plus s', 'Galaxy S · generation S22 · RAM 8GB (not stored: the catalogue has no RAM field) · source https://www.samsung.com/ae/support/mobile-devices/how-many-and-what-colors-are-supported-by-galaxy-s22-series-in-the-market/', array['128GB','256GB']::text[], array[9,17]::int[], array['Phantom Black','Phantom White','Green','Pink Gold','Violet','Sky Blue','Graphite','Cream']::text[]),
    ('Samsung', 'Galaxy S22 Ultra', 2022, 21, 'samsung galaxy s22 ultra s', 'Galaxy S · generation S22 · RAM 8GB / 12GB (not stored: the catalogue has no RAM field) · source https://www.samsung.com/ae/support/mobile-devices/how-many-and-what-colors-are-supported-by-galaxy-s22-series-in-the-market/', array['128GB','256GB','512GB','1TB']::text[], array[9,17,33,65]::int[], array['Phantom Black','Phantom White','Green','Burgundy','Red','Sky Blue','Graphite']::text[]),
    ('Samsung', 'Galaxy S23', 2023, 20, 'samsung galaxy s23 s', 'Galaxy S · generation S23 · RAM 8GB (not stored: the catalogue has no RAM field) · source https://www.samsung.com/ae/smartphones/galaxy-s23/', array['128GB','256GB']::text[], array[9,17]::int[], array['Phantom Black','Cream','Green','Lavender','Lime','Graphite']::text[]),
    ('Samsung', 'Galaxy S23+', 2023, 19, 'samsung galaxy s23 plus s', 'Galaxy S · generation S23 · RAM 8GB (not stored: the catalogue has no RAM field) · source https://www.samsung.com/ae/smartphones/galaxy-s23/', array['256GB','512GB']::text[], array[17,33]::int[], array['Phantom Black','Cream','Green','Lavender','Lime','Graphite']::text[]),
    ('Samsung', 'Galaxy S23 Ultra', 2023, 18, 'samsung galaxy s23 ultra s', 'Galaxy S · generation S23 · RAM 8GB / 12GB (not stored: the catalogue has no RAM field) · source https://www.samsung.com/ae/smartphones/galaxy-s23-ultra/', array['256GB','512GB','1TB']::text[], array[17,33,65]::int[], array['Phantom Black','Cream','Green','Lavender','Lime','Sky Blue','Graphite','Red']::text[]),
    ('Samsung', 'Galaxy S24', 2024, 17, 'samsung galaxy s24 s', 'Galaxy S · generation S24 · RAM 8GB (not stored: the catalogue has no RAM field) · source https://www.samsung.com/ae/smartphones/galaxy-s24/specs/', array['128GB','256GB']::text[], array[9,17]::int[], array['Cobalt Violet','Amber Yellow','Onyx Black','Marble Gray','Jade Green','Sapphire Blue','Sandstone Orange']::text[]),
    ('Samsung', 'Galaxy S24+', 2024, 16, 'samsung galaxy s24 plus s', 'Galaxy S · generation S24 · RAM 12GB (not stored: the catalogue has no RAM field) · source https://www.samsung.com/ae/smartphones/galaxy-s24/specs/', array['256GB','512GB']::text[], array[17,33]::int[], array['Cobalt Violet','Amber Yellow','Onyx Black','Marble Gray','Jade Green','Sapphire Blue','Sandstone Orange']::text[]),
    ('Samsung', 'Galaxy S24 Ultra', 2024, 15, 'samsung galaxy s24 ultra s', 'Galaxy S · generation S24 · RAM 12GB (not stored: the catalogue has no RAM field) · source https://www.samsung.com/ae/smartphones/galaxy-s24-ultra/', array['256GB','512GB','1TB']::text[], array[17,33,65]::int[], array['Titanium Gray','Titanium Black','Titanium Violet','Titanium Yellow','Titanium Green','Titanium Orange','Titanium Blue']::text[]),
    ('Samsung', 'Galaxy S25', 2025, 14, 'samsung galaxy s25 s', 'Galaxy S · generation S25 · RAM 12GB (not stored: the catalogue has no RAM field) · source https://www.samsung.com/ae/smartphones/galaxy-s25/specs/', array['128GB','256GB','512GB']::text[], array[9,17,33]::int[], array['Navy','Silver Shadow','Icyblue','Mint','Blueblack','Coralred','Pinkgold']::text[]),
    ('Samsung', 'Galaxy S25+', 2025, 13, 'samsung galaxy s25 plus s', 'Galaxy S · generation S25 · RAM 12GB (not stored: the catalogue has no RAM field) · source https://www.samsung.com/ae/smartphones/galaxy-s25/specs/', array['256GB','512GB']::text[], array[17,33]::int[], array['Navy','Silver Shadow','Icyblue','Mint','Blueblack','Coralred','Pinkgold']::text[]),
    ('Samsung', 'Galaxy S25 Ultra', 2025, 12, 'samsung galaxy s25 ultra s', 'Galaxy S · generation S25 · RAM 12GB (not stored: the catalogue has no RAM field) · source https://www.samsung.com/ae/smartphones/galaxy-s25/specs/', array['256GB','512GB','1TB']::text[], array[17,33,65]::int[], array['Titanium Silverblue','Titanium Black','Titanium Gray','Titanium Whitesilver','Titanium Jetblack','Titanium Jadegreen','Titanium Pinkgold']::text[]),
    ('Samsung', 'Galaxy S26', 2026, 11, 'samsung galaxy s26 s', 'Galaxy S · generation S26 · RAM 12GB (not stored: the catalogue has no RAM field) · source https://www.samsung.com/ae/smartphones/galaxy-s26/buy/ · storage/colours from the owner catalogue file 2026-10-10, not independently re-verified', array['256GB','512GB']::text[], array[17,33]::int[], array['Cobalt Violet','Sky Blue','Black','White','Silver Shadow','Pink Gold']::text[]),
    ('Samsung', 'Galaxy S26+', 2026, 10, 'samsung galaxy s26 plus s', 'Galaxy S · generation S26 · RAM 12GB (not stored: the catalogue has no RAM field) · source https://www.samsung.com/ae/smartphones/galaxy-s26/buy/ · storage/colours from the owner catalogue file 2026-10-10, not independently re-verified', array['256GB','512GB']::text[], array[17,33]::int[], array['Cobalt Violet','Sky Blue','Black','White','Silver Shadow','Pink Gold']::text[]),
    ('Samsung', 'Galaxy S26 Ultra', 2026, 9, 'samsung galaxy s26 ultra s', 'Galaxy S · generation S26 · RAM 12GB / 16GB (not stored: the catalogue has no RAM field) · source https://www.samsung.com/ae/smartphones/galaxy-s26-ultra/buy/ · storage/colours from the owner catalogue file 2026-10-10, not independently re-verified', array['256GB','512GB','1TB']::text[], array[17,33,65]::int[], array['Cobalt Violet','Sky Blue','Black','White','Silver Shadow','Pink Gold']::text[]),
    ('Samsung', 'Galaxy Z Fold5', 2023, 8, 'samsung galaxy z fold5 z5', 'Galaxy Z · generation Z5 · RAM 12GB (not stored: the catalogue has no RAM field) · source https://www.samsung.com/ae/support/mobile-devices/what-is-the-z-fold5-and-z-flip5-external-memory-limit-and-memory-sizes/', array['256GB','512GB','1TB']::text[], array[17,33,65]::int[], array['Icy Blue','Phantom Black','Cream','Blue','Gray']::text[]),
    ('Samsung', 'Galaxy Z Flip5', 2023, 7, 'samsung galaxy z flip5 z5', 'Galaxy Z · generation Z5 · RAM 8GB (not stored: the catalogue has no RAM field) · source https://www.samsung.com/ae/smartphones/galaxy-z/galaxy-z-flip5-graphite-256gb-sm-f731bzaamea/', array['256GB','512GB']::text[], array[17,33]::int[], array['Mint','Graphite','Cream','Lavender','Blue','Gray','Green','Yellow']::text[]),
    ('Samsung', 'Galaxy Z Fold6', 2024, 6, 'samsung galaxy z fold6 z6', 'Galaxy Z · generation Z6 · RAM 12GB (not stored: the catalogue has no RAM field) · source https://www.samsung.com/ae/smartphones/galaxy-z-fold6/specs/', array['256GB','512GB','1TB']::text[], array[17,33,65]::int[], array['Silver Shadow','Pink','Navy','Crafted Black','White']::text[]),
    ('Samsung', 'Galaxy Z Flip6', 2024, 5, 'samsung galaxy z flip6 z6', 'Galaxy Z · generation Z6 · RAM 12GB (not stored: the catalogue has no RAM field) · source https://www.samsung.com/ae/smartphones/galaxy-z-flip6/specs/', array['256GB','512GB']::text[], array[17,33]::int[], array['Silver Shadow','Yellow','Blue','Mint','Crafted Black','White','Peach']::text[]),
    ('Samsung', 'Galaxy Z Fold7', 2025, 4, 'samsung galaxy z fold7 z7', 'Galaxy Z · generation Z7 · RAM 12GB (not stored: the catalogue has no RAM field) · source https://www.samsung.com/ae/smartphones/galaxy-z-fold7/specs/', array['256GB','512GB','1TB']::text[], array[17,33,65]::int[], array['Blue Shadow','Silver Shadow','Jetblack','Mint']::text[]),
    ('Samsung', 'Galaxy Z Flip7', 2025, 3, 'samsung galaxy z flip7 z7', 'Galaxy Z · generation Z7 · RAM 12GB (not stored: the catalogue has no RAM field) · source https://www.samsung.com/ae/smartphones/galaxy-z-flip7/specs/', array['256GB','512GB']::text[], array[17,33]::int[], array['Blue Shadow','Jetblack','Coralred','Mint']::text[]),
    ('Samsung', 'Galaxy Z Fold8', 2026, 2, 'samsung galaxy z fold8 z8', 'Galaxy Z · generation Z8 · RAM 12GB / 16GB (not stored: the catalogue has no RAM field) · source https://www.samsung.com/ae/smartphones/galaxy-z-fold8/buy/ · storage/colours from the owner catalogue file 2026-10-10, not independently re-verified', array['256GB','512GB','1TB']::text[], array[17,33,65]::int[], array['Lavender','Graphite','Cream','Pistachio']::text[]),
    ('Samsung', 'Galaxy Z Flip8', 2026, 1, 'samsung galaxy z flip8 z8', 'Galaxy Z · generation Z8 · RAM 12GB (not stored: the catalogue has no RAM field) · source https://www.samsung.com/ae/smartphones/galaxy-z-flip8/buy/ · storage/colours from the owner catalogue file 2026-10-10, not independently re-verified', array['256GB','512GB']::text[], array[17,33]::int[], array['Pink','Graphite','Cream','Mint']::text[])
  ) as t(brand, model, yr, ord, kw, note, storages, sorders, colors) loop
    select id into bid from public.brands where lower(btrim(name)) = lower(r.brand);
    select id into pid from public.products where brand_id = bid and lower(btrim(model)) = lower(r.model);
    if pid is null then
      pid := 'PRD-' || lpad(app.next_counter('PRD', 0)::text, 5, '0');
      insert into public.products (id, brand_id, category_id, model, device_type, release_year, search_keywords, active, display_order, notes)
        values (pid, bid, cat, r.model, 'SMARTPHONE', r.yr, r.kw, true, r.ord, r.note);
      n_prod := n_prod + 1;
    else d_prod := d_prod + 1; end if;
    for s in 1 .. array_length(r.storages, 1) loop
      if exists (select 1 from public.product_variants where product_id = pid and lower(storage) = lower(r.storages[s])) then d_var := d_var + 1;
      else
        insert into public.product_variants (id, product_id, storage, active, display_order)
          values ('VAR-' || lpad(app.next_counter('VAR', 0)::text, 6, '0'), pid, r.storages[s], true, r.sorders[s]);
        n_var := n_var + 1;
      end if;
    end loop;
    for s in 1 .. array_length(r.colors, 1) loop
      if exists (select 1 from public.product_colors where product_id = pid and lower(btrim(color)) = lower(r.colors[s])) then d_col := d_col + 1;
      else
        insert into public.product_colors (id, product_id, color, active, display_order)
          values ('CLR-' || lpad(app.next_counter('CLR', 0)::text, 6, '0'), pid, r.colors[s], true, s);
        n_col := n_col + 1;
      end if;
    end loop;
  end loop;
  insert into public.audit_logs (actor_id, actor_name, actor_role, action, object_type, object_id, details)
    values ('SYSTEM', 'Operator (owner request)', 'SYSTEM', 'CATALOGUE_IMPORTED', 'CATALOGUE', 'catalogue_2026-10-10',
      jsonb_build_object('productsInserted', n_prod, 'variantsInserted', n_var, 'coloursInserted', n_col,
                         'productsSkipped', d_prod, 'variantsSkipped', d_var, 'coloursSkipped', d_col));
  raise notice 'products +% (skipped %), variants +% (skipped %), colours +% (skipped %)', n_prod, d_prod, n_var, d_var, n_col, d_col;
end $$;
select details from public.audit_logs where action = 'CATALOGUE_IMPORTED' order by occurred_at desc limit 1;
