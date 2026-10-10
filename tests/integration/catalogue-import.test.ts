/**
 * supabase/data/catalogue_2026-10-10.sql — the real Apple / Samsung catalogue import.
 * Idempotent: a second run inserts nothing; counts match the owner's file (48 models, 140 storage
 * variants, 252 colours = 710 storage×colour combinations). Prices are not touched.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HAS_DB } from '../helpers/db.js';
import { createTestApp, type TestApp } from '../helpers/app.js';

const SQL = readFileSync('supabase/data/catalogue_2026-10-10.sql', 'utf8');
const MODELS = JSON.parse(readFileSync('supabase/data/catalogue_2026-10-10.json', 'utf8')) as { brand: string; model: string; storage: string[]; colors: string[] }[];

describe.skipIf(!HAS_DB)('catalogue import (Apple iPhone 13–18, Galaxy S22–S26, Z5–Z8)', () => {
  let t: TestApp;
  beforeAll(async () => { t = await createTestApp(); });
  afterAll(async () => { await t?.close(); });
  const counts = async () => (await t.deps.pool.query(`
    select (select count(*)::int from public.products p join public.brands b on b.id = p.brand_id where b.name in ('Apple','Samsung')) as products,
           (select count(*)::int from public.product_variants v join public.products p on p.id = v.product_id join public.brands b on b.id = p.brand_id where b.name in ('Apple','Samsung')) as variants,
           (select count(*)::int from public.product_colors c join public.products p on p.id = c.product_id join public.brands b on b.id = p.brand_id where b.name in ('Apple','Samsung')) as colours,
           (select count(*)::int from public.master_prices) as prices`)).rows[0];

  it('loads every model, storage and colour of the file, once', async () => {
    const before = await counts();
    await t.deps.pool.query(SQL);
    const after = await counts();
    expect(after).toEqual({ products: 48, variants: 140, colours: 252, prices: before.prices });
    expect(MODELS.reduce((n, m) => n + m.storage.length * m.colors.length, 0)).toBe(710);
    const tree = await t.call('public.catalogTree', null);
    const models = (tree.body.products as { model: string }[]).map((p) => p.model);
    for (const m of MODELS) expect(models).toContain(m.model);
  });

  it('is safe to rerun: the second run inserts nothing and reports everything as skipped', async () => {
    await t.deps.pool.query(SQL);
    expect(await counts()).toMatchObject({ products: 48, variants: 140, colours: 252 });
    const last = (await t.deps.pool.query(`select details from public.audit_logs where action = 'CATALOGUE_IMPORTED' order by occurred_at desc limit 1`)).rows[0].details;
    expect(last).toEqual({ productsInserted: 0, variantsInserted: 0, coloursInserted: 0, productsSkipped: 48, variantsSkipped: 140, coloursSkipped: 252 });
  });
});
