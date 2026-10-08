/**
 * The catalogue (09_Catalog.gs): brands, categories, products, storage
 * variants, colours, images and the two-step bulk import.
 *
 * Nothing is deleted: a product taken off sale is active=false. Names are
 * unique case-insensitively (database indexes back the checks). Image
 * links must be https; uploaded images go to the PUBLIC catalog-media
 * bucket after byte-level validation.
 */
import { ACTIONS, DEVICE_TYPES, MEDIA } from '../../../../packages/domain/src/constants.js';
import { gradeLadderFor } from '../../../../packages/domain/src/grading.js';
import { fail } from '../../../../packages/shared/src/errors.js';
import { centsToNumber, toCents } from '../../../../packages/shared/src/money.js';
import { safeHttpsUrl, slugify, storageOrder, trim, truthy } from '../../../../packages/shared/src/text.js';
import type { Queryable } from '../../../../packages/database/src/db.js';
import type { Ctx } from '../context.js';
import { audit } from '../lib/audit.js';
import { nextId } from '../lib/ids.js';
import { loadGradeLadder } from '../lib/rules.js';
import { objectName, validateImage } from '../lib/storage.js';
import { setBasePrice } from './pricing.js';
import { updateById } from './sql.js';

const active = (v: unknown) => (v === undefined ? true : truthy(v));

