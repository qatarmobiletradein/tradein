/**
 * supabase/data/prices_provisional_2026-10-10.sql — provisional (estimated, NOT market-verified)
 * master prices for the 140 Apple/Samsung storage variants. Idempotent; grade ladder unchanged.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HAS_DB } from '../helpers/db.js';
import { createTestApp, GOOD_ANSWERS, type TestApp } from '../helpers/app.js';

const CATALOGUE = readFileSync('supabase/data/catalogue_2026-10-10.sql', 'utf8');
const PRICES = readFileSync('supabase/data/prices_provisional_2026-10-10.sql', 'utf8');
const ROWS = JSON.parse(readFileSync('supabase/data/prices_provisional_2026-10-10.json', 'utf8')) as { model: string; storage: string; base_price: number }[];

describe.skipIf(!HAS_DB)('provisional master prices', () => {
  let t: TestApp;
  beforeAll(async () => { t = await createTestApp(); await t.deps.pool.query(CATALOGUE); });
  afterAll(async () => { await t?.close(); });
  const priced = async () => Number((await t.deps.pool.query(`select count(*) from public.master_prices m join public.products p on p.id = m.product_id
    join public.brands b on b.id = p.brand_id where b.name in ('Apple','Samsung') and m.active`)).rows[0].count);
  const lastAudit = async () => (await t.deps.pool.query(`select details from public.audit_logs where object_id = 'prices_provisional_2026-10-10' order by occurred_at desc limit 1`)).rows[0].details;

  it('prices every catalogue variant once, marked provisional', async () => {
    expect(ROWS).toHaveLength(140);
    await t.deps.pool.query(PRICES);
    expect(await priced()).toBe(140);
    expect(await lastAudit()).toMatchObject({ inserted: 140, skipped: 0, provisional: true });
    const notes = (await t.deps.pool.query(`select distinct m.created_by, m.notes like 'Provisional estimate%' as marked from public.master_prices m
      join public.products p on p.id = m.product_id join public.brands b on b.id = p.brand_id where b.name in ('Apple','Samsung')`)).rows;
    expect(notes).toEqual([{ created_by: 'SYSTEM', marked: true }]);
  });

  it('a rerun inserts nothing and does not overwrite a price the owner has changed', async () => {
    await t.deps.pool.query(`update public.master_prices set base_price = 1234 where variant_id = (select v.id from public.product_variants v
      join public.products p on p.id = v.product_id where p.model = 'iPhone 15' and v.storage = '128GB')`);
    await t.deps.pool.query(PRICES);
    expect(await priced()).toBe(140);
    expect(await lastAudit()).toMatchObject({ inserted: 0, skipped: 140 });
    const kept = (await t.deps.pool.query(`select base_price from public.master_prices m join public.product_variants v on v.id = m.variant_id
      join public.products p on p.id = v.product_id where p.model = 'iPhone 15' and v.storage = '128GB' and m.active`)).rows[0];
    expect(Number(kept.base_price)).toBe(1234);
  });

  it('a customer now gets an estimate on the unchanged grade ladder', async () => {
    const want = ROWS.find((r) => r.model === 'Galaxy S24 Ultra' && r.storage === '256GB')!;
    const v = (await t.deps.pool.query(`select v.id from public.product_variants v join public.products p on p.id = v.product_id
      where p.model = 'Galaxy S24 Ultra' and v.storage = '256GB'`)).rows[0].id as string;
    const r = await t.call('customer.estimate', await t.tokenFor('CUS-00001'), { variantId: v, conditionAnswers: GOOD_ANSWERS });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const body = JSON.stringify(r.body);
    expect(body).toContain(String(want.base_price));
    const ladder = (await t.deps.pool.query(`select grade_code, percentage_of_base::text p from public.grade_rules order by display_order`)).rows;
    expect(ladder.map((g) => `${g.grade_code}:${g.p}`)).toEqual(['A:1.0000', 'B:0.7000', 'C:0.5000', 'D:0.3000', 'R:0.0000']);
  });
});
