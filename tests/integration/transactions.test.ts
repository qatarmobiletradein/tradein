/**
 * Transactions, concurrency, idempotency, rollback and state machines.
 * Concurrent requests are REAL concurrent transactions (Promise.all over
 * separate pool connections) against PostgreSQL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '../../packages/database/src/db.js';
import { HAS_DB } from '../helpers/db.js';
import { GOOD_ANSWERS, createTestApp, idemKey, makeImei, type TestApp } from '../helpers/app.js';
import { actors, inspectAndOffer, ok, submit, toReadyForCollection, tradeIn, type Actors } from '../helpers/flow.js';

describe.skipIf(!HAS_DB)('transactions, concurrency and idempotency', () => {
  let t: TestApp; let a: Actors; let customer2: string;
  beforeAll(async () => {
    t = await createTestApp();
    a = await actors(t);
    await t.deps.pool.query(`insert into public.customers (id, full_name, phone) values ('CUS-00003', 'Third Demo Customer', '+97433000023')`);
    customer2 = await t.tokenFor('CUS-00003');
  });
  afterAll(async () => { await t?.close(); });

  const submitParams = (imei: string) => ({ vendorId: 'VND-001', branchId: 'BR-0001', variantId: 'VAR-000001', imei, conditionAnswers: GOOD_ANSWERS });

  it('duplicate IMEI: a second open trade-in for the same device is refused', async () => {
    const s = await submit(t, a.customer);
    const r = await t.call('customer.submitTradeIn', customer2, submitParams(s.imei), idemKey());
    expect(r.status).toBe(422);
    expect(r.body.message).toBe('There is already an open trade-in for this device.');
  });

  it('duplicate IMEI under CONCURRENT creation: exactly one succeeds', async () => {
    const imei = makeImei('86');
    const results = await Promise.all([
      t.call('customer.submitTradeIn', a.customer, submitParams(imei), idemKey()),
      t.call('customer.submitTradeIn', customer2, submitParams(imei), idemKey()),
      t.call('customer.submitTradeIn', a.customer, submitParams(imei), idemKey()),
      t.call('customer.submitTradeIn', customer2, submitParams(imei), idemKey()),
    ]);
    expect(results.filter((r) => r.status === 200).length).toBe(1);
    for (const r of results.filter((x) => x.status !== 200)) expect(r.body.message).toBe('There is already an open trade-in for this device.');
    expect((await t.deps.pool.query('select count(*)::int as n from public.trade_ins where imei = $1', [imei])).rows[0].n).toBe(1);
  });

  it('idempotent retry returns the ORIGINAL result and creates nothing new', async () => {
    const key = idemKey();
    const imei = makeImei('01');
    const first = await t.call('customer.submitTradeIn', a.customer, submitParams(imei), key);
    const second = await t.call('customer.submitTradeIn', a.customer, submitParams(imei), key);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.tradeInId).toBe(first.body.tradeInId);
    expect(second.body.replayed).toBe(true);
    expect((await t.deps.pool.query('select count(*)::int as n from public.trade_ins where imei = $1', [imei])).rows[0].n).toBe(1);
    // Concurrent duplicates with the same key also execute once.
    const key2 = idemKey(); const imei2 = makeImei('01');
    const both = await Promise.all([1, 2, 3].map(() => t.call('customer.submitTradeIn', a.customer, submitParams(imei2), key2)));
    expect(new Set(both.map((r) => r.body.tradeInId)).size).toBe(1);
    expect((await t.deps.pool.query('select count(*)::int as n from public.trade_ins where imei = $1', [imei2])).rows[0].n).toBe(1);
  });

  it('the same key with a DIFFERENT payload is refused (409) and audited', async () => {
    // The key is bound to principal + action + target (here the IMEI, as in 3.1) + payload hash.
    const key = idemKey();
    const imei = makeImei('02');
    await ok(t.call('customer.submitTradeIn', a.customer, submitParams(imei), key));
    const r = await t.call('customer.submitTradeIn', a.customer, { ...submitParams(imei), branchId: 'BR-0002' }, key);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await t.deps.pool.query(`select 1 from public.audit_logs where object_id = 'idempotency.keyReused'`)).rowCount).toBe(1);
  });

  it('a malformed key is refused before anything runs', async () => {
    const r = await t.call('customer.submitTradeIn', a.customer, submitParams(makeImei('04')), 'short');
    expect(r.status).toBe(400);
  });

  it('a failed attempt stores nothing, so a retry with the same key can succeed', async () => {
    const s = await submit(t, a.customer);
    const key = idemKey();
    const early = await t.call('customer.acceptOffer', a.customer, { tradeInId: s.tradeInId }, key);
    expect(early.status).toBe(422);                       // no offer yet
    await inspectAndOffer(t, a.tech, s.tradeInId, s.imei);
    const retry = await t.call('customer.acceptOffer', a.customer, { tradeInId: s.tradeInId }, key);
    expect(retry.status).toBe(200);
    expect(retry.body.replayed).toBeUndefined();
  });

  it('duplicate voucher: concurrent issue requests produce exactly one live voucher', async () => {
    const s = await submit(t, a.customer);
    await inspectAndOffer(t, a.tech, s.tradeInId, s.imei);
    await ok(t.call('customer.acceptOffer', a.customer, { tradeInId: s.tradeInId }, idemKey()));
    await ok(t.call('tech.receiveDevice', a.tech, { tradeInId: s.tradeInId }, idemKey()));
    const res = await Promise.all([a.partnerAdmin, a.mgrMall, a.partnerAdmin, a.mgrMall].map((tok) =>
      t.call('vendor.issueVoucher', tok, { tradeInId: s.tradeInId }, idemKey())));
    expect(res.filter((r) => r.status === 200).length).toBe(1);
    const live = await t.deps.pool.query(`select count(*)::int as n from public.vouchers where trade_in_id = $1 and status = 'ISSUED'`, [s.tradeInId]);
    expect(live.rows[0].n).toBe(1);
    // The database itself refuses a second live voucher.
    const v = (await t.deps.pool.query(`select * from public.vouchers where trade_in_id = $1`, [s.tradeInId])).rows[0];
    await expect(t.deps.pool.query(
      `insert into public.vouchers (id, trade_in_id, vendor_id, branch_id, voucher_number, customer_value, commission_value, total_settlement)
       values ('VCH-999999', $1, $2, $3, 'X-1', $4, $5, $6)`, [s.tradeInId, v.vendor_id, v.branch_id, v.customer_value, v.commission_value, v.total_settlement]))
      .rejects.toThrow(/vouchers_one_live_per_tradein/);
  });

  it('no voucher before the device is received (gate audited)', async () => {
    const s = await submit(t, a.customer);
    await inspectAndOffer(t, a.tech, s.tradeInId, s.imei);
    await ok(t.call('customer.acceptOffer', a.customer, { tradeInId: s.tradeInId }, idemKey()));
    const r = await t.call('vendor.issueVoucher', a.partnerAdmin, { tradeInId: s.tradeInId }, idemKey());
    expect(r.status).toBe(422);
    expect((await t.deps.pool.query(`select 1 from public.audit_logs where action = 'VOUCHER_BLOCKED_NO_DEVICE' and object_id = $1`, [s.tradeInId])).rowCount).toBe(1);
  });

  it('void + reissue: one transaction, chain linked both ways, device released from the open note', async () => {
    const r = await toReadyForCollection(t, a, { branchId: 'BR-0002', issuer: a.staffSouq });
    const batch = await ok(t.call('admin.createBatch', a.finance, { vendorId: 'VND-001', branchId: 'BR-0002' }, idemKey()));
    const re = await ok(t.call('vendor.voidVoucher', a.partnerAdmin, { voucherId: r.voucherId, reason: 'Printed with a typo', reissue: true }, idemKey()));
    const old = (await t.deps.pool.query('select * from public.vouchers where id = $1', [r.voucherId])).rows[0];
    expect(old.status).toBe('VOIDED');
    expect(old.replaced_by_voucher_id).toBe(re.voucherId);
    const nu = (await t.deps.pool.query('select * from public.vouchers where id = $1', [re.voucherId])).rows[0];
    expect(nu.replaces_voucher_id).toBe(r.voucherId);
    expect(nu.customer_value).toBe(old.customer_value);
    const line = (await t.deps.pool.query('select item_status, exception_reason from public.collection_items where batch_id = $1', [batch.batchId])).rows[0];
    expect(line.item_status).toBe('EXCEPTION');
    const ti = await tradeIn(t, r.tradeInId);
    expect(ti.status).toBe('READY_FOR_COLLECTION');
    expect(ti.voucher_id).toBe(re.voucherId);
    expect(ti.collection_batch_id).toBeNull();
    // Voiding needs partner management: plain staff are refused by role.
    expect((await t.call('vendor.voidVoucher', a.staffSouq, { voucherId: re.voucherId, reason: 'x' }, idemKey())).status).toBe(403);
  });

  it('duplicate collection: concurrent note creation claims each device once', async () => {
    await toReadyForCollection(t, a, { branchId: 'BR-0002', issuer: a.staffSouq });
    const res = await Promise.all([1, 2, 3].map(() => t.call('admin.createBatch', a.finance, { vendorId: 'VND-001', branchId: 'BR-0002' }, idemKey())));
    const okRes = res.filter((r) => r.status === 200);
    expect(okRes.length).toBe(1);
    const dup = await t.deps.pool.query(`select trade_in_id, count(*)::int as n from public.collection_items where item_status = 'PENDING' group by trade_in_id having count(*) > 1`);
    expect(dup.rowCount).toBe(0);
  });

  it('duplicate settlement: concurrent creation for the same period claims each device once', async () => {
    await toReadyForCollection(t, a);
    const b = await ok(t.call('admin.createBatch', a.finance, { vendorId: 'VND-001', branchId: 'BR-0001' }, idemKey()));
    await ok(t.call('admin.updateBatch', a.finance, { batchId: b.batchId }, idemKey()));
    const res = await Promise.all([1, 2, 3].map(() => t.call('admin.createSettlement', a.finance, { vendorId: 'VND-001', from: '2026-01-01', to: '2030-12-31' }, idemKey())));
    expect(res.filter((r) => r.status === 200).length).toBe(1);
    for (const r of res.filter((x) => x.status !== 200)) expect(r.body.message).toBe('There is nothing collected and unsettled in that period.');
    const totals = await t.deps.pool.query(`select s.id, s.trade_in_count, (select count(*)::int from public.trade_ins t where t.settlement_id = s.id) as claimed from public.settlements s`);
    for (const r of totals.rows) expect(r.trade_in_count).toBe(r.claimed);
  });

  it('invalid transitions are refused by the API and, independently, by the database', async () => {
    const s = await submit(t, a.customer);
    const r = await t.call('tech.receiveDevice', a.tech, { tradeInId: s.tradeInId }, idemKey());
    expect(r.status).toBe(422);
    await expect(t.deps.pool.query(`update public.trade_ins set status = 'COLLECTED', device_received = true where id = $1`, [s.tradeInId]))
      .rejects.toThrow(/invalid trade-in transition/);
    // A money change after a voucher exists is refused by the database.
    const v = await toReadyForCollection(t, a);
    await expect(t.deps.pool.query(`update public.trade_ins set final_customer_value = 1, commission_value = 0, total_settlement = 1 where id = $1`, [v.tradeInId]))
      .rejects.toThrow(/live voucher/);
    // Settlement flow cannot skip approval (the previous test left a DRAFT settlement).
    expect((await t.deps.pool.query(`select 1 from public.settlements where status = 'DRAFT'`)).rowCount).toBeGreaterThan(0);
    await expect(t.deps.pool.query(`update public.settlements set status = 'PAID', paid_at = now(), payment_reference = 'X', approved_by = 'x', approved_at = now() where status = 'DRAFT'`))
      .rejects.toThrow(/invalid settlement transition/);
  });

  it('rollback on failure: nothing from a failed request survives', async () => {
    // (a) the transaction helper itself
    await expect(withTransaction(t.deps.pool, async (tx) => {
      await tx.query(`insert into public.brands (id, name) values ('BRD-900', 'Rolled Back Brand')`);
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect((await t.deps.pool.query(`select 1 from public.brands where id = 'BRD-900'`)).rowCount).toBe(0);

    // (b) a request that fails part-way: the second photo's storage write fails after the first photo row was inserted.
    const s = await submit(t, a.customer);
    await ok(t.call('tech.openInspection', a.tech, { tradeInId: s.tradeInId }));
    const png = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]).toString('base64')}`;
    const original = t.storage.upload.bind(t.storage);
    let n = 0;
    t.storage.upload = async (...args) => { n++; if (n === 2) throw new Error('storage down'); return original(...args); };
    const r = await t.call('tech.uploadPhotos', a.tech, { tradeInId: s.tradeInId, photos: [{ category: 'FRONT', dataUrl: png }, { category: 'BACK', dataUrl: png }] });
    t.storage.upload = original;
    expect(r.status).toBe(500);
    expect(r.body.message).toBe('Something went wrong. Please try again.');
    expect((await t.deps.pool.query('select count(*)::int as n from public.inspection_photos where trade_in_id = $1', [s.tradeInId])).rows[0].n).toBe(0);
    expect((await t.deps.pool.query(`select count(*)::int as n from public.audit_logs where object_id = $1 and action = 'PHOTOS_UPLOADED'`, [s.tradeInId])).rows[0].n).toBe(0);
  });

  it('a blocked device stays INSPECTION_COMPLETED while its offer is refused (3.1 two-step behaviour)', async () => {
    const s = await submit(t, a.customer);
    const { ALL_GOOD_TECH_ANSWERS } = await import('../helpers/flow.js');
    await ok(t.call('tech.openInspection', a.tech, { tradeInId: s.tradeInId }));
    await ok(t.call('tech.checkImei', a.tech, { tradeInId: s.tradeInId, scannedImei: s.imei }));
    await ok(t.call('tech.saveInspection', a.tech, { tradeInId: s.tradeInId, answers: { ...ALL_GOOD_TECH_ANSWERS, ACTIVATION_LOCK: false }, batteryHealth: 95 }));
    const r = await t.call('tech.submitOffer', a.tech, { tradeInId: s.tradeInId }, idemKey());
    expect(r.status).toBe(422);
    expect(String(r.body.message)).toContain('activation lock');
    const row = await tradeIn(t, s.tradeInId);
    expect(row.status).toBe('INSPECTION_COMPLETED');
    expect(row.final_customer_value).toBeNull();
  });
});
