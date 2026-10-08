/**
 * Settlements (18_Settlements.gs): Qatar Mobile paying a partner for the
 * devices it collected in a period.
 *
 *   DRAFT → SUBMITTED | CANCELLED; SUBMITTED → APPROVED | DRAFT;
 *   APPROVED → PAID; PAID → CLOSED.
 *   APPROVED only by SUPER_ADMIN. PAID needs a payment reference and moves
 *   every claimed trade-in COLLECTED → SETTLED → CLOSED in the same
 *   transaction (no half-paid state can exist any more).
 *
 * Claims are made under a FOR UPDATE lock on the partner row, so two
 * finance users settling the same period serialise and the second finds
 * nothing left to claim. The database independently refuses a claim of a
 * non-COLLECTED trade-in and any change to an approved settlement's money.
 */
import {
  ACTIONS, CURRENCY, SETTLEMENT_FLOW, SETTLEMENT_IMMUTABLE, SETTLEMENT_LOCKED, SETTLEMENT_STATUS_LABEL, type SettlementStatus,
} from '../../../../packages/domain/src/constants.js';
import { canSettlementTransition } from '../../../../packages/domain/src/workflow.js';
import { deny, requirePlatform, requireSettlementApprover, settlementVisibleTo } from '../../../../packages/auth/src/authz.js';
import { fail, notFound } from '../../../../packages/shared/src/errors.js';
import { centsToDecimal, centsToNumber, toCentsOrNull } from '../../../../packages/shared/src/money.js';
import { isBlank, trim } from '../../../../packages/shared/src/text.js';
import { fmtDate, fmtDateTime, parseDayEnd, parseDayStart } from '../../../../packages/shared/src/time.js';
import type { Ctx } from '../context.js';
import { audit } from '../lib/audit.js';
import { nextId } from '../lib/ids.js';
import { emit } from '../lib/notify.js';
import { appendNote, clampLimit, updateById } from './sql.js';
import { Lookups, deviceLabel, m, type TradeInRow } from './views.js';
import { transition } from './tradeins.js';

interface SettlementRow {
  id: string; vendor_id: string; period_from: Date; period_to: Date; trade_in_count: number; customer_value_total: string;
  commission_total: string; settlement_total: string; currency: string; status: SettlementStatus; collection_batch_ids: string[];
  created_by: string | null; created_at: Date; submitted_at: Date | null; approved_by: string | null; approved_at: Date | null;
  paid_at: Date | null; payment_reference: string | null; cancelled_by: string | null; cancelled_at: Date | null;
  cancel_reason: string | null; notes: string | null;
}

const now = (): Date => new Date();
const sum = (rows: TradeInRow[], k: keyof TradeInRow) => rows.reduce((a, t) => a + (toCentsOrNull(t[k] as string) ?? 0), 0);

/** settleableTradeIns_: COLLECTED, unclaimed, collected (own date, else the note's) inside the whole-day period. */
async function settleable(ctx: Ctx, vendorId: string, from: Date, to: Date, lock: boolean): Promise<TradeInRow[]> {
  return (await ctx.db.query<TradeInRow>(
    `select t.* from public.trade_ins t left join public.collections c on c.id = t.collection_batch_id
      where t.vendor_id = $1 and t.status = 'COLLECTED' and t.settlement_id is null
        and coalesce(t.collected_at, c.collected_at) is not null
        and coalesce(t.collected_at, c.collected_at) between $2 and $3
      order by t.created_at${lock ? ' for update of t' : ''}`, [vendorId, from, to])).rows;
}

/** undatedCollected_: collected and unsettled with no date — money no run can ever pick up. Named, not swallowed. */
async function undatedCollected(ctx: Ctx, vendorId: string | null) {
  return (await ctx.db.query<TradeInRow>(
    `select t.* from public.trade_ins t left join public.collections c on c.id = t.collection_batch_id
      where ($1::text is null or t.vendor_id = $1) and t.status = 'COLLECTED' and t.settlement_id is null
        and t.collected_at is null and c.collected_at is null`, [vendorId])).rows;
}

async function lineView(L: Lookups, t: TradeInRow) {
  return {
    tradeInId: t.id, device: deviceLabel(t), grade: t.grade_code ?? '', customerValue: m(t.final_customer_value),
    commissionRate: t.commission_rate_snapshot === null ? 0 : Number(t.commission_rate_snapshot) || 0, commission: m(t.commission_value),
    settlement: m(t.total_settlement), collectedDate: fmtDate(t.collected_at), collectedBy: t.collected_by ?? '',
    batchId: t.collection_batch_id ?? '', branch: (await L.branch(t.branch_id))?.name ?? '',
  };
}

