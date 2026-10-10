/**
 * Owner approval and partner payment (owner decision 2026-10-10).
 *
 *   technician final pricing      INSPECTION_COMPLETED  -> AWAITING_OWNER_APPROVAL   (inspections.submitFinalOffer)
 *   owner/admin approves          AWAITING_OWNER_APPROVAL -> FINAL_OFFER_READY       (decideTradeIn, "OWNER_APPROVED")
 *   owner sends back / rejects    AWAITING_OWNER_APPROVAL -> INSPECTION_IN_PROGRESS | CANCELLED
 *   customer accepts, hands over, partner issues the voucher (unchanged)  -> READY_FOR_COLLECTION ("VOUCHER_CREATED")
 *   accountant pays + receipt     READY_FOR_COLLECTION -> PAYMENT_SENT               (recordPayment)
 *   partner confirms the money    PAYMENT_SENT -> VENDOR_CONFIRMED -> CLOSED         (confirmFunds)
 *
 * One transfer may pay several trade-ins of ONE partner; it is a settlement row of kind VENDOR_PAYMENT
 * (status PAID, then CLOSED when the partner confirms). Every state change runs on locked rows inside
 * the request transaction and writes its audit row there; the database re-checks the same gates
 * (migration 20261010000200).
 */
import {
  ACTIONS, CURRENCY, FINANCE_PAYERS, FINANCE_READERS, FINANCE_STATUS_LABEL, MEDIA, NOTIFY, OWNER_APPROVERS, STATUS,
  VENDOR_FINANCE,
} from '../../../../packages/domain/src/constants.js';
import { deny, loadTradeInScoped } from '../../../../packages/auth/src/authz.js';
import { fail, forbidden, notFound } from '../../../../packages/shared/src/errors.js';
import { centsToDecimal, centsToNumber, formatMoney, toCentsOrNull } from '../../../../packages/shared/src/money.js';
import { isBlank, statusLabel, trim } from '../../../../packages/shared/src/text.js';
import { fmtDateTime } from '../../../../packages/shared/src/time.js';
import type { Ctx } from '../context.js';
import { audit } from '../lib/audit.js';
import { nextId } from '../lib/ids.js';
import { emit, notify } from '../lib/notify.js';
import { objectName, validateReceipt } from '../lib/storage.js';
import { clampLimit, updateById } from './sql.js';
import { Lookups, adminTradeInView, deviceLabel, m, type TradeInRow } from './views.js';
import { transition } from './tradeins.js';

const now = (): Date => new Date();
const who = (ctx: Ctx): string => `${ctx.p.name} (${ctx.p.principalId})`;

function requireOneOf(ctx: Ctx, roles: readonly string[], what: string, message: string): void {
  if (ctx.p.principalType !== 'STAFF' || !roles.includes(ctx.p.role)) {
    deny(ctx, what, ctx.p.role);
    throw forbidden(message);
  }
}

type Row = TradeInRow & {
  owner_approved_by: string | null; owner_approved_at: Date | null; owner_decision_note: string | null;
  payment_sent_at: Date | null; vendor_confirmed_by: string | null; vendor_confirmed_at: Date | null; closed_at: Date | null;
};

interface PaymentRow {
  id: string; vendor_id: string; kind: string; status: string; trade_in_count: number; customer_value_total: string;
  commission_total: string; settlement_total: string; currency: string; paid_at: Date | null; paid_by: string | null;
  payment_reference: string | null; vendor_confirmed_by: string | null; vendor_confirmed_at: Date | null; closed_at: Date | null;
  created_at: Date; notes: string | null;
}

/* ===================================================================== owner approval */

/** admin.approvalQueue: evaluated trade-ins waiting for the owner, plus vouchers issued before this step existed. */
export async function approvalQueue(ctx: Ctx) {
  requireOneOf(ctx, OWNER_APPROVERS, 'owner.queue', 'Only the owner or a Qatar Mobile administrator can see approvals.');
  const L = new Lookups(ctx.db);
  const pending = (await ctx.db.query<Row>(
    `select * from public.trade_ins where status = 'AWAITING_OWNER_APPROVAL' order by updated_at, id limit 500`)).rows;
  const legacy = (await ctx.db.query<Row>(
    `select * from public.trade_ins where status = 'READY_FOR_COLLECTION' and voucher_id is not null
        and owner_approved_at is null and settlement_id is null order by created_at limit 200`)).rows;
  const view = async (t: Row) => {
    const v = await adminTradeInView(L, t);
    delete v.imeiFull;
    return {
      ...v, branchName: (await L.branch(t.branch_id))?.name ?? '', submittedDate: fmtDateTime(t.updated_at),
      finalValue: m(t.final_customer_value), payable: m(t.total_settlement),
    };
  };
  const out = []; for (const t of pending) out.push(await view(t));
  const old = []; for (const t of legacy) old.push(await view(t));
  return { ok: true, pending: out, legacyUnapproved: old, count: out.length, currency: CURRENCY };
}

