/**
 * Vouchers (16_Vouchers.gs). The gate: no voucher without the device in
 * our hands. One live voucher per trade-in (partial unique index). Values
 * are COPIED from the frozen trade-in, never recomputed. Numbers are
 * CODE-yyyyMMdd-NNNN per partner per Qatar day.
 */
import { ACTIONS, CURRENCY, STATUS, TRADEIN_CONFIG } from '../../../../packages/domain/src/constants.js';
import { canTransition } from '../../../../packages/domain/src/workflow.js';
import { deny, loadTradeInScoped, loadVoucherScoped } from '../../../../packages/auth/src/authz.js';
import { fail } from '../../../../packages/shared/src/errors.js';
import { centsToNumber, formatMoney, toCentsOrNull } from '../../../../packages/shared/src/money.js';
import { isBlank, statusLabel, trim } from '../../../../packages/shared/src/text.js';
import { fmtDateTime, parseDayEnd, parseDayStart } from '../../../../packages/shared/src/time.js';
import type { Ctx } from '../context.js';
import { audit } from '../lib/audit.js';
import { nextId, nextVoucherNumber } from '../lib/ids.js';
import { emit } from '../lib/notify.js';
import { releaseFromOpenBatch } from './collections.js';
import { clampLimit, updateById } from './sql.js';
import { Lookups, deviceLabel, m, type TradeInRow } from './views.js';
import { transition } from './tradeins.js';

interface VoucherRow {
  id: string; trade_in_id: string; customer_id: string | null; vendor_id: string; branch_id: string; voucher_number: string;
  customer_value: string; commission_type_snapshot: string | null; commission_rate_snapshot: string | null; commission_value: string;
  total_settlement: string; currency: string; issued_by: string | null; issued_at: Date; status: 'ISSUED' | 'VOIDED';
  voided_by: string | null; voided_at: Date | null; void_reason: string | null; replaced_by_voucher_id: string | null;
  replaces_voucher_id: string | null; notes: string | null; operation_id: string | null;
}

const now = (): Date => new Date();

function issuedReply(v: VoucherRow, t: TradeInRow, replayed = false) {
  const value = toCentsOrNull(v.customer_value) ?? 0;
  const out: Record<string, unknown> = {
    ok: true, voucherId: v.id, voucherNumber: v.voucher_number, value: centsToNumber(value), currency: v.currency?.trim() || CURRENCY,
    customerName: t.customer_name ?? '', device: deviceLabel(t), issuedDate: fmtDateTime(v.issued_at),
    message: `Voucher ${v.voucher_number} issued for ${formatMoney(value)} ${v.currency?.trim() || CURRENCY}.`,
  };
  if (replayed) out.replayed = true;
  return out;
}