function period(fromRaw: unknown, toRaw: unknown): { from: Date; to: Date } {
  const from = parseDayStart(fromRaw); const to = parseDayEnd(toRaw);
  if (!from || !to) throw fail('Choose the period to settle.');
  if (from > to) throw fail('The start of the period must come before the end.');
  return { from, to };
}

export async function previewSettlement(ctx: Ctx, p: { vendorId: string; from: string; to: string }) {
  requirePlatform(ctx);
  const { from, to } = period(p.from, p.to);
  const rows = await settleable(ctx, p.vendorId, from, to, false);
  const undated = await undatedCollected(ctx, p.vendorId);
  const L = new Lookups(ctx.db);
  const lines = [];
  for (const t of rows) lines.push(await lineView(L, t));
  return {
    ok: true, vendorId: p.vendorId, vendorName: (await L.vendor(p.vendorId))?.name ?? '', periodFrom: fmtDate(from), periodTo: fmtDate(to),
    tradeInCount: rows.length, customerValue: centsToNumber(sum(rows, 'final_customer_value')), commission: centsToNumber(sum(rows, 'commission_value')),
    settlement: centsToNumber(sum(rows, 'total_settlement')), currency: CURRENCY, tradeIns: lines,
    undatedCount: undated.length, undated: undated.map((t) => ({ tradeInId: t.id, device: t.model_snapshot ?? '', settlement: m(t.total_settlement) })),
  };
}

export async function createSettlement(ctx: Ctx, d: { vendorId: string; from: string; to: string; notes?: string }) {
  requirePlatform(ctx);
  const vendorId = trim(d.vendorId);
  const v = await ctx.db.query('select 1 from public.vendors where id = $1 for update', [vendorId]);
  if (!v.rowCount) throw fail('That vendor does not exist.');
  const { from, to } = period(d.from, d.to);
  const rows = await settleable(ctx, vendorId, from, to, true);
  if (!rows.length) throw fail('There is nothing collected and unsettled in that period.');

  const id = await nextId(ctx.db, 'STL');
  const cv = sum(rows, 'final_customer_value');
  const fee = sum(rows, 'commission_value');
  const total = sum(rows, 'total_settlement');
  const batchIds = [...new Set(rows.map((t) => t.collection_batch_id).filter((x): x is string => !!x))];
  // Header first inside the transaction (the claim FK needs it); atomicity replaces 3.1's claim-first ordering.
  await ctx.db.query(
    `insert into public.settlements (id, vendor_id, period_from, period_to, trade_in_count, customer_value_total, commission_total,
       settlement_total, currency, status, collection_batch_ids, created_by, notes, operation_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'QAR','DRAFT',$9,$10,$11,$12)`,
    [id, vendorId, from, to, rows.length, centsToDecimal(cv), centsToDecimal(fee), centsToDecimal(total), batchIds,
      ctx.p.principalId, trim(d.notes) || null, ctx.operationId || null]);
  const claimed = await ctx.db.query('update public.trade_ins set settlement_id = $1 where id = any($2::text[]) and settlement_id is null',
    [id, rows.map((t) => t.id)]);
  if (claimed.rowCount !== rows.length) throw fail('The trade-ins changed while the settlement was being prepared. Please try again.');

  await audit(ctx, ACTIONS.SETTLEMENT_CREATED, 'SETTLEMENT', id, {
    newValue: centsToNumber(total), vendorId, details: { vendorId, tradeIns: rows.length, period: `${fmtDate(from)} to ${fmtDate(to)}` },
  });
  await emit.settlementCreated(ctx.db, id, vendorId, rows.length, total);
  return { ok: true, settlementId: id, tradeInCount: rows.length, total: centsToNumber(total), currency: CURRENCY,
    message: `Settlement created for ${rows.length} trade-in(s).` };
}

/** closeSettledTradeIns_: COLLECTED → SETTLED → CLOSED for every claimed trade-in. */
async function closeSettledTradeIns(ctx: Ctx, settlementId: string): Promise<number> {
  const rows = (await ctx.db.query<TradeInRow>('select * from public.trade_ins where settlement_id = $1 order by id for update', [settlementId])).rows;
  let moved = 0;
  for (let t of rows) {
    if (t.status === 'COLLECTED') t = await transition(ctx, t, 'SETTLED', {}, ACTIONS.SETTLEMENT_PAID, { settlementId });
    if (t.status === 'SETTLED') { await transition(ctx, t, 'CLOSED', {}, ACTIONS.TRADEIN_CLOSED, { outcome: 'settled and paid' }); moved++; }
  }
  return moved;
}