/**
 * admin.approveTradeIn: APPROVE releases the offer to the customer; SEND_BACK returns it to the
 * technician; REJECT cancels it (the customer still has the device). A repeated APPROVE is a no-op.
 * A trade-in vouchered before this step existed may be approved where it stands, so it can be paid.
 */
export async function decideTradeIn(ctx: Ctx, p: { tradeInId: string; decision?: string; reason?: string }) {
  requireOneOf(ctx, OWNER_APPROVERS, 'owner.approve', 'Only the owner or a Qatar Mobile administrator can approve a trade-in.');
  const t = await loadTradeInScoped<Row>(ctx, p.tradeInId, { lock: true });
  const decision = trim(p.decision || 'APPROVE').toUpperCase().replace(/[\s-]+/g, '_');
  const reason = trim(p.reason);

  if (decision === 'APPROVE') {
    if (t.status === STATUS.AWAITING_OWNER_APPROVAL) {
      const value = toCentsOrNull(t.final_customer_value) ?? 0;
      await transition(ctx, t, 'FINAL_OFFER_READY', {
        owner_approved_by: who(ctx), owner_approved_at: now(), owner_decision_note: reason || null,
      }, ACTIONS.OWNER_APPROVED, { finalValue: centsToNumber(value), payable: m(t.total_settlement), reason });
      await emit.offerReady(ctx.db, t.id, t.customer_id, value);
      await emit.ownerApproved(ctx.db, t.id, t.vendor_id, t.branch_id, value);
      return { ok: true, tradeInId: t.id, status: 'FINAL_OFFER_READY', message: `Approved. The customer can now see the offer of ${formatMoney(value)} ${CURRENCY}.` };
    }
    if (t.owner_approved_at) {
      return { ok: true, tradeInId: t.id, status: t.status, alreadyApproved: true, message: 'This trade-in is already approved.' };
    }
    if (t.status === STATUS.READY_FOR_COLLECTION && t.voucher_id && !t.settlement_id) {
      await updateById(ctx.db, 'trade_ins', t.id, { owner_approved_by: who(ctx), owner_approved_at: now(), owner_decision_note: reason || 'Approved after the voucher (issued before owner approval existed).' });
      await audit(ctx, ACTIONS.OWNER_APPROVED, 'TRADEIN', t.id, {
        oldValue: t.status, newValue: t.status, vendorId: t.vendor_id, branchId: t.branch_id,
        details: { retroactive: true, reason, note: 'The voucher was issued before owner approval existed; approved so it can be paid.' },
      });
      return { ok: true, tradeInId: t.id, status: t.status, retroactive: true, message: 'Approved. The accountant can now pay this trade-in.' };
    }
    throw fail(`This trade-in is not waiting for approval (it is at "${statusLabel(t.status)}").`);
  }

  if (decision !== 'SEND_BACK' && decision !== 'REJECT') throw fail('Choose approve, send back or reject.');
  if (t.status !== STATUS.AWAITING_OWNER_APPROVAL) throw fail(`This trade-in is not waiting for approval (it is at "${statusLabel(t.status)}").`);
  if (isBlank(reason)) throw fail(decision === 'REJECT' ? 'Say why the trade-in is rejected. It is recorded.' : 'Say what the technician should check again. It is recorded.');

  if (decision === 'SEND_BACK') {
    await transition(ctx, t, 'INSPECTION_IN_PROGRESS', { owner_decision_note: reason }, ACTIONS.OWNER_SENT_BACK, { reason });
    if (t.inspection_id) await updateById(ctx.db, 'inspections', t.inspection_id, { status: 'IN_PROGRESS', completed_at: null });
    await notify(ctx.db, { audienceType: 'PLATFORM', kind: NOTIFY.INSPECTION_DONE, title: `Re-check ${t.id}`,
      message: `Sent back by the owner: ${reason}`, entityType: 'TRADEIN', entityId: t.id });
    return { ok: true, tradeInId: t.id, status: 'INSPECTION_IN_PROGRESS', message: 'Sent back to the technician.' };
  }
  await transition(ctx, t, 'CANCELLED', { owner_decision_note: reason }, ACTIONS.OWNER_REJECTED, { reason, outcome: 'rejected by the owner' });
  await notify(ctx.db, { audienceType: 'CUSTOMER', audienceId: t.customer_id, kind: NOTIFY.OFFER_READY,
    title: 'We could not confirm an offer', message: 'Please speak to the shop. Your device stays with you.',
    entityType: 'TRADEIN', entityId: t.id });
  await notify(ctx.db, { audienceType: 'VENDOR', audienceId: t.vendor_id, branchId: t.branch_id, kind: NOTIFY.OWNER_APPROVED,
    title: `Trade-in ${t.id} rejected`, message: `Rejected by Qatar Mobile: ${reason}`, entityType: 'TRADEIN', entityId: t.id });
  return { ok: true, tradeInId: t.id, status: 'CANCELLED', message: 'Rejected. The trade-in is cancelled.' };
}

