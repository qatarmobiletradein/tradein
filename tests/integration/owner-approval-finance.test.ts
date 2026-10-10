/**
 * Owner approval after the evaluation, and the accountant -> partner payment after the voucher
 * (owner decision 2026-10-10). Positive path and the refusals the brief lists, through the HTTP API,
 * plus the database's own second line of defence.
 *
 *   EVALUATED -> AWAITING_OWNER_APPROVAL -> OWNER_APPROVED (FINAL_OFFER_READY) -> ... -> VOUCHER_CREATED
 *   (READY_FOR_COLLECTION) -> PAYMENT_SENT -> VENDOR_CONFIRMED -> CLOSED
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HAS_DB } from '../helpers/db.js';
import { createTestApp, idemKey, type TestApp } from '../helpers/app.js';
import {
  RECEIPT_PDF, accountant, actors, approve, inspectAndOffer, ok, submit, toReadyForCollection, tradeIn, type Actors,
} from '../helpers/flow.js';

describe.skipIf(!HAS_DB)('owner approval and partner payment', () => {
  let t: TestApp; let a: Actors; let acct = ''; let otherAdmin = '';
  beforeAll(async () => {
    t = await createTestApp(); a = await actors(t); acct = await accountant(t);
    await t.deps.pool.query(`insert into public.vendors (id, name, code, default_commission_rate, status) values ('VND-009', 'Other Partner (fictional)', 'OTH', 0.05, 'ACTIVE') on conflict do nothing`);
    await t.deps.pool.query(`insert into public.app_users (id, full_name, phone, role, vendor_id, status)
      values ('USR-00075', 'Other Partner Admin', '+97430000075', 'VENDOR_ADMIN', 'VND-009', 'ACTIVE') on conflict do nothing`);
    otherAdmin = await t.tokenFor('USR-00075');
  });
  afterAll(async () => { await t?.close(); });

  const pay = (who: string, tradeInIds: string[], key = idemKey(), extra: Record<string, unknown> = {}) => t.call('finance.recordPayment', who, {
    vendorId: 'VND-001', tradeInIds, paymentReference: 'BANK-TRF-0001', paidAt: '2026-10-10T10:30', receipt: RECEIPT_PDF, receiptFileName: 'transfer.pdf', ...extra,
  }, key);
  const auditCount = async (objectId: string, action: string) =>
    (await t.deps.pool.query('select count(*)::int as n from public.audit_logs where object_id = $1 and action = $2', [objectId, action])).rows[0].n;

  it('positive: evaluation -> owner approval -> voucher -> accountant payment + receipt -> partner confirmation -> closed', async () => {
    const s = await submit(t, a.customer);
    await inspectAndOffer(t, a.tech, s.tradeInId, s.imei, { approve: false });
    let row = await tradeIn(t, s.tradeInId);
    expect(row.status).toBe('AWAITING_OWNER_APPROVAL');

    // Until approval the customer sees no figure and cannot accept; the owner's queue lists it.
    const before = (await ok(t.call('customer.tradeIn', a.customer, { tradeInId: s.tradeInId }))).tradeIn as Record<string, unknown>;
    expect(before.finalValue).toBeUndefined();
    expect(before.awaitingDecision).toBe(false);
    expect((await t.call('customer.acceptOffer', a.customer, { tradeInId: s.tradeInId }, idemKey())).status).toBe(422);
    const q = await ok(t.call('admin.approvalQueue', a.sa, {}));
    expect((q.pending as { tradeInId: string }[]).map((x) => x.tradeInId)).toContain(s.tradeInId);
    const ownerNote = await t.deps.pool.query(`select 1 from public.notifications where kind = 'OWNER_APPROVAL_NEEDED' and entity_id = $1`, [s.tradeInId]);
    expect(ownerNote.rowCount).toBe(1);

    // The owner approves: the offer is released; the partner is told.
    const ap = await approve(t, s.tradeInId, a.sa);
    expect(ap.status).toBe('FINAL_OFFER_READY');
    row = await tradeIn(t, s.tradeInId);
    expect(row.owner_approved_by).toContain('USR-00001');
    expect(row.owner_approved_at).not.toBeNull();
    expect((await t.deps.pool.query(`select 1 from public.notifications where kind = 'OWNER_APPROVED' and audience_type = 'VENDOR' and entity_id = $1`, [s.tradeInId])).rowCount).toBe(1);
    const released = (await ok(t.call('customer.tradeIn', a.customer, { tradeInId: s.tradeInId }))).tradeIn as Record<string, unknown>;
    expect(released.finalValue).toBe(2000);

    await ok(t.call('customer.acceptOffer', a.customer, { tradeInId: s.tradeInId }, idemKey()));
    await ok(t.call('tech.receiveDevice', a.tech, { tradeInId: s.tradeInId }, idemKey()));
    const v = await ok(t.call('vendor.issueVoucher', a.partnerAdmin, { tradeInId: s.tradeInId }, idemKey()));
    expect((await tradeIn(t, s.tradeInId)).status).toBe('READY_FOR_COLLECTION');
    expect((await t.deps.pool.query(`select 1 from public.notifications where kind = 'FINANCE_PAYMENT_DUE' and entity_id = $1`, [s.tradeInId])).rowCount).toBe(1);

    // Customer and technician: completed, no finance details, no actions.
    const cust = (await ok(t.call('customer.tradeIn', a.customer, { tradeInId: s.tradeInId }))).tradeIn as Record<string, unknown>;
    expect(cust.statusLabel).toBe('Completed');
    expect((cust.timeline as { steps: { state: string }[] }).steps.every((x) => x.state === 'done')).toBe(true);
    expect(JSON.stringify(cust)).not.toMatch(/payment|settlement|commission|receipt/i);
    const tq = await ok(t.call('tech.queues', a.tech, {}));
    const doneRow = (tq.completed as Record<string, unknown>[]).find((x) => x.tradeInId === s.tradeInId)!;
    expect(doneRow.statusLabel).toBe('Completed');
    expect(doneRow.actions).toEqual([]);
    expect(JSON.stringify(doneRow)).not.toMatch(/paymentStatus|paymentId/);
    for (const k of ['waiting', 'inProgress', 'awaitingOwner', 'awaitingCustomer', 'readyToReceive', 'returns']) {
      expect((tq[k] as { tradeInId: string }[]).map((x) => x.tradeInId)).not.toContain(s.tradeInId);
    }

    // Partner: still sees it, under finance (awaiting payment).
    let vf = await ok(t.call('vendor.finance', a.partnerAdmin, {}));
    expect((vf.awaitingPayment as { tradeInId: string }[]).map((x) => x.tradeInId)).toContain(s.tradeInId);
    const vq = await ok(t.call('vendor.queue', a.partnerAdmin, {}));
    expect((vq.tradeIns as { tradeInId: string; paymentStatus: string }[]).find((x) => x.tradeInId === s.tradeInId)!.paymentStatus).toBe('Awaiting payment');

    // Accountant: the queue holds the figures needed to pay.
    let fq = await ok(t.call('finance.queue', acct, {}));
    const line = (fq.awaitingPayment as Record<string, unknown>[]).find((x) => x.tradeInId === s.tradeInId)!;
    expect(line).toMatchObject({ vendorId: 'VND-001', branchId: 'BR-0001', voucherNumber: v.voucherNumber, agreedAmount: 2000, payable: 2100, paymentStatus: 'Awaiting payment' });
    expect(String(line.device)).toBeTruthy();

    // Pay with the receipt.
    const paid = await ok(pay(acct, [s.tradeInId]));
    const pid = String(paid.paymentId);
    expect(paid.total).toBe(2100);
    row = await tradeIn(t, s.tradeInId);
    expect(row.status).toBe('PAYMENT_SENT');
    expect(row.settlement_id).toBe(pid);
    expect(new Date(row.payment_sent_at).toISOString()).toBe('2026-10-10T07:30:00.000Z'); // 10:30 Qatar time
    const rc = (await t.deps.pool.query('select * from public.payment_receipts where settlement_id = $1', [pid])).rows;
    expect(rc).toHaveLength(1);
    expect(rc[0].mime_type).toBe('application/pdf');
    expect(t.storage.objects.has(`payment-receipts/${rc[0].object_path}`)).toBe(true);
    expect((await t.deps.pool.query(`select 1 from public.notifications where kind = 'FINANCE_PAYMENT_SENT' and audience_id = 'VND-001' and entity_id = $1`, [pid])).rowCount).toBe(1);

    fq = await ok(t.call('finance.queue', acct, {}));
    const waiting = (fq.awaitingVendor as Record<string, unknown>[]).find((x) => x.paymentId === pid)!;
    expect(waiting).toMatchObject({ total: 2100, paymentReference: 'BANK-TRF-0001', receiptStatus: '1 receipt(s) uploaded' });

    // Partner sees the confirm action and can open the receipt; another partner cannot.
    vf = await ok(t.call('vendor.finance', a.partnerAdmin, {}));
    expect((vf.toConfirm as { paymentId: string }[]).map((x) => x.paymentId)).toContain(pid);
    const link = await ok(t.call('vendor.viewReceipt', a.partnerAdmin, { paymentId: pid, receiptId: rc[0].id }));
    expect(String(link.url)).toContain('payment-receipts/');
    expect((await t.call('vendor.viewReceipt', otherAdmin, { paymentId: pid, receiptId: rc[0].id })).status).toBe(404);

    // Partner confirms -> CLOSED, with who and when, audited.
    const conf = await ok(t.call('vendor.confirmFunds', a.partnerAdmin, { paymentId: pid }, idemKey()));
    expect(conf.closed).toBe(1);
    row = await tradeIn(t, s.tradeInId);
    expect(row.status).toBe('CLOSED');
    expect(row.vendor_confirmed_by).toContain('USR-00004');
    expect(row.vendor_confirmed_at).not.toBeNull();
    expect(row.closed_at).not.toBeNull();
    const st = (await t.deps.pool.query('select * from public.settlements where id = $1', [pid])).rows[0];
    expect([st.kind, st.status]).toEqual(['VENDOR_PAYMENT', 'CLOSED']);
    expect(st.vendor_confirmed_by).toContain('USR-00004');

    // Every step is in the audit trail with actor, role, time and the state change.
    const trail = (await t.deps.pool.query<{ action: string; actor_id: string; actor_role: string; old_value: unknown; new_value: unknown; occurred_at: Date }>(
      'select action, actor_id, actor_role, old_value, new_value, occurred_at from public.audit_logs where object_id = $1 order by id', [s.tradeInId])).rows;
    const find = (action: string, to: string) => trail.find((x) => x.action === action && x.new_value === to);
    expect(find('FINAL_OFFER_SUBMITTED', 'AWAITING_OWNER_APPROVAL')).toMatchObject({ actor_role: 'TECHNICIAN', old_value: 'INSPECTION_COMPLETED' });
    expect(find('OWNER_APPROVED', 'FINAL_OFFER_READY')).toMatchObject({ actor_role: 'SUPER_ADMIN', actor_id: 'USR-00001' });
    expect(find('VOUCHER_ISSUED', 'VOUCHER_ISSUED')).toMatchObject({ actor_role: 'VENDOR_ADMIN' });
    expect(find('VENDOR_PAYMENT_SENT', 'PAYMENT_SENT')).toMatchObject({ actor_role: 'ACCOUNTANT', actor_id: 'USR-00070', old_value: 'READY_FOR_COLLECTION' });
    expect(find('VENDOR_FUNDS_CONFIRMED', 'VENDOR_CONFIRMED')).toMatchObject({ actor_role: 'VENDOR_ADMIN', old_value: 'PAYMENT_SENT' });
    expect(find('TRADEIN_CLOSED', 'CLOSED')).toMatchObject({ actor_role: 'VENDOR_ADMIN', old_value: 'VENDOR_CONFIRMED' });
    for (const x of trail) expect(x.occurred_at).toBeInstanceOf(Date);
    expect(await auditCount(pid, 'PAYMENT_RECEIPT_UPLOADED')).toBe(1);
    expect(await auditCount(pid, 'VENDOR_FUNDS_CONFIRMED')).toBe(1);

    // Accountant's history; the closure is recorded for the platform.
    fq = await ok(t.call('finance.queue', acct, {}));
    expect((fq.completed as { paymentId: string }[]).map((x) => x.paymentId)).toContain(pid);
    expect((fq.awaitingVendor as { paymentId: string }[]).map((x) => x.paymentId)).not.toContain(pid);
    expect((await t.deps.pool.query(`select 1 from public.notifications where kind = 'FINANCE_PAYMENT_CONFIRMED' and entity_id = $1`, [pid])).rowCount).toBe(1);
    vf = await ok(t.call('vendor.finance', a.partnerAdmin, {}));
    expect((vf.completed as { paymentId: string }[]).map((x) => x.paymentId)).toContain(pid);
  });

  it('a partner cannot issue a voucher before the owner approved (API and database)', async () => {
    const s = await submit(t, a.customer);
    await inspectAndOffer(t, a.tech, s.tradeInId, s.imei, { approve: false });
    const r = await t.call('vendor.issueVoucher', a.partnerAdmin, { tradeInId: s.tradeInId }, idemKey());
    expect(r.status).toBe(422);
    expect(String(r.body.message)).toMatch(/not been approved/);
    expect((await t.deps.pool.query('select 1 from public.vouchers where trade_in_id = $1', [s.tradeInId])).rowCount).toBe(0);
    // Straight to the database: the trade-in cannot skip to the offer, nor get a voucher row.
    await expect(t.deps.pool.query(`update public.trade_ins set status = 'FINAL_OFFER_READY' where id = $1`, [s.tradeInId]))
      .rejects.toThrow(/not been approved by the owner/);
    await expect(t.deps.pool.query(`insert into public.vouchers (id, trade_in_id, vendor_id, branch_id, voucher_number, customer_value, total_settlement)
      values ('VCH-999999', $1, 'VND-001', 'BR-0001', 'DEMO-X-0001', 1, 1)`, [s.tradeInId])).rejects.toThrow(/not been approved by the owner/);
  });

  it('only the owner/admin can approve: technician, partner, accountant and customer are refused', async () => {
    const s = await submit(t, a.customer);
    await inspectAndOffer(t, a.tech, s.tradeInId, s.imei, { approve: false });
    for (const who of [a.tech, a.partnerAdmin, a.mgrMall, acct, a.customer]) {
      expect((await t.call('admin.approveTradeIn', who, { tradeInId: s.tradeInId, decision: 'APPROVE' }, idemKey())).status).toBe(403);
      expect((await t.call('admin.approvalQueue', who, {})).status).toBe(403);
    }
    expect((await tradeIn(t, s.tradeInId)).status).toBe('AWAITING_OWNER_APPROVAL');
    // QM_ADMIN is an administrator and may approve; a repeat is a no-op.
    await ok(t.call('admin.approveTradeIn', a.finance, { tradeInId: s.tradeInId, decision: 'APPROVE' }, idemKey()));
    const again = await ok(t.call('admin.approveTradeIn', a.sa, { tradeInId: s.tradeInId, decision: 'APPROVE' }, idemKey()));
    expect(again.alreadyApproved).toBe(true);
  });

  it('the owner can send back (re-inspection, approval cleared) or reject (cancelled), with a reason', async () => {
    const s = await submit(t, a.customer);
    await inspectAndOffer(t, a.tech, s.tradeInId, s.imei, { approve: false });
    expect((await t.call('admin.approveTradeIn', a.sa, { tradeInId: s.tradeInId, decision: 'SEND_BACK' }, idemKey())).status).toBe(422);
    await ok(t.call('admin.approveTradeIn', a.sa, { tradeInId: s.tradeInId, decision: 'SEND_BACK', reason: 'Check the battery again' }, idemKey()));
    expect((await tradeIn(t, s.tradeInId)).status).toBe('INSPECTION_IN_PROGRESS');
    await ok(t.call('tech.submitOffer', a.tech, { tradeInId: s.tradeInId }, idemKey()));
    expect((await tradeIn(t, s.tradeInId)).status).toBe('AWAITING_OWNER_APPROVAL');
    await ok(t.call('admin.approveTradeIn', a.sa, { tradeInId: s.tradeInId, decision: 'REJECT', reason: 'Price outside policy' }, idemKey()));
    const row = await tradeIn(t, s.tradeInId);
    expect(row.status).toBe('CANCELLED');
    expect(row.owner_approved_at).toBeNull();
    expect(await auditCount(s.tradeInId, 'OWNER_SENT_BACK')).toBe(1);
    expect(await auditCount(s.tradeInId, 'OWNER_REJECTED')).toBe(1);
  });

  it('the accountant cannot pay before the voucher exists, nor a trade-in of another partner', async () => {
    const s = await submit(t, a.customer);
    await inspectAndOffer(t, a.tech, s.tradeInId, s.imei);
    await ok(t.call('customer.acceptOffer', a.customer, { tradeInId: s.tradeInId }, idemKey()));
    await ok(t.call('tech.receiveDevice', a.tech, { tradeInId: s.tradeInId }, idemKey()));
    const r = await pay(acct, [s.tradeInId]);
    expect(r.status).toBe(422);
    expect(String(r.body.message)).toMatch(/no voucher yet/);
    const wrong = await t.call('finance.recordPayment', acct, { vendorId: 'VND-009', tradeInIds: [s.tradeInId], paymentReference: 'X', receipt: RECEIPT_PDF }, idemKey());
    expect(wrong.status).toBe(422);
    expect((await t.deps.pool.query(`select count(*)::int as n from public.settlements where kind = 'VENDOR_PAYMENT' and $1 = any(select id from public.trade_ins where settlement_id = settlements.id)`, [s.tradeInId])).rows[0].n).toBe(0);
    // The database refuses a payment state without a payment record.
    await expect(t.deps.pool.query(`update public.trade_ins set status = 'PAYMENT_SENT' where id = $1`, [s.tradeInId])).rejects.toThrow();
  });

  it('a receipt is required and must be a real PDF or image', async () => {
    const r = await toReadyForCollection(t, a);
    expect((await pay(acct, [r.tradeInId], idemKey(), { receipt: '' })).status).toBe(422);
    const html = `data:text/html;base64,${Buffer.from('<html><script>alert(1)</script></html>').toString('base64')}`;
    const bad = await pay(acct, [r.tradeInId], idemKey(), { receipt: html });
    expect(bad.status).toBe(400);
    expect((await tradeIn(t, r.tradeInId)).status).toBe('READY_FOR_COLLECTION');
  });

  it('duplicate payment submissions create one payment record only', async () => {
    const r1 = await toReadyForCollection(t, a);
    const r2 = await toReadyForCollection(t, a);
    const key = idemKey();
    const first = await ok(pay(acct, [r1.tradeInId, r2.tradeInId], key));
    expect(first.tradeInCount).toBe(2);
    const replay = await ok(pay(acct, [r1.tradeInId, r2.tradeInId], key));          // same request again (retry)
    expect(replay.paymentId).toBe(first.paymentId);
    const second = await pay(acct, [r1.tradeInId, r2.tradeInId]);                     // a second submission
    expect(second.status).toBe(422);
    expect(String(second.body.message)).toMatch(/already paid/);
    const concurrent = await Promise.all([1, 2, 3].map(() => pay(acct, [r1.tradeInId])));
    expect(concurrent.every((x) => x.status === 422)).toBe(true);
    const n = (await t.deps.pool.query(`select count(distinct settlement_id)::int as n, count(*)::int as rows from public.trade_ins where id = any($1::text[])`, [[r1.tradeInId, r2.tradeInId]])).rows[0];
    expect(n).toEqual({ n: 1, rows: 2 });
    expect((await t.deps.pool.query('select count(*)::int as n from public.payment_receipts where settlement_id = $1', [first.paymentId])).rows[0].n).toBe(1);
    expect(await auditCount(String(first.paymentId), 'VENDOR_PAYMENT_SENT')).toBe(1);
  });

  it('partner confirmation: not before payment, not by another partner or a lower role, and idempotent', async () => {
    const r = await toReadyForCollection(t, a);
    const early = await t.call('vendor.confirmFunds', a.partnerAdmin, { tradeInId: r.tradeInId }, idemKey());
    expect(early.status).toBe(422);
    expect(String(early.body.message)).toMatch(/not sent the payment/);
    const paid = await ok(pay(acct, [r.tradeInId]));
    const pid = String(paid.paymentId);
    expect((await t.call('vendor.confirmFunds', otherAdmin, { paymentId: pid }, idemKey())).status).toBe(404);
    expect((await t.call('vendor.confirmFunds', a.mgrMall, { paymentId: pid }, idemKey())).status).toBe(403);
    expect((await t.call('vendor.confirmFunds', a.staffSouq, { paymentId: pid }, idemKey())).status).toBe(403);
    expect((await tradeIn(t, r.tradeInId)).status).toBe('PAYMENT_SENT');
    // The database refuses a closure that skips the confirmation.
    await expect(t.deps.pool.query(`update public.trade_ins set status = 'CLOSED' where id = $1`, [r.tradeInId])).rejects.toThrow(/invalid trade-in transition/);
    await expect(t.deps.pool.query(`update public.settlements set status = 'CLOSED' where id = $1`, [pid])).rejects.toThrow();
    // An admin cannot close a partner payment through the batch-settlement screen either.
    expect((await t.call('admin.advanceSettlement', a.sa, { settlementId: pid, toStatus: 'CLOSED' }, idemKey())).status).toBe(422);

    await ok(t.call('vendor.confirmFunds', a.partnerAdmin, { tradeInId: r.tradeInId }, idemKey()));
    const twice = await ok(t.call('vendor.confirmFunds', a.partnerAdmin, { paymentId: pid }, idemKey()));
    expect(twice.alreadyConfirmed).toBe(true);
    expect((await tradeIn(t, r.tradeInId)).status).toBe('CLOSED');
    expect(await auditCount(pid, 'VENDOR_FUNDS_CONFIRMED')).toBe(1);
    expect(await auditCount(r.tradeInId, 'TRADEIN_CLOSED')).toBe(1);
  });

  it('customers and technicians cannot touch finance; the accountant cannot touch evaluation or vouchers', async () => {
    const r = await toReadyForCollection(t, a);
    for (const who of [a.customer, a.tech]) {
      expect((await pay(who, [r.tradeInId])).status).toBe(403);
      expect((await t.call('finance.queue', who, {})).status).toBe(403);
      expect((await t.call('finance.uploadReceipt', who, { paymentId: 'STL-00001', receipt: RECEIPT_PDF }, idemKey())).status).toBe(403);
      expect((await t.call('vendor.confirmFunds', who, { tradeInId: r.tradeInId }, idemKey())).status).toBe(403);
      expect((await t.call('vendor.finance', who, {})).status).toBe(403);
    }
    // Partner staff cannot pay either.
    expect((await pay(a.partnerAdmin, [r.tradeInId])).status).toBe(403);
    // The accountant: finance only.
    const forbiddenForAccountant: [string, Record<string, unknown>][] = [
      ['tech.submitOffer', { tradeInId: r.tradeInId }], ['tech.openInspection', { tradeInId: r.tradeInId }],
      ['tech.receiveDevice', { tradeInId: r.tradeInId }], ['vendor.issueVoucher', { tradeInId: r.tradeInId }],
      ['vendor.voidVoucher', { voucherId: r.voucherId, reason: 'x' }], ['admin.overridePrice', { tradeInId: r.tradeInId, manualAdjustment: 5, reason: 'x' }],
      ['admin.approveTradeIn', { tradeInId: r.tradeInId }], ['admin.tradeIns', {}], ['admin.staff', {}], ['search.global', { query: 'TI-DEMO' }],
      ['admin.createSettlement', { vendorId: 'VND-001', from: '2026-01-01', to: '2030-12-31' }],
    ];
    for (const [action, params] of forbiddenForAccountant) {
      expect([action, (await t.call(action, acct, params, idemKey())).status]).toEqual([action, 403]);
    }
    const me = await ok(t.call('me.context', acct, {}));
    expect(me.portal).toBe('finance');
    // The accountant's notifications are finance rows only.
    const notes = await ok(t.call('notify.list', acct, {}));
    for (const n of notes.notifications as { kind: string }[]) expect(n.kind).toMatch(/^FINANCE_/);
  });

  it('the technician has no actions after the voucher', async () => {
    const r = await toReadyForCollection(t, a);
    expect((await t.call('tech.receiveDevice', a.tech, { tradeInId: r.tradeInId }, idemKey())).status).toBe(422);
    expect((await t.call('tech.returnDevice', a.tech, { tradeInId: r.tradeInId, reason: 'x' }, idemKey())).status).toBe(422);
    expect((await t.call('tech.submitOffer', a.tech, { tradeInId: r.tradeInId }, idemKey())).status).toBe(422);
    expect((await tradeIn(t, r.tradeInId)).status).toBe('READY_FOR_COLLECTION');
  });

  it('a voucher issued before this step existed is approved where it stands, then paid', async () => {
    const r = await toReadyForCollection(t, a);
    await t.deps.pool.query('update public.trade_ins set owner_approved_at = null, owner_approved_by = null where id = $1', [r.tradeInId]);
    const refused = await pay(acct, [r.tradeInId]);
    expect(String(refused.body.message)).toMatch(/not been approved by the owner/);
    const q = await ok(t.call('finance.queue', acct, {}));
    expect((q.needsApproval as { tradeInId: string }[]).map((x) => x.tradeInId)).toContain(r.tradeInId);
    const aq = await ok(t.call('admin.approvalQueue', a.sa, {}));
    expect((aq.legacyUnapproved as { tradeInId: string }[]).map((x) => x.tradeInId)).toContain(r.tradeInId);
    const ap = await ok(t.call('admin.approveTradeIn', a.sa, { tradeInId: r.tradeInId, decision: 'APPROVE' }, idemKey()));
    expect(ap.retroactive).toBe(true);
    await ok(pay(acct, [r.tradeInId]));
    expect((await tradeIn(t, r.tradeInId)).status).toBe('PAYMENT_SENT');
  });
});