/** issueVoucher_ — VENDOR_ANY; a branch user only for their own branch (enforced by the scoped load). */
export async function issueVoucher(ctx: Ctx, p: { tradeInId: string; notes?: string }, replacesVoucherId?: string) {
  const t = await loadTradeInScoped<TradeInRow>(ctx, p.tradeInId, { lock: true });
  if (ctx.p.branchId && t.branch_id !== ctx.p.branchId) {
    deny(ctx, 'voucher.branch', t.id);
    throw fail('This trade-in belongs to another branch.');
  }
  const live = (await ctx.db.query<VoucherRow>(`select * from public.vouchers where trade_in_id = $1 and status = 'ISSUED'`, [t.id])).rows[0];
  if (live) throw fail(`A voucher has already been issued for this trade-in: ${live.voucher_number}.`);

  const stateAllows = t.status === STATUS.DEVICE_RECEIVED || t.status === STATUS.AWAITING_VOUCHER;
  if (!stateAllows || !t.device_received) {
    ctx.denials.push({
      what: t.id, detail: '', action: ACTIONS.VOUCHER_BLOCKED, objectType: 'TRADEIN', vendorId: t.vendor_id, branchId: t.branch_id,
      details: { status: t.status, deviceReceived: t.device_received, reason: 'A voucher was requested before the device was in our hands.' },
    });
    throw fail('The device has not been received yet. Record the handover before issuing a voucher.');
  }
  const value = toCentsOrNull(t.final_customer_value);
  if (value === null || value < 0) throw fail('This trade-in has no agreed value.');
  if (value === 0 && !TRADEIN_CONFIG.ALLOW_ZERO_VALUE) throw fail('This device graded to zero, so there is nothing to issue.');

  const vendor = (await ctx.db.query<{ code: string }>('select code from public.vendors where id = $1', [t.vendor_id])).rows[0];
  const number = await nextVoucherNumber(ctx.db, vendor?.code ?? 'QM', now());
  const id = await nextId(ctx.db, 'VCH');
  await ctx.db.query(
    `insert into public.vouchers
       (id, trade_in_id, customer_id, vendor_id, branch_id, voucher_number, replaces_voucher_id, customer_value,
        commission_type_snapshot, commission_rate_snapshot, commission_value, total_settlement, currency, issued_by, status, notes, operation_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'ISSUED',$15,$16)`,
    [id, t.id, t.customer_id, t.vendor_id, t.branch_id, number, replacesVoucherId ?? null, t.final_customer_value,
      t.commission_type_snapshot, t.commission_rate_snapshot ?? '0', t.commission_value ?? '0', t.total_settlement ?? t.final_customer_value,
      t.currency?.trim() || CURRENCY, ctx.p.principalId, trim(p.notes) || null, replacesVoucherId ? null : (ctx.operationId || null)]);

  const issued = await transition(ctx, t, 'VOUCHER_ISSUED', { voucher_id: id }, ACTIONS.VOUCHER_ISSUED, {
    voucherNumber: number, value: centsToNumber(value), commission: m(t.commission_value), settlement: m(t.total_settlement),
  });
  await transition(ctx, issued, 'READY_FOR_COLLECTION', {}, ACTIONS.VOUCHER_ISSUED, { stage: 'ready for collection' });
  await emit.voucherIssued(ctx.db, t.id, t.customer_id, number, value);
  const v = (await ctx.db.query<VoucherRow>('select * from public.vouchers where id = $1', [id])).rows[0]!;
  return issuedReply(v, t);
}

/** voidVoucher_ — VENDOR_MGMT; reason required; refused once collected or settled. */
export async function voidVoucher(ctx: Ctx, p: { voucherId: string; reason?: string }) {
  const v = await loadVoucherScoped<VoucherRow>(ctx, p.voucherId, { lock: true });
  if (v.status !== 'ISSUED') throw fail('That voucher is not active.');
  if (isBlank(p.reason)) throw fail('Say why the voucher is being voided.');
  const t = (await ctx.db.query<TradeInRow>('select * from public.trade_ins where id = $1 for update', [v.trade_in_id])).rows[0];
  if (!t) throw fail('The trade-in for this voucher is missing.');
  if (t.settlement_id) throw fail('This voucher has already been settled and cannot be voided. Raise an adjustment with Qatar Mobile instead.');
  if (['COLLECTED', 'SETTLED', 'CLOSED'].includes(t.status)) throw fail('The device has already been collected. Raise an adjustment instead.');
  if (!canTransition(t.status, 'AWAITING_VOUCHER')) throw fail(`A trade-in at "${statusLabel(t.status)}" cannot have its voucher voided.`);

  const reason = trim(p.reason);
  await updateById(ctx.db, 'vouchers', v.id, { status: 'VOIDED', voided_by: ctx.p.principalId, voided_at: now(), void_reason: reason });
  const released = await releaseFromOpenBatch(ctx, t.id, `Voucher ${v.voucher_number} voided`);
  await transition(ctx, t, 'AWAITING_VOUCHER', {
    voucher_id: null, collection_batch_id: released ? null : t.collection_batch_id,
  }, ACTIONS.VOUCHER_VOIDED, { voucherNumber: v.voucher_number, reason, removedFromBatch: released || '' });
  return {
    ok: true, tradeInId: t.id,
    message: `Voucher ${v.voucher_number} voided. The device is still with us; a replacement voucher can be issued.${released ? ` It has been taken off collection note ${released}.` : ''}`,
  };
}