/* ===================================================================== finance views */

async function voucherOf(ctx: Ctx, voucherId: string | null) {
  if (!voucherId) return null;
  return (await ctx.db.query<{ voucher_number: string; issued_at: Date; status: string }>(
    'select voucher_number, issued_at, status from public.vouchers where id = $1', [voucherId])).rows[0] ?? null;
}

async function financeLine(ctx: Ctx, L: Lookups, t: Row) {
  const v = await voucherOf(ctx, t.voucher_id);
  return {
    tradeInId: t.id, vendorId: t.vendor_id, vendorName: (await L.vendor(t.vendor_id))?.name ?? '',
    branchId: t.branch_id, branchName: (await L.branch(t.branch_id))?.name ?? '',
    voucherNumber: v?.voucher_number ?? '', voucherDate: fmtDateTime(v?.issued_at ?? null),
    device: deviceLabel(t), agreedAmount: m(t.final_customer_value), commission: m(t.commission_value),
    payable: m(t.total_settlement), currency: t.currency?.trim() || CURRENCY,
    status: t.status, paymentStatus: FINANCE_STATUS_LABEL[t.status] ?? statusLabel(t.status),
    paymentId: t.settlement_id ?? '', paymentDate: fmtDateTime(t.payment_sent_at),
    ownerApproved: !!t.owner_approved_at, ownerApprovedBy: t.owner_approved_by ?? '',
    vendorConfirmedDate: fmtDateTime(t.vendor_confirmed_at), closedDate: fmtDateTime(t.closed_at),
  };
}

async function receiptsOf(ctx: Ctx, paymentId: string) {
  return (await ctx.db.query<{ id: string; file_name: string | null; mime_type: string; size_bytes: number; uploaded_by: string; uploaded_at: Date }>(
    'select id, file_name, mime_type, size_bytes, uploaded_by, uploaded_at from public.payment_receipts where settlement_id = $1 order by uploaded_at',
    [paymentId])).rows.map((r) => ({
    receiptId: r.id, fileName: r.file_name ?? '', mimeType: r.mime_type, sizeBytes: r.size_bytes,
    uploadedBy: r.uploaded_by, uploadedDate: fmtDateTime(r.uploaded_at),
  }));
}

async function paymentView(ctx: Ctx, L: Lookups, s: PaymentRow, withLines = true) {
  const lines = [];
  if (withLines) {
    const rows = (await ctx.db.query<Row>('select * from public.trade_ins where settlement_id = $1 order by id', [s.id])).rows;
    for (const t of rows) lines.push(await financeLine(ctx, L, t));
  }
  const receipts = await receiptsOf(ctx, s.id);
  return {
    paymentId: s.id, vendorId: s.vendor_id, vendorName: (await L.vendor(s.vendor_id))?.name ?? '',
    status: s.status, statusLabel: s.status === 'PAID' ? 'Paid — awaiting partner confirmation' : 'Completed',
    tradeInCount: s.trade_in_count, customerValueTotal: m(s.customer_value_total), commissionTotal: m(s.commission_total),
    total: m(s.settlement_total), currency: s.currency?.trim() || CURRENCY,
    paymentReference: s.payment_reference ?? '', paymentDate: fmtDateTime(s.paid_at), paidBy: s.paid_by ?? '',
    vendorConfirmedBy: s.vendor_confirmed_by ?? '', vendorConfirmedDate: fmtDateTime(s.vendor_confirmed_at),
    closedDate: fmtDateTime(s.closed_at), notes: s.notes ?? '',
    receiptStatus: receipts.length ? `${receipts.length} receipt(s) uploaded` : 'No receipt', receipts, lines,
  };
}