/** validateImageUrlInput_: undefined = leave alone; '' = clear; otherwise a full https link. */
function imageUrlInput(url: unknown): string | null | undefined {
  if (url === undefined) return undefined;
  const s = trim(url);
  if (!s) return null;
  if (!/^https:\/\//i.test(s) || !safeHttpsUrl(s) || /[\s"'<>\\]/.test(s)) throw fail('Image links must be a full https:// address.');
  return s;
}

/** catalogTree_: price-free on purpose; products without an active variant are omitted. */
export async function catalogTree(db: Queryable) {
  const brands = (await db.query<{ id: string; name: string; slug: string | null; logo_url: string | null }>(
    'select id, name, slug, logo_url from public.brands where active order by display_order, name')).rows
    .map((b) => ({ brandId: b.id, name: b.name, slug: b.slug ?? '', logoUrl: safeHttpsUrl(b.logo_url) }));
  const categories = (await db.query<{ id: string; name: string; slug: string | null; parent_category_id: string | null; image_url: string | null; icon_url: string | null; description: string | null }>(
    'select id, name, slug, parent_category_id, image_url, icon_url, description from public.categories where active order by display_order, name')).rows
    .map((c) => ({ categoryId: c.id, name: c.name, slug: c.slug ?? '', parentCategoryId: c.parent_category_id ?? '',
      imageUrl: safeHttpsUrl(c.image_url), iconUrl: safeHttpsUrl(c.icon_url), description: c.description ?? '' }));
  const variants = (await db.query<{ id: string; product_id: string; storage: string }>(
    'select id, product_id, storage from public.product_variants where active order by display_order, storage')).rows;
  const colors = (await db.query<{ id: string; product_id: string; color: string; image_url: string | null }>(
    'select id, product_id, color, image_url from public.product_colors where active order by display_order, color')).rows;
  const products = (await db.query<{ id: string; brand_id: string; category_id: string | null; model: string; model_code: string | null; device_type: string | null; release_year: number | null; main_image_url: string | null; search_keywords: string | null }>(
    `select p.id, p.brand_id, p.category_id, p.model, p.model_code, p.device_type, p.release_year, p.main_image_url, p.search_keywords
       from public.products p join public.brands b on b.id = p.brand_id
      where p.active and b.active order by p.display_order, p.model`)).rows
    .map((p) => ({
      productId: p.id, brandId: p.brand_id, categoryId: p.category_id ?? '', model: p.model, modelCode: p.model_code ?? '',
      deviceType: p.device_type ?? '', releaseYear: p.release_year || null, imageUrl: safeHttpsUrl(p.main_image_url), keywords: p.search_keywords ?? '',
      variants: variants.filter((v) => v.product_id === p.id).map((v) => ({ variantId: v.id, storage: v.storage })),
      colors: colors.filter((c) => c.product_id === p.id).map((c) => ({ colorId: c.id, color: c.color, imageUrl: safeHttpsUrl(c.image_url) })),
    }))
    .filter((p) => p.variants.length > 0);
  return { brands, categories, products };
}

export async function saveBrand(ctx: Ctx, d: { brandId?: string; name?: string; slug?: string; active?: unknown; displayOrder?: unknown; logoUrl?: unknown }) {
  const name = trim(d.name);
  if (name.length < 2) throw fail('Enter the brand name.');
  const existing = d.brandId ? (await ctx.db.query<{ id: string; name: string }>('select id, name from public.brands where id = $1 for update', [d.brandId])).rows[0] : undefined;
  if (d.brandId && !existing) throw fail('That brand does not exist.');
  const clash = await ctx.db.query('select 1 from public.brands where lower(btrim(name)) = lower($1) and id <> coalesce($2, \'\')', [name, existing?.id ?? null]);
  if (clash.rowCount) throw fail('A brand with that name already exists.');
  const row: Record<string, unknown> = { name, slug: slugify(d.slug || name), active: active(d.active), display_order: Number(d.displayOrder) || 99 };
  const logo = imageUrlInput(d.logoUrl);
  if (logo !== undefined) row.logo_url = logo;
  if (existing) {
    await updateById(ctx.db, 'brands', existing.id, row);
    await audit(ctx, ACTIONS.BRAND_UPDATED, 'BRAND', existing.id, { oldValue: existing.name, newValue: name });
    return { ok: true, brandId: existing.id, message: 'Brand saved.' };
  }
  const id = await nextId(ctx.db, 'BRD');
  await ctx.db.query('insert into public.brands (id, name, slug, logo_url, active, display_order) values ($1,$2,$3,$4,$5,$6)',
    [id, name, row.slug, logo ?? null, row.active, row.display_order]);
  await audit(ctx, ACTIONS.BRAND_CREATED, 'BRAND', id, { newValue: name });
  return { ok: true, brandId: id, message: 'Brand created.' };
}

export async function saveCategory(ctx: Ctx, d: { categoryId?: string; name?: string; slug?: string; parentCategoryId?: string; description?: string; active?: unknown; displayOrder?: unknown; imageUrl?: unknown; iconUrl?: unknown }) {
  const name = trim(d.name);
  if (name.length < 2) throw fail('Enter the category name.');
  const existing = d.categoryId ? (await ctx.db.query<{ id: string; name: string }>('select id, name from public.categories where id = $1 for update', [d.categoryId])).rows[0] : undefined;
  if (d.categoryId && !existing) throw fail('That category does not exist.');
  const parentId = trim(d.parentCategoryId) || null;
  if (parentId) {
    if (existing && parentId === existing.id) throw fail('A category cannot be its own parent.');
    let walker: string | null = parentId; let guard = 0;
    while (walker && guard++ < 20) {
      if (existing && walker === existing.id) throw fail('That would make the category a parent of itself.');
      const w: { parent_category_id: string | null } | undefined = (await ctx.db.query<{ parent_category_id: string | null }>('select parent_category_id from public.categories where id = $1', [walker])).rows[0];
      if (!w && walker === parentId) throw fail('That parent category does not exist.');
      walker = w?.parent_category_id ?? null;
    }
  }
  const row: Record<string, unknown> = { name, slug: slugify(d.slug || name), parent_category_id: parentId, description: trim(d.description) || null,
    active: active(d.active), display_order: Number(d.displayOrder) || 99 };
  const img = imageUrlInput(d.imageUrl); const icon = imageUrlInput(d.iconUrl);
  if (img !== undefined) row.image_url = img;
  if (icon !== undefined) row.icon_url = icon;
  if (existing) {
    await updateById(ctx.db, 'categories', existing.id, row);
    await audit(ctx, ACTIONS.CATEGORY_UPDATED, 'CATEGORY', existing.id, { oldValue: existing.name, newValue: name });
    return { ok: true, categoryId: existing.id, message: 'Category saved.' };
  }
  const id = await nextId(ctx.db, 'CAT');
  await ctx.db.query(`insert into public.categories (id, name, slug, parent_category_id, description, active, display_order, image_url, icon_url)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, name, row.slug, parentId, row.description, row.active, row.display_order, img ?? null, icon ?? null]);
  await audit(ctx, ACTIONS.CATEGORY_CREATED, 'CATEGORY', id, { newValue: name });
  return { ok: true, categoryId: id, message: 'Category created.' };
}

export async function saveProduct(ctx: Ctx, d: { productId?: string; brandId?: string; categoryId?: string; model?: string; modelCode?: string; deviceType?: string; releaseYear?: unknown; keywords?: string; active?: unknown; displayOrder?: unknown; notes?: string; imageUrl?: unknown }) {
  const model = trim(d.model);
  if (model.length < 2) throw fail('Enter the model name.');
  const brandId = trim(d.brandId);
  if (!(await ctx.db.query('select 1 from public.brands where id = $1', [brandId])).rowCount) throw fail('Choose a brand.');
  const categoryId = trim(d.categoryId) || null;
  if (categoryId && !(await ctx.db.query('select 1 from public.categories where id = $1', [categoryId])).rowCount) throw fail('That category does not exist.');
  const existing = d.productId ? (await ctx.db.query<{ id: string; model: string }>('select id, model from public.products where id = $1 for update', [d.productId])).rows[0] : undefined;
  if (d.productId && !existing) throw fail('That product does not exist.');
  const clash = await ctx.db.query(`select 1 from public.products where brand_id = $1 and lower(btrim(model)) = lower($2) and id <> coalesce($3, '')`, [brandId, model, existing?.id ?? null]);
  if (clash.rowCount) throw fail('That brand already has a model with this name.');
  const deviceType = trim(d.deviceType).toUpperCase() || null;
  if (deviceType && !DEVICE_TYPES.some((t) => t.value === deviceType)) throw fail('That is not a device type.');
  const year = Number(d.releaseYear);
  const row: Record<string, unknown> = {
    brand_id: brandId, category_id: categoryId, model, model_code: trim(d.modelCode) || null, device_type: deviceType,
    release_year: Number.isInteger(year) && year >= 1990 && year <= 2100 ? year : null, search_keywords: trim(d.keywords) || null,
    active: active(d.active), display_order: Number(d.displayOrder) || 99, notes: trim(d.notes) || null,
  };
  const img = imageUrlInput(d.imageUrl);
  if (img !== undefined) row.main_image_url = img;
  if (existing) {
    await updateById(ctx.db, 'products', existing.id, row);
    await audit(ctx, ACTIONS.PRODUCT_UPDATED, 'PRODUCT', existing.id, { oldValue: existing.model, newValue: model });
    return { ok: true, productId: existing.id, message: 'Product saved.' };
  }
  const id = await nextId(ctx.db, 'PRD');
  await ctx.db.query(`insert into public.products (id, brand_id, category_id, model, model_code, device_type, release_year, search_keywords, active, display_order, notes, main_image_url)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [id, brandId, categoryId, model, row.model_code, deviceType, row.release_year, row.search_keywords, row.active, row.display_order, row.notes, img ?? null]);
  await audit(ctx, ACTIONS.PRODUCT_CREATED, 'PRODUCT', id, { newValue: model });
  return { ok: true, productId: id, message: 'Product created.' };
}

export async function saveVariant(ctx: Ctx, d: { variantId?: string; productId?: string; storage?: string; active?: unknown; displayOrder?: unknown }) {
  const productId = trim(d.productId);
  if (!(await ctx.db.query('select 1 from public.products where id = $1', [productId])).rowCount) throw fail('That product does not exist.');
  const storage = trim(d.storage).toUpperCase().replace(/\s+/g, '');
  if (!storage) throw fail('Enter the storage size, such as 256GB.');
  const existing = d.variantId ? (await ctx.db.query<{ id: string; storage: string; product_id: string }>('select id, storage, product_id from public.product_variants where id = $1 for update', [d.variantId])).rows[0] : undefined;
  if (d.variantId && !existing) throw fail('That variant does not exist.');
  const clash = await ctx.db.query(`select 1 from public.product_variants where product_id = $1 and lower(storage) = lower($2) and id <> coalesce($3, '')`, [productId, storage, existing?.id ?? null]);
  if (clash.rowCount) throw fail('That storage size already exists for this product.');
  const order = Number(d.displayOrder) || storageOrder(storage);
  if (existing) {
    if (existing.product_id !== productId) throw fail('A variant cannot be moved to another product.');
    await updateById(ctx.db, 'product_variants', existing.id, { storage, active: active(d.active), display_order: order });
    await audit(ctx, ACTIONS.VARIANT_UPDATED, 'VARIANT', existing.id, { oldValue: existing.storage, newValue: storage });
    return { ok: true, variantId: existing.id, message: 'Variant saved.' };
  }
  const id = await nextId(ctx.db, 'VAR');
  await ctx.db.query('insert into public.product_variants (id, product_id, storage, active, display_order) values ($1,$2,$3,$4,$5)', [id, productId, storage, active(d.active), order]);
  await audit(ctx, ACTIONS.VARIANT_CREATED, 'VARIANT', id, { newValue: storage, details: { note: 'No price yet. This variant cannot be quoted until one is set.' } });
  return { ok: true, variantId: id, message: 'Variant created. It has no price yet, so it cannot be quoted.' };
}

export async function saveColor(ctx: Ctx, d: { colorId?: string; productId?: string; color?: string; active?: unknown; displayOrder?: unknown; imageUrl?: unknown }) {
  const productId = trim(d.productId);
  if (!(await ctx.db.query('select 1 from public.products where id = $1', [productId])).rowCount) throw fail('That product does not exist.');
  const color = trim(d.color);
  if (!color) throw fail('Enter the colour name.');
  const existing = d.colorId ? (await ctx.db.query<{ id: string; color: string; product_id: string }>('select id, color, product_id from public.product_colors where id = $1 for update', [d.colorId])).rows[0] : undefined;
  if (d.colorId && !existing) throw fail('That colour does not exist.');
  const clash = await ctx.db.query(`select 1 from public.product_colors where product_id = $1 and lower(btrim(color)) = lower($2) and id <> coalesce($3, '')`, [productId, color, existing?.id ?? null]);
  if (clash.rowCount) throw fail('That colour already exists for this product.');
  const img = imageUrlInput(d.imageUrl);
  const row: Record<string, unknown> = { color, active: active(d.active), display_order: Number(d.displayOrder) || 99 };
  if (img !== undefined) row.image_url = img;
  if (existing) {
    if (existing.product_id !== productId) throw fail('A colour cannot be moved to another product.');
    await updateById(ctx.db, 'product_colors', existing.id, row);
    await audit(ctx, ACTIONS.COLOR_UPDATED, 'COLOR', existing.id, { oldValue: existing.color, newValue: color });
    return { ok: true, colorId: existing.id, message: 'Colour saved.' };
  }
  const id = await nextId(ctx.db, 'CLR');
  await ctx.db.query('insert into public.product_colors (id, product_id, color, image_url, active, display_order) values ($1,$2,$3,$4,$5,$6)',
    [id, productId, color, img ?? null, row.active, row.display_order]);
  await audit(ctx, ACTIONS.COLOR_CREATED, 'COLOR', id, { newValue: color });
  return { ok: true, colorId: id, message: 'Colour created.' };
}

/** admin.uploadMedia / admin.uploadVendorLogo: public images, bytes validated, stored in catalog-media. */
export async function uploadMedia(ctx: Ctx, p: { kind?: string; objectId?: string; dataUrl?: string }) {
  const kind = trim(p.kind).toUpperCase();
  const objectId = trim(p.objectId);
  const table = kind === 'BRAND' ? 'brands' : kind === 'COLOR' ? 'product_colors' : kind === 'CATEGORY' ? 'categories' : kind === 'VENDOR' ? 'vendors' : 'products';
  const column = kind === 'BRAND' || kind === 'VENDOR' ? 'logo_url' : kind === 'PRODUCT' || !kind ? 'main_image_url' : 'image_url';
  const exists = await ctx.db.query(`select 1 from public.${table} where id = $1 for update`, [objectId]);
  if (!exists.rowCount) throw fail('That item does not exist.');
  const img = validateImage(p.dataUrl, MEDIA.MAX_IMAGE_BYTES);
  const path = objectName(`${table}/${objectId}`, img.ext);
  await ctx.deps.storage.upload('catalog-media', path, img.bytes, img.mime);
  const url = ctx.deps.storage.publicUrl('catalog-media', path);
  await updateById(ctx.db, table, objectId, { [column]: url });
  await audit(ctx, ACTIONS.MEDIA_UPLOADED, kind || 'PRODUCT', objectId, { details: { kind: column, path, sha256: img.sha256 } });
  return { ok: true, imageUrl: url, logoUrl: url, message: 'Image updated.' };
}

/* --------------------------------------------------------------- import */

export interface ImportRow { brand: string; category: string; model: string; storage: string; color: string; basePrice: number | null }

/** previewCatalogImport_: validate and describe; writes nothing. */
export async function previewImport(ctx: Ctx, p: { rows?: Record<string, unknown>[] }) {
  const valid: ImportRow[] = []; const problems: string[] = [];
  const newBrands = new Set<string>(); const newProducts = new Set<string>();
  let variantCount = 0;
  for (const [i, r] of (p.rows ?? []).entries()) {
    const line = i + 2;
    const brand = trim(r.Brand ?? r.brand); const model = trim(r.Model ?? r.model);
    const storage = trim(r.Storage ?? r.storage).toUpperCase().replace(/\s+/g, '');
    if (!brand || !model) { problems.push(`Line ${line}: brand and model are both required.`); continue; }
    if (!storage) { problems.push(`Line ${line}: ${model} has no storage size.`); continue; }
    const rawPrice = r.BasePrice ?? r.basePrice;
    let price: number | null = null;
    if (rawPrice !== '' && rawPrice !== undefined && rawPrice !== null) {
      try { price = centsToNumber(toCents(rawPrice)); } catch { price = NaN; }
      if (!Number.isFinite(price) || price < 0) { problems.push(`Line ${line}: "${String(rawPrice)}" is not a price.`); continue; }
    }
    const b = (await ctx.db.query<{ id: string }>('select id from public.brands where lower(btrim(name)) = lower($1)', [brand])).rows[0];
    if (!b) newBrands.add(brand);
    const prod = b ? (await ctx.db.query('select 1 from public.products where brand_id = $1 and lower(btrim(model)) = lower($2)', [b.id, model])).rowCount : 0;
    if (!prod) newProducts.add(`${brand} ${model}`);
    variantCount++;
    valid.push({ brand, category: trim(r.Category ?? r.category), model, storage, color: trim(r.Colour ?? r.Color ?? r.color), basePrice: price });
  }
  return { ok: true, willImport: valid.length, newBrands: [...newBrands], newProducts: [...newProducts], variantCount, problems, rows: valid };
}

/** applyCatalogImport_: write what the preview described; unpriced rows are counted, not hidden. */
export async function applyImport(ctx: Ctx, p: { rows?: Record<string, unknown>[] }) {
  // Re-validate on the server: the rows come back from the browser.
  const preview = await previewImport(ctx, { rows: (p.rows ?? []).map((r) => ({ ...r, Brand: r.brand ?? r.Brand, Model: r.model ?? r.Model, Storage: r.storage ?? r.Storage, BasePrice: r.basePrice ?? r.BasePrice, Category: r.category ?? r.Category, Colour: r.color ?? r.Colour })) });
  if (preview.problems.length) throw fail(`The import has ${preview.problems.length} problem(s). Preview it again and fix them first.`);
  const made = { brands: 0, categories: 0, products: 0, variants: 0, colors: 0, prices: 0, unpriced: 0 };
  for (const r of preview.rows) {
    let brand = (await ctx.db.query<{ id: string }>('select id from public.brands where lower(btrim(name)) = lower($1)', [r.brand])).rows[0];
    if (!brand) { brand = { id: (await saveBrand(ctx, { name: r.brand })).brandId }; made.brands++; }
    let categoryId: string | null = null;
    if (r.category) {
      const c = (await ctx.db.query<{ id: string }>('select id from public.categories where lower(btrim(name)) = lower($1)', [r.category])).rows[0];
      categoryId = c?.id ?? (await saveCategory(ctx, { name: r.category })).categoryId;
      if (!c) made.categories++;
    }
    let product = (await ctx.db.query<{ id: string }>('select id from public.products where brand_id = $1 and lower(btrim(model)) = lower($2)', [brand.id, r.model])).rows[0];
    if (!product) {
      product = { id: (await saveProduct(ctx, { brandId: brand.id, categoryId: categoryId ?? undefined, model: r.model, keywords: `${r.brand} ${r.model}`, notes: 'Imported.' })).productId };
      made.products++;
    }
    let variant = (await ctx.db.query<{ id: string }>('select id from public.product_variants where product_id = $1 and lower(storage) = lower($2)', [product.id, r.storage])).rows[0];
    if (!variant) { variant = { id: (await saveVariant(ctx, { productId: product.id, storage: r.storage })).variantId }; made.variants++; }
    if (r.color) {
      const c = await ctx.db.query('select 1 from public.product_colors where product_id = $1 and lower(btrim(color)) = lower($2)', [product.id, r.color]);
      if (!c.rowCount) { await saveColor(ctx, { productId: product.id, color: r.color }); made.colors++; }
    }
    if (r.basePrice !== null) {
      const res = await setBasePrice(ctx, { variantId: variant.id, basePrice: r.basePrice, notes: 'Imported.' });
      if (!('unchanged' in res && res.unchanged)) made.prices++;
    } else made.unpriced++;
  }
  await audit(ctx, ACTIONS.BULK_IMPORT, 'CATALOG', 'import', { details: made });
  return { ok: true, summary: made, message: `${made.variants} variant(s) added, ${made.prices} priced, ${made.unpriced} left without a price.` };
}

/** The ladder priced out for a base (admin preview). */
export async function ladderPreview(ctx: Ctx, baseCents: number) {
  return gradeLadderFor(baseCents, await loadGradeLadder(ctx.db));
}

/* ------------------------------------------------------------ admin lists */

export async function adminBrands(ctx: Ctx) {
  const rows = (await ctx.db.query<{ id: string; name: string; slug: string | null; logo_url: string | null; active: boolean; display_order: number; n: number }>(
    `select b.*, (select count(*)::int from public.products p where p.brand_id = b.id) as n from public.brands b order by b.display_order, b.name`)).rows;
  return { ok: true, brands: rows.map((b) => ({ brandId: b.id, name: b.name, slug: b.slug ?? '', logoUrl: safeHttpsUrl(b.logo_url), active: b.active, displayOrder: b.display_order || 99, productCount: b.n })) };
}

export async function adminCategories(ctx: Ctx) {
  const rows = (await ctx.db.query<{ id: string; name: string; slug: string | null; parent_category_id: string | null; image_url: string | null; icon_url: string | null; description: string | null; active: boolean; display_order: number }>(
    'select * from public.categories order by display_order, name')).rows;
  return { ok: true, categories: rows.map((c) => ({ categoryId: c.id, name: c.name, slug: c.slug ?? '', parentCategoryId: c.parent_category_id ?? '',
    imageUrl: safeHttpsUrl(c.image_url), iconUrl: safeHttpsUrl(c.icon_url), description: c.description ?? '', active: c.active, displayOrder: c.display_order || 99 })) };
}

export async function adminProducts(ctx: Ctx, f: { brandId?: string; categoryId?: string; search?: string }) {
  const rows = (await ctx.db.query<{ id: string; brand_id: string; brand: string; category_id: string | null; category: string | null; model: string; model_code: string | null; device_type: string | null; release_year: number | null; main_image_url: string | null; active: boolean; search_keywords: string | null; variant_count: number; color_count: number; unpriced: number }>(
    `select p.*, b.name as brand, c.name as category,
       (select count(*)::int from public.product_variants v where v.product_id = p.id) as variant_count,
       (select count(*)::int from public.product_colors k where k.product_id = p.id) as color_count,
       (select count(*)::int from public.product_variants v where v.product_id = p.id and not exists (
          select 1 from public.master_prices m where m.variant_id = v.id and m.active and m.effective_from <= now() and (m.effective_to is null or m.effective_to > now()))) as unpriced
       from public.products p join public.brands b on b.id = p.brand_id left join public.categories c on c.id = p.category_id
      order by p.display_order, p.model`)).rows
    .filter((p) => (!f.brandId || p.brand_id === f.brandId) && (!f.categoryId || p.category_id === f.categoryId)
      && (!f.search || `${p.model} ${p.search_keywords ?? ''}`.toLowerCase().includes(f.search.toLowerCase())));
  return { ok: true, products: rows.map((p) => ({ productId: p.id, brandId: p.brand_id, brand: p.brand, categoryId: p.category_id ?? '', category: p.category ?? '',
    model: p.model, modelCode: p.model_code ?? '', deviceType: p.device_type ?? '', releaseYear: p.release_year || null, imageUrl: safeHttpsUrl(p.main_image_url),
    active: p.active, variantCount: p.variant_count, colorCount: p.color_count, unpricedVariants: p.unpriced })) };
}

export async function adminProduct(ctx: Ctx, p: { productId?: string }) {
  const r = (await ctx.db.query<{ id: string; brand_id: string; category_id: string | null; model: string; model_code: string | null; device_type: string | null; release_year: number | null; main_image_url: string | null; search_keywords: string | null; active: boolean; notes: string | null }>(
    'select * from public.products where id = $1', [trim(p.productId)])).rows[0];
  if (!r) throw fail('That product does not exist.');
  const ladder = await loadGradeLadder(ctx.db);
  const { resolvePrice } = await import('../lib/rules.js');
  const variants = (await ctx.db.query<{ id: string; storage: string; active: boolean }>('select id, storage, active from public.product_variants where product_id = $1 order by display_order, storage', [r.id])).rows;
  const vv = [];
  for (const v of variants) {
    const price = await resolvePrice(ctx.db, v.id, null, new Date());
    vv.push({ variantId: v.id, storage: v.storage, active: v.active, basePrice: price.ok ? centsToNumber(price.basePriceCents) : null, priced: price.ok,
      ladder: price.ok ? gradeLadderFor(price.basePriceCents, ladder).map((g) => ({ code: g.code, name: g.name, percentLabel: g.percentLabel, value: centsToNumber(g.value), terminal: g.terminal })) : [] });
  }
  const colors = (await ctx.db.query<{ id: string; color: string; image_url: string | null; active: boolean }>('select id, color, image_url, active from public.product_colors where product_id = $1 order by display_order, color', [r.id])).rows;
  return {
    ok: true,
    product: { productId: r.id, brandId: r.brand_id, categoryId: r.category_id ?? '', model: r.model, modelCode: r.model_code ?? '', deviceType: r.device_type ?? '',
      releaseYear: r.release_year || null, imageUrl: safeHttpsUrl(r.main_image_url), keywords: r.search_keywords ?? '', active: r.active, notes: r.notes ?? '' },
    deviceTypes: DEVICE_TYPES, variants: vv,
    colors: colors.map((c) => ({ colorId: c.id, color: c.color, imageUrl: safeHttpsUrl(c.image_url), active: c.active })),
  };
}