/** reissueVoucher_ — void and replace in ONE transaction, linking both ends of the chain. */
export async function reissueVoucher(ctx: Ctx, p: { voucherId: string; reason?: string }) {
  const original = await loadVoucherScoped<VoucherRow>(ctx, p.voucherId, { lock: true });
  if (original.status === 'VOIDED' && original.replaced_by_voucher_id) {
    const rep = (await ctx.db.query<VoucherRow>('select * from public.vouchers where id = $1', [original.replaced_by_voucher_id])).rows[0];
    const t = (await ctx.db.query<TradeInRow>('select * from public.trade_ins where id = $1', [original.trade_in_id])).rows[0];
    if (rep && t) return { ...issuedReply(rep, t, true), message: `Voucher reissued as ${rep.voucher_number}.` };
  }
  if (original.status === 'ISSUED') {
    await voidVoucher(ctx, p);
  } else {
    const t = (await ctx.db.query<TradeInRow>('select status, voucher_id from public.trade_ins where id = $1', [original.trade_in_id])).rows[0];
    if (!(t && t.status === STATUS.AWAITING_VOUCHER && !t.voucher_id)) throw fail('That voucher is not active.');
  }
  const issued = await issueVoucher(ctx, { tradeInId: original.trade_in_id, notes: `Replaces ${original.voucher_number}.` }, original.id);
  await updateById(ctx.db, 'vouchers', original.id, { replaced_by_voucher_id: issued.voucherId });
  await audit(ctx, ACTIONS.VOUCHER_REISSUED, 'VOUCHER', original.id, {
    oldValue: original.voucher_number, newValue: issued.voucherNumber, vendorId: original.vendor_id, branchId: original.branch_id,
    details: { reason: trim(p.reason) },
  });
  return { ...issued, message: `Voucher reissued as ${issued.voucherNumber}.` };
}

/** vendor.voidVoucher: reissue=true → reissue, else void. */
export async function voidOrReissue(ctx: Ctx, p: { voucherId: string; reason?: string; reissue?: unknown }) {
  return p.reissue === true || p.reissue === 'true' ? reissueVoucher(ctx, p) : voidVoucher(ctx, p);
}

async function vendorVoucherView(L: Lookups, v: VoucherRow) {
  return {
    voucherId: v.id, voucherNumber: v.voucher_number, tradeInId: v.trade_in_id, branchId: v.branch_id,
    branch: (await L.branch(v.branch_id))?.name ?? '', customerValue: m(v.customer_value), commission: m(v.commission_value),
    settlement: m(v.total_settlement), commissionRate: v.commission_rate_snapshot === null ? 0 : Number(v.commission_rate_snapshot) || 0,
    currency: v.currency?.trim() || CURRENCY, status: v.status, issuedDate: fmtDateTime(v.issued_at), voidedDate: fmtDateTime(v.voided_at),
    voidedBy: v.voided_by ?? '', voidReason: v.void_reason ?? '', replacedBy: v.replaced_by_voucher_id ?? '', replaces: v.replaces_voucher_id ?? '',
  };
}

/** listVouchers_: scoped by the principal, not by a parameter. */
export async function listVouchers(ctx: Ctx, f: { status?: string; branchId?: string; from?: string; to?: string; search?: string; limit?: number }) {
  const params: unknown[] = [];
  const where: string[] = [];
  if (!ctx.p.isPlatform) {
    params.push(ctx.p.vendorId); where.push(`vendor_id = $${params.length}`);
    if (ctx.p.branchId) { params.push(ctx.p.branchId); where.push(`branch_id = $${params.length}`); }
  }
  if (f.status) { params.push(f.status); where.push(`status = $${params.length}`); }
  if (f.branchId) { params.push(f.branchId); where.push(`branch_id = $${params.length}`); }
  const from = parseDayStart(f.from); const to = parseDayEnd(f.to);
  if (from) { params.push(from); where.push(`issued_at >= $${params.length}`); }
  if (to) { params.push(to); where.push(`issued_at <= $${params.length}`); }
  if (f.search) {
    params.push(`%${f.search.toLowerCase().replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
    where.push(`lower(voucher_number || ' ' || trade_in_id) like $${params.length}`);
  }
  const rows = (await ctx.db.query<VoucherRow>(`select * from public.vouchers ${where.length ? `where ${where.join(' and ')}` : ''} order by issued_at desc limit 20000`, params)).rows;
  const live = rows.filter((v) => v.status === 'ISSUED');
  const sum = (k: keyof VoucherRow) => centsToNumber(live.reduce((a, v) => a + (toCentsOrNull(v[k] as string) ?? 0), 0));
  const L = new Lookups(ctx.db);
  const out = [];
  for (const v of rows.slice(0, clampLimit(f.limit, 200, 1000))) out.push(await vendorVoucherView(L, v));
  return { ok: true, total: rows.length, totals: { customerValue: sum('customer_value'), commission: sum('commission_value'), settlement: sum('total_settlement') }, currency: CURRENCY, vouchers: out };
}