export async function advanceSettlement(ctx: Ctx, settlementId: string, toStatus: string, d: { paymentReference?: string }) {
  requirePlatform(ctx);
  const s = (await ctx.db.query<SettlementRow>('select * from public.settlements where id = $1 for update', [settlementId])).rows[0];
  if (!s) throw fail('That settlement does not exist.');
  const from = s.status;
  const to = trim(toStatus).toUpperCase() as SettlementStatus;

  if (from === 'PAID' && to === 'PAID') {
    // In 3.1 this completed a payment that stopped half-way. One transaction makes that state impossible.
    const finished = await closeSettledTradeIns(ctx, s.id);
    if (finished) return { ok: true, message: `Settlement paid. ${finished} trade-in(s) completed now.` };
    throw fail('This settlement has been paid and cannot be changed. Raise an adjustment instead.');
  }
  if (SETTLEMENT_IMMUTABLE.includes(from) && to !== 'CLOSED') {
    deny(ctx, 'settlement.immutable', s.id);
    throw fail('This settlement has been paid and cannot be changed. Raise an adjustment instead.');
  }
  if (!canSettlementTransition(from, to)) {
    throw fail(`A settlement at "${(SETTLEMENT_STATUS_LABEL[from] ?? from).toLowerCase()}" cannot move to "${(SETTLEMENT_STATUS_LABEL[to] ?? to).toLowerCase()}".`);
  }
  const patch: Record<string, unknown> = { status: to };
  let action: string = ACTIONS.SETTLEMENT_SUBMITTED;
  if (to === 'SUBMITTED') { patch.submitted_at = now(); action = ACTIONS.SETTLEMENT_SUBMITTED; }
  else if (to === 'APPROVED') {
    requireSettlementApprover(ctx, s.id);
    patch.approved_by = ctx.p.principalId; patch.approved_at = now(); action = ACTIONS.SETTLEMENT_APPROVED;
  } else if (to === 'PAID') {
    if (isBlank(d.paymentReference)) throw fail('Record the payment reference.');
    patch.paid_at = now(); patch.payment_reference = trim(d.paymentReference); action = ACTIONS.SETTLEMENT_PAID;
  } else if (to === 'CLOSED') action = ACTIONS.SETTLEMENT_CLOSED;
  else if (to === 'DRAFT') action = ACTIONS.SETTLEMENT_REOPENED;

  if (to === 'PAID') await closeSettledTradeIns(ctx, s.id);
  await updateById(ctx.db, 'settlements', s.id, patch);
  await audit(ctx, action, 'SETTLEMENT', s.id, {
    oldValue: from, newValue: to, vendorId: s.vendor_id, details: { total: m(s.settlement_total), reference: trim(d.paymentReference) },
  });
  if (to === 'PAID') await emit.settlementPaid(ctx.db, s.id, s.vendor_id, toCentsOrNull(s.settlement_total) ?? 0);
  return { ok: true, message: `Settlement ${(SETTLEMENT_STATUS_LABEL[to] ?? to).toLowerCase()}.` };
}

export async function cancelSettlement(ctx: Ctx, settlementId: string, reason: string | undefined) {
  requirePlatform(ctx);
  const s = (await ctx.db.query<SettlementRow>('select * from public.settlements where id = $1 for update', [settlementId])).rows[0];
  if (!s) throw fail('That settlement does not exist.');
  if (s.status !== 'DRAFT') throw fail('Only a draft settlement can be cancelled.');
  if (isBlank(reason)) throw fail('Say why this settlement is being cancelled.');
  const released = await ctx.db.query('update public.trade_ins set settlement_id = null where settlement_id = $1', [s.id]);
  await updateById(ctx.db, 'settlements', s.id, {
    status: 'CANCELLED', cancelled_by: ctx.p.principalId, cancelled_at: now(), cancel_reason: trim(reason),
    notes: appendNote(s.notes, `Cancelled: ${trim(reason)}`, fmtDateTime(now())),
  });
  await audit(ctx, ACTIONS.SETTLEMENT_CANCELLED, 'SETTLEMENT', s.id, {
    oldValue: 'DRAFT', newValue: 'CANCELLED', vendorId: s.vendor_id, details: { reason: trim(reason), released: released.rowCount },
  });
  return { ok: true, message: `Settlement cancelled. ${released.rowCount} trade-in(s) are available to settle again.` };
}

