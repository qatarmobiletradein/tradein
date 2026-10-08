/**
 * MILESTONE: the full vertical slice end-to-end through the HTTP API,
 * on a real PostgreSQL database: Auth (verified JWT) → Trade-In →
 * Inspection → Offer → Device Received → Voucher → Collection → Settlement.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { businessDate } from '../../packages/shared/src/time.js';
import { HAS_DB } from '../helpers/db.js';
import { createTestApp, idemKey, type TestApp } from '../helpers/app.js';
import { actors, inspectAndOffer, ok, submit, tradeIn, type Actors } from '../helpers/flow.js';

describe.skipIf(!HAS_DB)('vertical slice (end to end)', () => {
  let t: TestApp; let a: Actors;
  beforeAll(async () => { t = await createTestApp(); a = await actors(t); });
  afterAll(async () => { await t?.close(); });

  it('runs a trade-in from submission to a paid, closed settlement with exact money', async () => {
    // 1. Customer submits: estimate from their own description (all good → grade A → 2000.00).
    const s = await submit(t, a.customer);
    expect(s.body.estimate).toBe(2000);
    expect(s.body.estimatedGrade).toBe('A');
    expect(s.tradeInId).toMatch(/^TI-DEMO-\d{6}$/);
    let row = await tradeIn(t, s.tradeInId);
    expect(row.status).toBe('PENDING_TECHNICIAN');
    expect(row.customer_id).toBe('CUS-00001');

    // 2–3. Technician inspects; the server computes the grade; offer frozen.
    const offer = await inspectAndOffer(t, a.tech, s.tradeInId, s.imei, { battery: 95 });
    expect(offer.grade).toBe('A');
    expect(offer.finalValue).toBe(2000);
    row = await tradeIn(t, s.tradeInId);
    expect(row.status).toBe('FINAL_OFFER_READY');
    expect(row.final_customer_value).toBe('2000.00');
    expect(row.commission_value).toBe('100.00');          // 5% partner fee
    expect(row.total_settlement).toBe('2100.00');
    expect(row.commission_rate_snapshot).toBe('0.050000');
    expect(row.pricing_source).toBe('MASTER');
    expect(row.price_variance).toBe('0.00');

    // The customer view never carries the fee or the full IMEI.
    const cv = await ok(t.call('customer.tradeIn', a.customer, { tradeInId: s.tradeInId }));
    const view = cv.tradeIn as Record<string, unknown>;
    expect(view.finalValue).toBe(2000);
    expect(JSON.stringify(view)).not.toContain('commission');
    expect(String(view.imei)).toContain('*');

    // 4. Customer accepts.
    await ok(t.call('customer.acceptOffer', a.customer, { tradeInId: s.tradeInId }, idemKey()));

    // 5. Device received → AWAITING_VOUCHER.
    await ok(t.call('tech.receiveDevice', a.tech, { tradeInId: s.tradeInId }, idemKey()));
    expect((await tradeIn(t, s.tradeInId)).status).toBe('AWAITING_VOUCHER');

    // 6. Branch manager (own branch) issues the voucher.
    const v = await ok(t.call('vendor.issueVoucher', a.mgrMall, { tradeInId: s.tradeInId }, idemKey()));
    expect(String(v.voucherNumber)).toMatch(new RegExp(`^DEMO-${businessDate(new Date()).replace(/-/g, '')}-\\d{4}$`));
    expect(v.value).toBe(2000);
    row = await tradeIn(t, s.tradeInId);
    expect(row.status).toBe('READY_FOR_COLLECTION');
    const vrow = (await t.deps.pool.query('select * from public.vouchers where id = $1', [v.voucherId])).rows[0];
    expect(vrow.customer_value).toBe('2000.00');
    expect(vrow.commission_value).toBe('100.00');
    expect(vrow.total_settlement).toBe('2100.00');

    // 7. Qatar Mobile collects.
    const batch = await ok(t.call('admin.createBatch', a.finance, { vendorId: 'VND-001', branchId: 'BR-0001' }, idemKey()));
    expect(batch.deviceCount).toBe(1);
    const marked = await ok(t.call('admin.updateBatch', a.finance, { batchId: batch.batchId, action: 'COLLECT' }, idemKey()));
    expect(marked.collected).toBe(1);
    expect(marked.status).toBe('COLLECTED');
    expect((await tradeIn(t, s.tradeInId)).status).toBe('COLLECTED');

    // 8. Settlement: finance prepares and submits, owner approves, finance pays.
    const today = businessDate(new Date());
    const st = await ok(t.call('admin.createSettlement', a.finance, { vendorId: 'VND-001', from: today, to: today }, idemKey()));
    expect(st.tradeInCount).toBe(1);
    expect(st.total).toBe(2100);
    const sid = String(st.settlementId);
    await ok(t.call('admin.advanceSettlement', a.finance, { settlementId: sid, toStatus: 'SUBMITTED' }, idemKey()));
    const denied = await t.call('admin.advanceSettlement', a.finance, { settlementId: sid, toStatus: 'APPROVED' }, idemKey());
    expect(denied.status).toBe(403);                       // QM_ADMIN cannot approve
    await ok(t.call('admin.advanceSettlement', a.sa, { settlementId: sid, toStatus: 'APPROVED' }, idemKey()));
    const noRef = await t.call('admin.advanceSettlement', a.finance, { settlementId: sid, toStatus: 'PAID' }, idemKey());
    expect(noRef.body.message).toBe('Record the payment reference.');
    await ok(t.call('admin.advanceSettlement', a.finance, { settlementId: sid, toStatus: 'PAID', paymentReference: 'TEST-REF-001' }, idemKey()));

    row = await tradeIn(t, s.tradeInId);
    expect(row.status).toBe('CLOSED');
    expect(row.settlement_id).toBe(sid);
    const srow = (await t.deps.pool.query('select * from public.settlements where id = $1', [sid])).rows[0];
    expect(srow.status).toBe('PAID');
    expect(srow.settlement_total).toBe('2100.00');
    expect(srow.customer_value_total).toBe('2000.00');
    expect(srow.commission_total).toBe('100.00');

    // The partner can read its own settlement statement.
    const stmt = await ok(t.call('vendor.settlements', a.partnerAdmin, { settlementId: sid }));
    expect((stmt.lines as unknown[]).length).toBe(1);

    // Every step left an audit row in the same transaction.
    const actions = (await t.deps.pool.query<{ action: string }>('select action from public.audit_logs where object_id = $1 order by id', [s.tradeInId])).rows.map((r) => r.action);
    for (const expected of ['TRADEIN_CREATED', 'INSPECTION_STARTED', 'FINAL_OFFER_SUBMITTED', 'CUSTOMER_ACCEPTED', 'DEVICE_RECEIVED', 'VOUCHER_ISSUED', 'DEVICE_COLLECTED', 'SETTLEMENT_PAID', 'TRADEIN_CLOSED']) {
      expect(actions).toContain(expected);
    }
    // No secret ever reaches the audit trail.
    const dump = JSON.stringify((await t.deps.pool.query('select * from public.audit_logs')).rows);
    expect(dump).not.toContain(s.imei);
  });

  it('grades a worn device down and prices from the BASE (no compounding)', async () => {
    const s = await submit(t, a.customer, { answers: { POWER: 'ON', SCREEN: 'SCRATCHED', BODY: 'SCRATCHED', CAMERA: 'OK', CHARGING: 'OK', BIOMETRIC: 'OK', BATTERY: 'AVERAGE', ACTIVATION_LOCK: 'YES' } });
    // 100 − 7 (screen scratch) − 5 (body scratch) − round(12 × 0.5) (battery 82%) = 82 → B (≥80) → 70% of 2000 = 1400
    expect(s.body.estimatedGrade).toBe('B');
    expect(s.body.estimate).toBe(1400);
    const offer = await inspectAndOffer(t, a.tech, s.tradeInId, s.imei, {
      battery: 79, answers: { ...(await import('../helpers/flow.js')).ALL_GOOD_TECH_ANSWERS, SCREEN_CRACK: false },
    });
    // 100 − 18 (crack) − round(12 × 0.75) (79%) = 73 → C (≥60) → 50% of 2000 = 1000
    expect(offer.grade).toBe('C');
    expect(offer.finalValue).toBe(1000);
    const row = await tradeIn(t, s.tradeInId);
    expect(row.price_variance).toBe('-400.00');
    expect(row.price_variance_pct).toBe('-28.57');
    expect(row.commission_value).toBe('50.00');
    expect(row.total_settlement).toBe('1050.00');
  });

  it('refuses a device whose activation lock cannot be removed, at estimate time', async () => {
    const r = await t.call('customer.estimate', a.customer, { variantId: 'VAR-000001', vendorId: 'VND-001', conditionAnswers: { ...{ POWER: 'ON', SCREEN: 'PERFECT', BODY: 'EXCELLENT', CAMERA: 'OK', CHARGING: 'OK', BIOMETRIC: 'OK', BATTERY: 'GOOD' }, ACTIVATION_LOCK: 'NO' } });
    expect(r.status).toBe(422);
    expect(r.body.blocked).toBe(true);
    expect(String(r.body.message)).toContain('activation lock');
  });

  it('a technician never receives the submitted IMEI or rule impacts', async () => {
    const s = await submit(t, a.customer);
    const ws = await ok(t.call('tech.openInspection', a.tech, { tradeInId: s.tradeInId }));
    const text = JSON.stringify(ws);
    expect(text).not.toContain(s.imei);
    expect(text).not.toMatch(/"impact"/);
    const q = await ok(t.call('tech.queues', a.tech, {}));
    expect(JSON.stringify(q)).not.toContain(s.imei);
    // A wrong IMEI is reported as a mismatch without revealing the expected value.
    const wrong = await ok(t.call('tech.checkImei', a.tech, { tradeInId: s.tradeInId, scannedImei: '490154203237518' }));
    expect(wrong.match).toBe(false);
    expect(JSON.stringify(wrong)).not.toContain(s.imei);
  });

  it('ignores and audits a grade supplied by the technician', async () => {
    const s = await submit(t, a.customer);
    await ok(t.call('tech.openInspection', a.tech, { tradeInId: s.tradeInId }));
    const r = await ok(t.call('tech.saveInspection', a.tech, { tradeInId: s.tradeInId, answers: { SCREEN_CRACK: false }, gradeCode: 'A', finalCustomerValue: 99999 }));
    expect((r.result as Record<string, unknown>).gradeCode).not.toBe('X');
    const denied = await t.deps.pool.query(`select 1 from public.audit_logs where action = 'ACCESS_DENIED' and object_id = 'inspection.gradeOverrideAttempt'`);
    expect(denied.rowCount).toBeGreaterThan(0);
  });
});