/** finance.queue: what the accountant needs to pay, what waits for the partner, and the history. */
export async function financeQueue(ctx: Ctx, f: { vendorId?: string; limit?: number }) {
  requireOneOf(ctx, FINANCE_READERS, 'finance.queue', 'Only the accountant or an administrator can see payments.');
  const L = new Lookups(ctx.db);
  const vendorId = trim(f.vendorId) || null;
  const due = (await ctx.db.query<Row>(
    `select * from public.trade_ins where status = 'READY_FOR_COLLECTION' and voucher_id is not null and settlement_id is null
        and ($1::text is null or vendor_id = $1) order by created_at limit 1000`, [vendorId])).rows;
  type Line = Awaited<ReturnType<typeof financeLine>>;
  const awaitingPayment: Line[] = []; const needsApproval: Line[] = [];
  for (const t of due) (t.owner_approved_at ? awaitingPayment : needsApproval).push(await financeLine(ctx, L, t));

  const pay = async (status: string, limit: number) => {
    const rows = (await ctx.db.query<PaymentRow>(
      `select * from public.settlements where kind = 'VENDOR_PAYMENT' and status = $1 and ($2::text is null or vendor_id = $2)
        order by coalesce(closed_at, paid_at) desc limit $3`, [status, vendorId, limit])).rows;
    const out = []; for (const s of rows) out.push(await paymentView(ctx, L, s));
    return out;
  };
  const byVendor = new Map<string, { vendorId: string; vendorName: string; count: number; payable: number }>();
  for (const x of awaitingPayment) {
    const g = byVendor.get(x.vendorId) ?? { vendorId: x.vendorId, vendorName: x.vendorName, count: 0, payable: 0 };
    g.count++; g.payable = centsToNumber((toCentsOrNull(g.payable) ?? 0) + (toCentsOrNull(x.payable) ?? 0));
    byVendor.set(x.vendorId, g);
  }
  return {
    ok: true, currency: CURRENCY, canPay: FINANCE_PAYERS.includes(ctx.p.role),
    awaitingPayment, needsApproval, byVendor: [...byVendor.values()],
    awaitingVendor: await pay('PAID', 500), completed: await pay('CLOSED', clampLimit(f.limit, 100, 500)),
  };
}

/* ===================================================================== accountant payment */

/** "2026-10-10T14:30" (Qatar time, from a datetime-local box), a full ISO time, a date, or blank = now. */
function parsePaidAt(v: unknown): Date {
  const s = trim(v);
  if (!s) return now();
  let d: Date;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) d = new Date(`${s}T12:00:00+03:00`);
  else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)) d = new Date(`${s}+03:00`);
  else d = new Date(s);
  if (Number.isNaN(d.getTime())) throw fail('Enter the payment date and time.');
  if (d.getTime() > Date.now() + 10 * 60_000) throw fail('The payment date cannot be in the future.');
  return d;
}