/** admin.advanceSettlement: action=CANCEL → cancel, else advance to toStatus. */
export async function advanceOrCancel(ctx: Ctx, p: { settlementId: string; action?: string; toStatus?: string; reason?: string; paymentReference?: string }) {
  return trim(p.action).toUpperCase() === 'CANCEL'
    ? cancelSettlement(ctx, p.settlementId, p.reason)
    : advanceSettlement(ctx, p.settlementId, p.toStatus ?? '', p);
}

async function settlementView(L: Lookups, s: SettlementRow) {
  return {
    settlementId: s.id, vendorId: s.vendor_id, vendorName: (await L.vendor(s.vendor_id))?.name ?? '',
    periodFrom: fmtDate(s.period_from), periodTo: fmtDate(s.period_to), tradeInCount: s.trade_in_count || 0,
    customerValue: m(s.customer_value_total), commission: m(s.commission_total), settlement: m(s.settlement_total),
    currency: s.currency?.trim() || CURRENCY, status: s.status, statusLabel: SETTLEMENT_STATUS_LABEL[s.status] ?? s.status,
    locked: SETTLEMENT_LOCKED.includes(s.status), immutable: SETTLEMENT_IMMUTABLE.includes(s.status), batchIds: s.collection_batch_ids ?? [],
    createdDate: fmtDate(s.created_at), createdBy: s.created_by ?? '', submittedDate: fmtDate(s.submitted_at),
    approvedDate: fmtDate(s.approved_at), approvedBy: s.approved_by ?? '', paidDate: fmtDate(s.paid_at),
    cancelledDate: fmtDate(s.cancelled_at), cancelReason: s.cancel_reason ?? '', reference: s.payment_reference ?? '', notes: s.notes ?? '',
  };
}

export async function listSettlements(ctx: Ctx, f: { vendorId?: string; status?: string; from?: string; to?: string; limit?: number }) {
  const params: unknown[] = [];
  const where: string[] = [];
  if (!ctx.p.isPlatform) { params.push(ctx.p.vendorId); where.push(`vendor_id = $${params.length}`); }
  if (f.vendorId) { params.push(f.vendorId); where.push(`vendor_id = $${params.length}`); }
  if (f.status) { params.push(f.status); where.push(`status = $${params.length}`); }
  const from = parseDayStart(f.from); const to = parseDayEnd(f.to);
  if (from) { params.push(from); where.push(`created_at >= $${params.length}`); }
  if (to) { params.push(to); where.push(`created_at <= $${params.length}`); }
  const all = (await ctx.db.query<SettlementRow>(`select * from public.settlements ${where.length ? `where ${where.join(' and ')}` : ''} order by created_at desc limit 5000`, params)).rows;
  const rows: SettlementRow[] = [];
  for (const s of all) if (await settlementVisibleTo(ctx, s)) rows.push(s);
  const unpaid = rows.filter((s) => !['PAID', 'CLOSED', 'CANCELLED'].includes(s.status));
  const L = new Lookups(ctx.db);
  const out = [];
  for (const s of rows.slice(0, clampLimit(f.limit, 100, 500))) out.push(await settlementView(L, s));
  return {
    total: rows.length, outstanding: centsToNumber(unpaid.reduce((a, s) => a + (toCentsOrNull(s.settlement_total) ?? 0), 0)),
    currency: CURRENCY, settlements: out,
  };
}

export async function settlementDetail(ctx: Ctx, settlementId: string) {
  const s = (await ctx.db.query<SettlementRow>('select * from public.settlements where id = $1', [settlementId])).rows[0];
  if (!s) throw notFound('That settlement does not exist.');
  if (!(await settlementVisibleTo(ctx, s))) {
    deny(ctx, 'object.settlement', settlementId);
    throw notFound('That settlement does not exist.');
  }
  const L = new Lookups(ctx.db);
  const view: Record<string, unknown> = await settlementView(L, s);
  const lines = (await ctx.db.query<TradeInRow>('select * from public.trade_ins where settlement_id = $1 order by created_at', [s.id])).rows;
  const lv = [];
  for (const t of lines) lv.push(await lineView(L, t));
  view.lines = lv;
  return { ok: true, ...view };
}

/** admin.settlements / vendor.settlements. */
export async function settlementsAction(ctx: Ctx, p: { settlementId?: string; preview?: unknown; vendorId?: string; from?: string; to?: string; status?: string; limit?: number }) {
  if (p.settlementId) return settlementDetail(ctx, p.settlementId);
  if (p.preview === true || p.preview === 'true') return previewSettlement(ctx, { vendorId: p.vendorId ?? '', from: p.from ?? '', to: p.to ?? '' });
  return { ok: true, ...(await listSettlements(ctx, p)) };
}

export { SETTLEMENT_FLOW };
