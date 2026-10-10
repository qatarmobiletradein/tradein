/**
 * supabase/data/product_images_2026-10-10.sql + apps/web/catalog — one official image per catalogue
 * model, served by qm-web at /catalog/<file>. Idempotent; never overwrites an image set in Admin.
 */
import { existsSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HAS_DB } from '../helpers/db.js';
import { createTestApp, type TestApp } from '../helpers/app.js';

const CATALOGUE = readFileSync('supabase/data/catalogue_2026-10-10.sql', 'utf8');
const IMAGES = readFileSync('supabase/data/product_images_2026-10-10.sql', 'utf8');
const COLOUR_IMAGES = readFileSync('supabase/data/colour_images_2026-10-10.sql', 'utf8');
const COLOUR_SOURCES = JSON.parse(readFileSync('apps/web/catalog/SOURCES.json', 'utf8')).colours as Record<string, { file: string; source: string }>;
const ALL_COLOURS = (JSON.parse(readFileSync('supabase/data/catalogue_2026-10-10.json', 'utf8')) as { model: string; colors: string[] }[])
  .flatMap((m) => m.colors.map((c) => `${m.model}|${c}`));
const SOURCES = JSON.parse(readFileSync('apps/web/catalog/SOURCES.json', 'utf8')).models as Record<string, { file: string; source: string }>;
const MODELS = JSON.parse(readFileSync('supabase/data/catalogue_2026-10-10.json', 'utf8')) as { model: string }[];

describe('catalogue image files', () => {
  it('every catalogue model has one WebP file from an official manufacturer host', () => {
    expect(Object.keys(SOURCES).sort()).toEqual(MODELS.map((m) => m.model).sort());
    for (const [model, s] of Object.entries(SOURCES)) {
      expect(existsSync(`apps/web/catalog/${s.file}`), model).toBe(true);
      expect(s.file).toMatch(/^[a-z0-9-]+\.webp$/);
      expect(new URL(s.source).hostname, model).toMatch(/(^|\.)(apple\.com|cdn-apple\.com|samsung\.com)$/);
    }
  });
});

describe('colour image files', () => {
  it('each listed colour is a real catalogue colour with one WebP file from an official host; at most 9 have none', () => {
    for (const [key, s] of Object.entries(COLOUR_SOURCES)) {
      expect(ALL_COLOURS, key).toContain(key);
      expect(existsSync(`apps/web/catalog/${s.file}`), key).toBe(true);
      expect(s.file).toMatch(/^[a-z0-9-]+\.webp$/);
      expect(new URL(s.source).hostname, key).toMatch(/(^|\.)(apple\.com|cdn-apple\.com|samsung\.com)$/);
    }
    expect(ALL_COLOURS.length).toBe(252);
    expect(Object.keys(COLOUR_SOURCES).length).toBe(243);
  });
});

describe.skipIf(!HAS_DB)('product images in the catalogue', () => {
  let t: TestApp;
  beforeAll(async () => { t = await createTestApp(); await t.deps.pool.query(CATALOGUE); });
  afterAll(async () => { await t?.close(); });
  const lastAudit = async () => (await t.deps.pool.query(`select details from public.audit_logs where object_id = 'product_images_2026-10-10' order by occurred_at desc limit 1`)).rows[0].details;

  it('sets an image on every model and the public catalogue returns it', async () => {
    await t.deps.pool.query(IMAGES);
    expect(await lastAudit()).toMatchObject({ set: 48, kept: 0 });
    const tree = await t.call('public.catalogTree', null);
    const byModel = new Map((tree.body.products as { model: string; imageUrl: string }[]).map((p) => [p.model, p.imageUrl]));
    for (const [model, s] of Object.entries(SOURCES)) expect(byModel.get(model), model).toBe(`https://qmtradein.com/catalog/${s.file}`);
  });

  it('colour images: 243 colours get their image once; a colour image set in Admin is kept', async () => {
    await t.deps.pool.query(COLOUR_IMAGES);
    const a = (await t.deps.pool.query(`select details from public.audit_logs where object_id = 'colour_images_2026-10-10' order by occurred_at desc limit 1`)).rows[0].details;
    expect(a).toMatchObject({ set: 243, kept: 0 });
    const tree = await t.call('public.catalogTree', null);
    const p = (tree.body.products as { model: string; colors: { color: string; imageUrl: string }[] }[]).find((x) => x.model === 'Galaxy S24 Ultra')!;
    expect(p.colors.find((c) => c.color === 'Titanium Violet')!.imageUrl).toBe('https://qmtradein.com/catalog/galaxy-s24-ultra--titanium-violet.webp');
    await t.deps.pool.query(`update public.product_colors set image_url = 'https://example.test/own.webp' where color = 'Titanium Violet'`);
    await t.deps.pool.query(COLOUR_IMAGES);
    const b = (await t.deps.pool.query(`select details from public.audit_logs where object_id = 'colour_images_2026-10-10' order by occurred_at desc limit 1`)).rows[0].details;
    expect(b).toMatchObject({ set: 0, kept: 243 });
  });

  it('a rerun changes nothing and keeps an image set later in Admin', async () => {
    await t.deps.pool.query(`update public.products set main_image_url = 'https://example.test/own.webp' where model = 'iPhone 15'`);
    await t.deps.pool.query(IMAGES);
    expect(await lastAudit()).toMatchObject({ set: 0, kept: 48 });
    const own = (await t.deps.pool.query(`select main_image_url from public.products where model = 'iPhone 15'`)).rows[0].main_image_url;
    expect(own).toBe('https://example.test/own.webp');
  });
});
