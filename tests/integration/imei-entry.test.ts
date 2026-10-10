/**
 * IMEI entry, server side (2026-10-10): the API stays authoritative for the format, the check digit and
 * the one-open-trade-in-per-device rule, whatever the browser did (typed or scanned).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HAS_DB } from '../helpers/db.js';
import { GOOD_ANSWERS, createTestApp, idemKey, makeImei, type TestApp } from '../helpers/app.js';
import { actors, ok, submit, type Actors } from '../helpers/flow.js';

describe.skipIf(!HAS_DB)('IMEI entry: server-side validation and duplicates', () => {
  let t: TestApp; let a: Actors;
  beforeAll(async () => { t = await createTestApp(); a = await actors(t); });
  afterAll(async () => { await t?.close(); });
  const create = (imei: string) => t.call('customer.submitTradeIn', a.customer, {
    vendorId: 'VND-001', branchId: 'BR-0001', variantId: 'VAR-000001', colorId: 'CLR-000001', imei, conditionAnswers: GOOD_ANSWERS,
  }, idemKey());

  it('a typed or scanned IMEI with the printed grouping is stored as 15 digits', async () => {
    const d = makeImei();
    const grouped = `${d.slice(0, 2)} ${d.slice(2, 8)} ${d.slice(8, 14)} ${d.slice(14)}`;
    const r = await ok(create(grouped));
    expect((await t.deps.pool.query('select imei from public.trade_ins where id = $1', [r.tradeInId])).rows[0].imei).toBe(d);
  });

  it('malformed values are refused: letters, wrong check digit, too short, too long', async () => {
    const d = makeImei();
    const wrongCheck = d.slice(0, 14) + String((Number(d[14]) + 1) % 10);
    for (const bad of [`${d.slice(0, 14)}A`, `IMEI${d}`, wrongCheck, d.slice(0, 14), `${d}0`]) {
      const r = await create(bad);
      expect([bad, r.status]).toEqual([bad, 422]);
    }
  });

  it('a duplicate IMEI is still refused by the API, however it was entered', async () => {
    const s = await submit(t, a.customer);
    const again = await create(`${s.imei.slice(0, 2)} ${s.imei.slice(2, 8)} ${s.imei.slice(8, 14)} ${s.imei.slice(14)}`);
    expect(again.status).toBe(422);
    expect(String(again.body.message)).toMatch(/already an open trade-in/);
  });

  it('the technician check refuses letters instead of stripping them', async () => {
    const s = await submit(t, a.customer);
    await ok(t.call('tech.openInspection', a.tech, { tradeInId: s.tradeInId }));
    const r = await t.call('tech.checkImei', a.tech, { tradeInId: s.tradeInId, scannedImei: `${s.imei.slice(0, 7)}X${s.imei.slice(7)}` });
    expect(r.status).toBe(422);
    const okr = await ok(t.call('tech.checkImei', a.tech, { tradeInId: s.tradeInId, scannedImei: `${s.imei.slice(0, 2)} ${s.imei.slice(2)}` }));
    expect(okr.match).toBe(true);
  });
});
