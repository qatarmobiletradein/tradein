/**
 * Partner commission as a share of the INVOICE (owner decision 2026-10-10): for Carrefour -> QM invoices
 * the invoice is the trade-in value / 0.95 (1500 -> 1578.95). Saved as an INVOICE_PERCENTAGE rule; the
 * trade-in snapshot, the voucher and settlements then carry value + fee = value / (1 - rate).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HAS_DB } from '../helpers/db.js';
import { createTestApp, idemKey, type TestApp } from '../helpers/app.js';
import { actors, toReadyForCollection, type Actors } from '../helpers/flow.js';

describe.skipIf(!HAS_DB)('INVOICE_PERCENTAGE commission rule', () => {
  let t: TestApp; let a: Actors; let admin = '';
  beforeAll(async () => { t = await createTestApp(); a = await actors(t); admin = a.finance; });
  afterAll(async () => { await t?.close(); });

  it('is saved, listed with a clear label, and refuses a share of 1 or more', async () => {
    const bad = await t.call('admin.saveCommissionRule', admin, { vendorId: 'VND-001', commissionType: 'INVOICE_PERCENTAGE', commissionValue: 1 }, idemKey());
    expect(bad.status).toBe(422);
    expect(String(bad.body.message)).toMatch(/below 1/);
    const r = await t.call('admin.saveCommissionRule', admin, { vendorId: 'VND-001', commissionType: 'INVOICE_PERCENTAGE', commissionValue: 0.05 }, idemKey());
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const list = await t.call('admin.commissionRules', admin, { vendorId: 'VND-001' });
    expect((list.body.rules as { label: string }[]).map((x) => x.label)).toContain('5% of invoice (value ÷ 0.95)');
  });

  it('an inspected trade-in for that partner is invoiced at value / 0.95 (fee = the difference)', async () => {
    const s = await toReadyForCollection(t, a);
    const row = (await t.deps.pool.query(`select final_customer_value, commission_type_snapshot, commission_value, total_settlement
      from public.trade_ins where id = $1`, [s.tradeInId])).rows[0];
    const value = Number(row.final_customer_value);
    expect(row.commission_type_snapshot).toBe('INVOICE_PERCENTAGE');
    expect(Number(row.total_settlement)).toBeCloseTo(Math.round((value / 0.95) * 100) / 100, 2);
    expect(Number(row.commission_value)).toBeCloseTo(Number(row.total_settlement) - value, 2);
    const v = (await t.deps.pool.query('select customer_value, commission_value, total_settlement from public.vouchers where trade_in_id = $1', [s.tradeInId])).rows[0];
    expect(Number(v.total_settlement)).toBe(Number(row.total_settlement));
    expect(Number(v.customer_value)).toBe(value); // the customer's voucher is unchanged
  });
});
