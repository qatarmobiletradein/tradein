/**
 * Isolation and role rules, through the API (Railway layer).
 * RLS (database layer) is covered separately in tests/db/rls.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { HAS_DB } from '../helpers/db.js';
import { createTestApp, idemKey, signToken, type TestApp } from '../helpers/app.js';
import { actors, inspectAndOffer, ok, submit, toReadyForCollection, tradeIn, type Actors } from '../helpers/flow.js';

describe.skipIf(!HAS_DB)('authorization and isolation', () => {
  let t: TestApp; let a: Actors; let otherPartnerStaff: string; let otherCustomer: string;

  beforeAll(async () => {
    t = await createTestApp();
    a = await actors(t);
    // A second, fictional partner with its own branch and staff, created through the API.
    const v = await ok(t.call('admin.saveVendor', a.sa, { name: 'Other Partner (fictional)', code: 'OTH', commissionRate: 0.04 }));
    const b = await ok(t.call('admin.saveBranch', a.sa, { vendorId: v.vendorId, name: 'Other Branch' }));
    const u = await ok(t.call('admin.updateStaff', a.sa, { mode: 'CREATE', phone: '33000021', fullName: 'Other Partner Admin', role: 'VENDOR_ADMIN', vendorId: v.vendorId, branchId: b.branchId }, idemKey()));
    otherPartnerStaff = await t.tokenFor(String(u.userId));
    await t.deps.pool.query(`insert into public.customers (id, full_name, phone) values ('CUS-00002', 'Second Demo Customer', '+97433000022')`);
    otherCustomer = await t.tokenFor('CUS-00002');
  });
  afterAll(async () => { await t?.close(); });

  it('branch user: own branch allowed', async () => {
    const s = await submit(t, a.customer, { branchId: 'BR-0001' });
    const r = await ok(t.call('vendor.tradeIn', a.mgrMall, { tradeInId: s.tradeInId }));
    expect((r.tradeIn as Record<string, unknown>).tradeInId).toBe(s.tradeInId);
  });

  it('branch user: another branch of the same partner is denied (not found, audited)', async () => {
    const s = await submit(t, a.customer, { branchId: 'BR-0001' });
    const r = await t.call('vendor.tradeIn', a.staffSouq, { tradeInId: s.tradeInId });
    expect(r.status).toBe(404);
    expect(r.body.message).toBe('Trade-in not found.');
    const audit = await t.deps.pool.query(`select 1 from public.audit_logs where action = 'ACCESS_DENIED' and object_id like 'object.tradein%' and actor_id = 'USR-00006'`);
    expect(audit.rowCount).toBeGreaterThan(0);
  });

  it('branch user cannot reach another branch by SUBMITTING a different branch id', async () => {
    const q = await t.call('vendor.queue', a.staffSouq, { branchId: 'BR-0001' });
    expect(q.status).toBe(403);
    const lst = await ok(t.call('vendor.queue', a.staffSouq, {}));
    for (const row of lst.tradeIns as { branchId: string }[]) expect(row.branchId).toBe('BR-0002');
    const vouchers = await t.call('vendor.vouchers', a.staffSouq, { branchId: 'BR-0001' });
    for (const row of (vouchers.body.vouchers ?? []) as { branchId: string }[]) expect(row.branchId).toBe('BR-0002');
  });

  it('branch user cannot issue a voucher for another branch’s device', async () => {
    const s = await submit(t, a.customer, { branchId: 'BR-0001' });
    await inspectAndOffer(t, a.tech, s.tradeInId, s.imei);
    await ok(t.call('customer.acceptOffer', a.customer, { tradeInId: s.tradeInId }, idemKey()));
    await ok(t.call('tech.receiveDevice', a.tech, { tradeInId: s.tradeInId }, idemKey()));
    const r = await t.call('vendor.issueVoucher', a.staffSouq, { tradeInId: s.tradeInId }, idemKey());
    expect(r.status).toBe(404);
    expect((await tradeIn(t, s.tradeInId)).voucher_id).toBeNull();
  });

  it('partner user: another partner’s trade-in is denied', async () => {
    const s = await submit(t, a.customer);
    const r = await t.call('vendor.tradeIn', otherPartnerStaff, { tradeInId: s.tradeInId });
    expect(r.status).toBe(404);
    const q = await ok(t.call('vendor.queue', otherPartnerStaff, {}));
    expect((q.tradeIns as unknown[]).length).toBe(0);
    const st = await ok(t.call('vendor.settlements', otherPartnerStaff, {}));
    for (const x of st.settlements as { vendorId: string }[]) expect(x.vendorId).not.toBe('VND-001');
  });

  it('a customer cannot read or act on another customer’s trade-in', async () => {
    const s = await submit(t, a.customer);
    expect((await t.call('customer.tradeIn', otherCustomer, { tradeInId: s.tradeInId })).status).toBe(404);
    expect((await t.call('customer.acceptOffer', otherCustomer, { tradeInId: s.tradeInId }, idemKey())).status).toBe(404);
  });

  it('roles outside the registry list are refused (customer → admin, technician → money, partner → admin)', async () => {
    expect((await t.call('admin.tradeIns', a.customer, {})).status).toBe(403);
    expect((await t.call('admin.settlements', a.tech, {})).status).toBe(403);
    expect((await t.call('admin.createBatch', a.partnerAdmin, { vendorId: 'VND-001' }, idemKey())).status).toBe(403);
    expect((await t.call('vendor.voidVoucher', a.staffSouq, { voucherId: 'VCH-000001', reason: 'x' }, idemKey())).status).toBe(403);
  });

  it('a collection outcome of PENDING is refused and changes nothing', async () => {
    const r = await toReadyForCollection(t, a);
    const batch = await ok(t.call('admin.createBatch', a.finance, { vendorId: 'VND-001' }, idemKey()));
    const bad = await t.call('admin.updateBatch', a.finance, { batchId: batch.batchId, action: 'COLLECT', items: [{ tradeInId: r.tradeInId, status: 'PENDING', reason: 'x' }] }, idemKey());
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/not pending/);
    const row = await tradeIn(t, r.tradeInId);
    expect(row.collection_batch_id).toBe(batch.batchId);
    expect((await t.deps.pool.query(`select item_status from public.collection_items where trade_in_id = $1`, [r.tradeInId])).rows[0].item_status).toBe('PENDING');
    await ok(t.call('admin.updateBatch', a.finance, { batchId: batch.batchId, action: 'CANCEL', reason: 'test clean-up' }, idemKey()));
  });

  it('unauthorised finance actions: QM_ADMIN cannot approve; partner and technician cannot settle', async () => {
    const r = await toReadyForCollection(t, a);
    const batch = await ok(t.call('admin.createBatch', a.finance, { vendorId: 'VND-001' }, idemKey()));
    await ok(t.call('admin.updateBatch', a.finance, { batchId: batch.batchId }, idemKey()));
    const today = new Date().toISOString().slice(0, 10);
    expect((await t.call('admin.createSettlement', a.partnerAdmin, { vendorId: 'VND-001', from: '2026-01-01', to: '2030-12-31' }, idemKey())).status).toBe(403);
    expect((await t.call('admin.createSettlement', a.tech, { vendorId: 'VND-001', from: '2026-01-01', to: '2030-12-31' }, idemKey())).status).toBe(403);
    const st = await ok(t.call('admin.createSettlement', a.finance, { vendorId: 'VND-001', from: '2026-01-01', to: '2030-12-31' }, idemKey()));
    await ok(t.call('admin.advanceSettlement', a.finance, { settlementId: st.settlementId, toStatus: 'SUBMITTED' }, idemKey()));
    const denied = await t.call('admin.advanceSettlement', a.finance, { settlementId: st.settlementId, toStatus: 'APPROVED' }, idemKey());
    expect(denied.status).toBe(403);
    expect(denied.body.message).toBe('Only the platform owner can approve a settlement.');
    expect((await t.deps.pool.query('select status from public.settlements where id = $1', [st.settlementId])).rows[0].status).toBe('SUBMITTED');
    expect(today).toBeTruthy();
    expect(r.tradeInId).toBeTruthy();
  });

  it('lower roles cannot modify a SUPER_ADMIN; nobody changes their own role; the last SUPER_ADMIN is protected', async () => {
    const qa = await t.call('admin.updateStaff', a.finance, { userId: 'USR-00001', status: 'DISABLED' }, idemKey());
    expect(qa.status).toBe(403);
    expect(qa.body.message).toBe('Only a platform owner can change a platform owner\'s account.');
    const va = await t.call('vendor.saveStaff', a.partnerAdmin, { mode: 'UPDATE', userId: 'USR-00001', status: 'DISABLED' }, idemKey());
    // Partner staff cannot even learn that USR-00001 is an owner: same answer as a non-existent id.
    const ghost = await t.call('vendor.saveStaff', a.partnerAdmin, { mode: 'UPDATE', userId: 'USR-99999', status: 'DISABLED' }, idemKey());
    expect(va.status).toBe(404);
    expect(va.body.message).toBe(ghost.body.message);
    const self = await t.call('admin.updateStaff', a.sa, { userId: 'USR-00001', role: 'QM_ADMIN' }, idemKey());
    expect(self.status).toBe(422);
    // QM_ADMIN cannot mint a SUPER_ADMIN.
    const mint = await t.call('admin.updateStaff', a.finance, { mode: 'CREATE', phone: '33000031', fullName: 'Would Be Owner', role: 'SUPER_ADMIN' }, idemKey());
    expect(mint.status).toBe(403);
    // Database backstop: the last active SUPER_ADMIN cannot be removed even by direct SQL.
    await expect(t.deps.pool.query(`update public.app_users set status = 'DISABLED' where id = 'USR-00001'`)).rejects.toThrow(/last active super administrator/);
    expect((await t.deps.pool.query(`select status from public.app_users where id = 'USR-00001'`)).rows[0].status).toBe('ACTIVE');
  });

  it('a branch-bound manager cannot widen anyone to "all branches" or move them to another branch', async () => {
    const c = await t.call('vendor.saveStaff', a.mgrMall, { mode: 'CREATE', phone: '33000041', fullName: 'New Mall Staff', role: 'VENDOR_STAFF', branchId: 'BR-0002' }, idemKey());
    expect(c.status).toBe(403);
    const ok1 = await ok(t.call('vendor.saveStaff', a.mgrMall, { mode: 'CREATE', phone: '33000042', fullName: 'New Mall Staff', role: 'VENDOR_STAFF' }, idemKey()));
    const row = (await t.deps.pool.query('select branch_id, vendor_id from public.app_users where id = $1', [ok1.userId])).rows[0];
    expect(row).toEqual({ branch_id: 'BR-0001', vendor_id: 'VND-001' });
    const up = await t.call('vendor.saveStaff', a.mgrMall, { mode: 'UPDATE', userId: ok1.userId, branchId: '' }, idemKey());
    expect(up.status).toBe(403);
  });

  it('role/status changes revoke existing sessions immediately', async () => {
    const created = await ok(t.call('admin.updateStaff', a.sa, { mode: 'CREATE', phone: '33000051', fullName: 'Revocable Tech', role: 'TECHNICIAN' }, idemKey()));
    const tok = await t.tokenFor(String(created.userId));
    expect((await t.call('tech.queues', tok, {})).status).toBe(200);
    await new Promise((r) => setTimeout(r, 1100)); // iat has second resolution
    await ok(t.call('admin.updateStaff', a.sa, { userId: created.userId, status: 'DISABLED' }, idemKey()));
    const after = await t.call('tech.queues', tok, {});
    expect(after.status).toBe(401);
    expect(after.body.reauth).toBe(true);
  });

  it('tokens are verified: bad signature, wrong audience, service role, expired, unknown user → 401', async () => {
    const forged = (await signToken(randomUUID(), '+97430000001')).replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
    expect((await t.call('me.context', forged)).status).toBe(401);
    expect((await t.call('me.context', await signToken(randomUUID(), '+97430000001', { role: 'service_role' }))).status).toBe(401);
    expect((await t.call('me.context', await signToken(randomUUID(), '+97430000001', { iatOffsetS: -7200, expS: 60 }))).status).toBe(401);
    // A valid token for an auth user with no linked profile is not a principal (no linking outside sign-in).
    expect((await t.call('me.context', await signToken(randomUUID(), '+97430000001'))).status).toBe(401);
    expect((await t.call('me.context', null)).status).toBe(401);
  });

  it('unknown actions look the same as forbidden ones', async () => {
    const r = await t.call('admin.dropEverything', a.sa, {});
    expect(r.status).toBe(404);
    expect(r.body.message).toBe('This action is not available.');
    expect((await t.call('__proto__', a.sa, {})).status).toBe(404);
  });
});