async function storeReceipt(ctx: Ctx, paymentId: string, vendorId: string, data: unknown, fileName: unknown) {
  const file = validateReceipt(data, MEDIA.MAX_RECEIPT_BYTES);
  const path = objectName(paymentId, file.ext);
  await ctx.deps.storage.upload('payment-receipts', path, file.bytes, file.mime);
  const r = await ctx.db.query<{ id: string }>(
    `insert into public.payment_receipts (settlement_id, vendor_id, object_path, file_name, mime_type, size_bytes, sha256, uploaded_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
    [paymentId, vendorId, path, trim(fileName).slice(0, 200) || null, file.mime, file.size, file.sha256, who(ctx)]);
  await audit(ctx, ACTIONS.PAYMENT_RECEIPT_UPLOADED, 'SETTLEMENT', paymentId, {
    vendorId, details: { receiptId: r.rows[0]!.id, mimeType: file.mime, sizeBytes: file.size, sha256: file.sha256 },
  });
  return r.rows[0]!.id;
}

/**
 * finance.recordPayment: one transfer to ONE partner for one or more voucher-created, owner-approved,
 * unpaid trade-ins, with the receipt. Each trade-in moves READY_FOR_COLLECTION -> PAYMENT_SENT.
 * A trade-in already paid is refused, so a repeated submission creates nothing.
 */
export async function recordPayment(ctx: Ctx, p: {
  vendorId: string; tradeInIds: string[]; paymentReference?: string; paidAt?: string; receipt?: string; receiptFileName?: string; notes?: string;
}) {
  requireOneOf(ctx, FINANCE_PAYERS, 'finance.pay', 'Only the accountant can record a payment to a partner.');
  const vendorId = trim(p.vendorId);
  const ids = [...new Set((p.tradeInIds ?? []).map((x) => trim(x)).filter(Boolean))];
  if (!vendorId) throw fail('Choose the partner you paid.');
  if (!ids.length) throw fail('Choose the trade-ins this payment covers.');
  const reference = trim(p.paymentReference);
  if (!reference) throw fail('Enter the bank or transfer reference.');
  const paidAt = parsePaidAt(p.paidAt);
  if (isBlank(p.receipt)) throw fail('Attach the payment receipt (PDF or image).');

  // Serialise payments per partner: two accountants cannot both pay the same trade-in.
  const v = await ctx.db.query('select 1 from public.vendors where id = $1 for update', [vendorId]);
  if (!v.rowCount) throw fail('Choose the partner you paid.');
  const rows = (await ctx.db.query<Row>('select * from public.trade_ins where id = any($1::text[]) order by id for update', [ids])).rows;
  const problems: string[] = [];
  for (const id of ids) {
    const t = rows.find((r) => r.id === id);
    if (!t) { problems.push(`${id} was not found`); continue; }
    if (t.vendor_id !== vendorId) { problems.push(`${id} belongs to another partner`); continue; }
    if (t.settlement_id) { problems.push(`${id} is already paid (${t.settlement_id})`); continue; }
    if (!t.voucher_id) { problems.push(`${id} has no voucher yet`); continue; }
    if (!t.owner_approved_at) { problems.push(`${id} has not been approved by the owner`); continue; }
    if (t.status !== STATUS.READY_FOR_COLLECTION) { problems.push(`${id} is at "${statusLabel(t.status)}"`); continue; }
  }
  if (problems.length) throw fail(`This payment cannot be recorded: ${problems.join('; ')}.`, { problems });
  const vouchers = (await ctx.db.query<{ trade_in_id: string; issued_at: Date }>(
    `select trade_in_id, issued_at from public.vouchers where trade_in_id = any($1::text[]) and status = 'ISSUED'`, [ids])).rows;
  const missing = ids.filter((id) => !vouchers.some((x) => x.trade_in_id === id));
  if (missing.length) throw fail(`No live voucher for ${missing.join(', ')}.`);

  const sum = (k: keyof TradeInRow) => rows.reduce((a, t) => a + (toCentsOrNull(t[k] as string) ?? 0), 0);
  const customerCents = sum('final_customer_value'); const commissionCents = sum('commission_value');
  const totalCents = customerCents + commissionCents;
  const issued = vouchers.map((x) => new Date(x.issued_at).getTime());
  const paymentId = await nextId(ctx.db, 'STL');
  await ctx.db.query(
    `insert into public.settlements
       (id, vendor_id, kind, period_from, period_to, trade_in_count, customer_value_total, commission_total, settlement_total,
        currency, status, created_by, paid_at, paid_by, payment_reference, notes, operation_id)
     values ($1,$2,'VENDOR_PAYMENT',$3,$4,$5,$6,$7,$8,'QAR','PAID',$9,$10,$11,$12,$13,$14)`,
    [paymentId, vendorId, new Date(Math.min(...issued)), new Date(Math.max(...issued)), rows.length,
      centsToDecimal(customerCents), centsToDecimal(commissionCents), centsToDecimal(totalCents),
      ctx.p.principalId, paidAt, who(ctx), reference.slice(0, 120), trim(p.notes).slice(0, 1000) || null, ctx.operationId || null]);
  const receiptId = await storeReceipt(ctx, paymentId, vendorId, p.receipt, p.receiptFileName);
  for (const t of rows) {
    await transition(ctx, t, 'PAYMENT_SENT', { settlement_id: paymentId, payment_sent_at: paidAt }, ACTIONS.VENDOR_PAYMENT_SENT,
      { paymentId, reference, payable: m(t.total_settlement), settlementId: paymentId });
  }
  await audit(ctx, ACTIONS.VENDOR_PAYMENT_SENT, 'SETTLEMENT', paymentId, {
    oldValue: null, newValue: 'PAID', vendorId,
    details: { tradeInIds: ids, total: centsToNumber(totalCents), reference, paidAt: paidAt.toISOString(), receiptId },
  });
  await emit.vendorPaymentSent(ctx.db, paymentId, vendorId, rows.length, totalCents, reference);
  return {
    ok: true, paymentId, tradeInCount: rows.length, total: centsToNumber(totalCents), currency: CURRENCY, receiptId,
    message: `Payment ${paymentId} recorded: ${formatMoney(totalCents)} ${CURRENCY} for ${rows.length} trade-in(s). The partner is asked to confirm receipt.`,
  };
}

async function loadPayment(ctx: Ctx, paymentId: unknown, lock: boolean): Promise<PaymentRow> {
  const id = trim(paymentId);
  const s = (await ctx.db.query<PaymentRow>(
    `select * from public.settlements where id = $1 and kind = 'VENDOR_PAYMENT'${lock ? ' for update' : ''}`, [id])).rows[0];
  // A partner sees only its own payments; another partner's id looks like a missing one.
  if (!s || (!ctx.p.isPlatform && s.vendor_id !== ctx.p.vendorId)) {
    deny(ctx, 'object.payment', id);
    throw notFound('Payment not found.');
  }
  return s;
}

/** finance.uploadReceipt: another receipt for a sent payment, until the partner has confirmed it. */
export async function uploadReceipt(ctx: Ctx, p: { paymentId: string; receipt?: string; receiptFileName?: string }) {
  requireOneOf(ctx, FINANCE_PAYERS, 'finance.receipt', 'Only the accountant can upload a payment receipt.');
  const s = await loadPayment(ctx, p.paymentId, true);
  if (s.status !== 'PAID') throw fail('The partner has already confirmed this payment; its receipts are final.');
  const receiptId = await storeReceipt(ctx, s.id, s.vendor_id, p.receipt, p.receiptFileName);
  return { ok: true, paymentId: s.id, receiptId, message: 'Receipt uploaded.' };
}

/** finance.viewReceipt / vendor.viewReceipt: a short-lived signed link, after the scope check. */
export async function viewReceipt(ctx: Ctx, p: { paymentId: string; receiptId: string }) {
  if (!FINANCE_READERS.includes(ctx.p.role) && !VENDOR_FINANCE.includes(ctx.p.role)) {
    deny(ctx, 'finance.viewReceipt', ctx.p.role);
    throw forbidden();
  }
  const s = await loadPayment(ctx, p.paymentId, false);
  const rid = trim(p.receiptId);
  const r = /^[0-9a-f-]{36}$/i.test(rid)
    ? (await ctx.db.query<{ object_path: string; mime_type: string; file_name: string | null }>(
      'select object_path, mime_type, file_name from public.payment_receipts where id = $1::uuid and settlement_id = $2', [rid, s.id])).rows[0]
    : undefined;
  if (!r) { deny(ctx, 'finance.receipt', rid); throw fail('That receipt does not belong to this payment.'); }
  const ttl = ctx.deps.config.SIGNED_URL_TTL_SECONDS;
  const url = await ctx.deps.storage.signedUrl('payment-receipts', r.object_path, ttl);
  return { ok: true, url, expiresInSeconds: ttl, mimeType: r.mime_type, fileName: r.file_name ?? '' };
}

/* ===================================================================== partner confirmation */

/** vendor.finance: the partner's own payments — awaiting payment, to confirm, completed. */
export async function vendorFinance(ctx: Ctx, f: { limit?: number }) {
  requireOneOf(ctx, VENDOR_FINANCE, 'vendor.finance', 'Only the partner administrator can see payments.');
  if (!ctx.p.vendorId) throw forbidden('Your account is not linked to a vendor.');
  const L = new Lookups(ctx.db);
  const due = (await ctx.db.query<Row>(
    `select * from public.trade_ins where vendor_id = $1 and status = 'READY_FOR_COLLECTION' and voucher_id is not null
        and settlement_id is null order by created_at limit 1000`, [ctx.p.vendorId])).rows;
  const awaitingPayment = []; for (const t of due) awaitingPayment.push(await financeLine(ctx, L, t));
  const pay = async (status: string, limit: number) => {
    const rows = (await ctx.db.query<PaymentRow>(
      `select * from public.settlements where kind = 'VENDOR_PAYMENT' and vendor_id = $1 and status = $2
        order by coalesce(closed_at, paid_at) desc limit $3`, [ctx.p.vendorId, status, limit])).rows;
    const out = []; for (const s of rows) out.push(await paymentView(ctx, L, s));
    return out;
  };
  return {
    ok: true, currency: CURRENCY, awaitingPayment,
    toConfirm: await pay('PAID', 500), completed: await pay('CLOSED', clampLimit(f.limit, 100, 500)),
  };
}

/**
 * vendor.confirmFunds: the partner confirms the money arrived. The payment closes and every trade-in
 * in it moves PAYMENT_SENT -> VENDOR_CONFIRMED -> CLOSED. Confirming twice changes nothing.
 * `tradeInId` may be given instead of `paymentId` (the payment that trade-in is part of).
 */
export async function confirmFunds(ctx: Ctx, p: { paymentId?: string; tradeInId?: string }) {
  requireOneOf(ctx, VENDOR_FINANCE, 'vendor.confirmFunds', 'Only the partner administrator can confirm a payment.');
  let paymentId = trim(p.paymentId);
  if (!paymentId && trim(p.tradeInId)) {
    const t = await loadTradeInScoped<Row>(ctx, p.tradeInId, { lock: true });
    if (!t.settlement_id || ![STATUS.PAYMENT_SENT, STATUS.VENDOR_CONFIRMED, STATUS.CLOSED].includes(t.status as never)) {
      throw fail('Qatar Mobile has not sent the payment for this trade-in yet.');
    }
    paymentId = t.settlement_id;
  }
  if (!paymentId) throw fail('Which payment?');
  const s = await loadPayment(ctx, paymentId, true);
  if (s.vendor_id !== ctx.p.vendorId) { deny(ctx, 'object.payment', s.id); throw notFound('Payment not found.'); }
  if (s.status === 'CLOSED') {
    return { ok: true, paymentId: s.id, alreadyConfirmed: true, message: `Payment ${s.id} was already confirmed.` };
  }
  if (s.status !== 'PAID') throw fail('Qatar Mobile has not sent this payment yet.');

  const at = now();
  await updateById(ctx.db, 'settlements', s.id, { status: 'CLOSED', vendor_confirmed_by: who(ctx), vendor_confirmed_at: at, closed_at: at });
  const rows = (await ctx.db.query<Row>('select * from public.trade_ins where settlement_id = $1 order by id for update', [s.id])).rows;
  for (const t of rows) {
    if (t.status !== STATUS.PAYMENT_SENT) throw fail(`${t.id} is at "${statusLabel(t.status)}", not waiting for confirmation.`);
    const confirmed = await transition(ctx, t, 'VENDOR_CONFIRMED', { vendor_confirmed_by: who(ctx), vendor_confirmed_at: at },
      ACTIONS.VENDOR_FUNDS_CONFIRMED, { paymentId: s.id, settlementId: s.id });
    await transition(ctx, confirmed, 'CLOSED', { closed_at: at }, ACTIONS.TRADEIN_CLOSED, { outcome: 'partner confirmed the payment', settlementId: s.id });
  }
  await audit(ctx, ACTIONS.VENDOR_FUNDS_CONFIRMED, 'SETTLEMENT', s.id, {
    oldValue: 'PAID', newValue: 'CLOSED', vendorId: s.vendor_id,
    details: { total: m(s.settlement_total), tradeInIds: rows.map((t) => t.id), confirmedBy: who(ctx) },
  });
  await emit.vendorPaymentConfirmed(ctx.db, s.id, s.vendor_id, rows.length, toCentsOrNull(s.settlement_total) ?? 0);
  return {
    ok: true, paymentId: s.id, closed: rows.length,
    message: `Thank you. Payment ${s.id} is confirmed and ${rows.length} trade-in(s) are closed.`,
  };
}

