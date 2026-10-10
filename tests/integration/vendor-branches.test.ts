/**
 * Customer flow (owner decision 2026-10-10): the customer chooses the partner first, then a branch
 * of that partner. The branch list is filtered on the server, and a trade-in for a branch of another
 * partner is refused on creation.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HAS_DB } from '../helpers/db.js';
import { createTestApp, idemKey, makeImei, GOOD_ANSWERS, type TestApp } from '../helpers/app.js';

describe.skipIf(!HAS_DB)('partner → branch selection', () => {
  let t: TestApp;
  let customer = '';
  beforeAll(async () => {
    t = await createTestApp();
    await t.deps.pool.query(`insert into public.vendors (id, name, code, status) values ('VND-090', 'Other Partner (test)', 'OTHR', 'ACTIVE'), ('VND-091', 'Closed Partner (test)', 'CLSD', 'INACTIVE')`);
    await t.deps.pool.query(`insert into public.branches (id, vendor_id, name, active, display_order) values
      ('BR-0090', 'VND-090', 'Other Branch A', true, 1), ('BR-0091', 'VND-090', 'Other Branch B (closed)', false, 2), ('BR-0092', 'VND-091', 'Closed Partner Branch', true, 1)`);
    customer = await t.tokenFor('CUS-00001');
  });
  afterAll(async () => { await t?.close(); });

  it('lists only the chosen partner\'s ACTIVE branches (server-filtered), via the action and the GET route', async () => {
    const a = await t.call('public.vendorBranches', null, { vendorId: 'VND-001' });
    expect(a.status).toBe(200);
    expect((a.body.branches as { branchId: string; vendorId: string }[]).map((b) => b.branchId).sort()).toEqual(['BR-0001', 'BR-0002']);
    expect((a.body.branches as { vendorId: string }[]).every((b) => b.vendorId === 'VND-001')).toBe(true);
    const g = await t.app.inject({ method: 'GET', url: '/v1/public/vendor-branches?vendorId=VND-090' });
    expect(g.statusCode).toBe(200);
    expect(g.json().branches.map((b: { branchId: string }) => b.branchId)).toEqual(['BR-0090']); // the closed branch is not listed
  });

  it('an inactive or unknown partner, or a malformed id, gets no branches', async () => {
    for (const vendorId of ['VND-091', 'VND-999', "VND-001' or '1'='1", '']) {
      const r = await t.call('public.vendorBranches', null, { vendorId });
      expect(r.status, vendorId).toBe(422);
      expect(r.body.branches).toBeUndefined();
    }
  });

  it('a trade-in for a branch of ANOTHER partner is refused; the matching pair is accepted', async () => {
    const bad = await t.call('customer.submitTradeIn', customer, {
      vendorId: 'VND-001', branchId: 'BR-0090', variantId: 'VAR-000001', colorId: 'CLR-000001', imei: makeImei(), conditionAnswers: GOOD_ANSWERS,
    }, idemKey());
    expect(bad.status).toBe(422);
    expect(bad.body.ok).toBe(false);
    const good = await t.call('customer.submitTradeIn', customer, {
      vendorId: 'VND-001', branchId: 'BR-0001', variantId: 'VAR-000001', colorId: 'CLR-000001', imei: makeImei(), conditionAnswers: GOOD_ANSWERS,
    }, idemKey());
    expect(good.status, JSON.stringify(good.body)).toBe(200);
  });
});
