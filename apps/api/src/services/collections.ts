/**
 * Collection notes (17_Collections.gs): Qatar Mobile picking up devices a
 * partner has paid out vouchers for.
 *
 * A device is "claimed" by a PENDING line on an OPEN note; the partial
 * unique index collection_items_one_pending makes a double claim
 * impossible. A note's status is DERIVED from its lines (recalcBatch).
 * The 3.1 interrupted-run repairs (orphan lines, half-stamped trade-ins)
 * cannot occur in one transaction, so they are not reproduced.
 */
import { ACTIONS, COLLECTION_ITEM_STATUS, COLLECTION_OPEN_STATUSES, CURRENCY, STATUS } from '../../../../packages/domain/src/constants.js';
import { canTransition, recalcBatch } from '../../../../packages/domain/src/workflow.js';
import { canSeeFullImei, loadBatchScoped, scopeBranch, scopeVendor } from '../../../../packages/auth/src/authz.js';
import { fail, invalid } from '../../../../packages/shared/src/errors.js';
import { centsToDecimal, centsToNumber, toCentsOrNull } from '../../../../packages/shared/src/money.js';
import { isBlank, maskImei, statusLabel, trim } from '../../../../packages/shared/src/text.js';
import { fmtDate, fmtDateTime, parseDayEnd, parseDayStart } from '../../../../packages/shared/src/time.js';
import type { Ctx } from '../context.js';
import type { Queryable } from '../../../../packages/database/src/db.js';
import { audit } from '../lib/audit.js';
import { nextId } from '../lib/ids.js';
import { emit } from '../lib/notify.js';
import { appendNote, clampLimit, updateById } from './sql.js';
import { Lookups, deviceLabel, m, type TradeInRow } from './views.js';
import { transition } from './tradeins.js';

interface BatchRow {
  id: string; vendor_id: string; branch_id: string | null; trade_in_ids: string[]; device_count: number;
  expected_device_count: number; collected_device_count: number; missing_device_count: number; exception_device_count: number;
  customer_value_total: string; commission_total: string; settlement_total: string; expected_amount: string; actual_amount: string;
  currency: string; status: string; created_by: string | null; created_at: Date; collected_by: string | null; collected_at: Date | null;
  closed_at: Date | null; cancelled_by: string | null; cancelled_at: Date | null; cancel_reason: string | null; notes: string | null;
}
interface LineRow {
  id: string; batch_id: string; trade_in_id: string; vendor_id: string; branch_id: string | null; device_snapshot: string | null;
  imei: string | null; grade_code: string | null; customer_value: string; commission_value: string; settlement_value: string;
  item_status: string; collected_by: string | null; collected_at: Date | null; exception_reason: string | null;
}

const now = (): Date => new Date();
const sumCol = (rows: Record<string, unknown>[], k: string) => rows.reduce((a, r) => a + (toCentsOrNull(r[k] as string) ?? 0), 0);

/** recalcBatch_: recount from lines and write the derived header fields. */
export async function recalcAndStore(db: Queryable, batchId: string) {
  const lines = (await db.query<LineRow>('select * from public.collection_items where batch_id = $1', [batchId])).rows;
  const s = recalcBatch(lines.map((l) => ({ itemStatus: l.item_status, settlementCents: toCentsOrNull(l.settlement_value) ?? 0 })));
  await updateById(db, 'collections', batchId, {
    status: s.status, expected_device_count: s.expected, collected_device_count: s.collected,
    missing_device_count: s.missing, exception_device_count: s.rejected + s.exception, actual_amount: centsToDecimal(s.actualCents),
  });
  return s;
}

async function markItem(ctx: Ctx, lineId: string, status: string, reason: string) {
  const collected = status === COLLECTION_ITEM_STATUS.COLLECTED;
  await updateById(ctx.db, 'collection_items', lineId, {
    item_status: status, collected_by: collected ? ctx.p.name : null, collected_at: collected ? now() : null,
    exception_reason: reason ? reason : null,
  });
}

/**
 * releaseFromOpenBatch_: take one trade-in off whatever open note it sits
 * on (voucher voided). The line becomes EXCEPTION with the reason, not
 * deleted, so the note still shows what happened. Returns the note id or ''.
 */
export async function releaseFromOpenBatch(ctx: Ctx, tradeInId: string, reason: string): Promise<string> {
  const r = await ctx.db.query<{ id: string; batch_id: string }>(
    `select i.id, i.batch_id from public.collection_items i join public.collections c on c.id = i.batch_id
      where i.trade_in_id = $1 and i.item_status = 'PENDING' and c.status = any($2::text[])
      for update of i`, [tradeInId, COLLECTION_OPEN_STATUSES]);
  const line = r.rows[0];
  if (!line) return '';
  await ctx.db.query('select 1 from public.collections where id = $1 for update', [line.batch_id]);
  await markItem(ctx, line.id, COLLECTION_ITEM_STATUS.EXCEPTION, reason);
  await recalcAndStore(ctx.db, line.batch_id);
  return line.batch_id;
}

/** createCollectionBatch_ (ADMIN_ONLY in the registry). */
export async function createBatch(ctx: Ctx, d: { vendorId?: string; branchId?: string; tradeInIds?: string[]; notes?: string }) {
  const vendorId = scopeVendor(ctx, d.vendorId);
  if (!vendorId) throw fail('Choose a vendor.');
  const branchId = await scopeBranch(ctx, d.branchId);
  // Serialise note creation per partner: the eligibility read below cannot race another note.
  const v = await ctx.db.query('select 1 from public.vendors where id = $1 for update', [vendorId]);
  if (!v.rowCount) throw fail('Choose a vendor.');

  const params: unknown[] = [vendorId];
  let sql = `select t.* from public.trade_ins t
              where t.vendor_id = $1 and t.status = 'READY_FOR_COLLECTION'
                and not exists (select 1 from public.collection_items i join public.collections c on c.id = i.batch_id
                                 where i.trade_in_id = t.id and i.item_status = 'PENDING' and c.status = any($2::text[]))`;
  params.push(COLLECTION_OPEN_STATUSES);
  if (branchId) { params.push(branchId); sql += ` and t.branch_id = $${params.length}`; }
  if (d.tradeInIds?.length) { params.push(d.tradeInIds.map(String)); sql += ` and t.id = any($${params.length}::text[])`; }
  sql += ' order by t.created_at for update of t';
  const eligible = (await ctx.db.query<TradeInRow>(sql, params)).rows;
  if (!eligible.length) throw fail('There is nothing ready for collection at that branch.');

  const ids = eligible.map((t) => t.id);
  const expected = sumCol(eligible as never, 'total_settlement');
  const batchId = await nextId(ctx.db, 'BAT');
  await ctx.db.query(
    `insert into public.collections
       (id, vendor_id, branch_id, trade_in_ids, device_count, expected_device_count, collected_device_count, missing_device_count,
        exception_device_count, customer_value_total, commission_total, settlement_total, expected_amount, actual_amount,
        currency, status, created_by, notes, operation_id)
     values ($1,$2,$3,$4,$5,$5,0,0,0,$6,$7,$8,$8,0,'QAR','READY_FOR_COLLECTION',$9,$10,$11)`,
    [batchId, vendorId, branchId, ids, ids.length, centsToDecimal(sumCol(eligible as never, 'final_customer_value')),
      centsToDecimal(sumCol(eligible as never, 'commission_value')), centsToDecimal(expected), ctx.p.principalId,
      trim(d.notes) || null, ctx.operationId || null]);
  for (const t of eligible) {
    const lineId = await nextId(ctx.db, 'CLI');
    await ctx.db.query(
      `insert into public.collection_items
         (id, batch_id, trade_in_id, vendor_id, branch_id, device_snapshot, imei, grade_code, customer_value, commission_value, settlement_value, item_status)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'PENDING')`,
      [lineId, batchId, t.id, vendorId, t.branch_id, deviceLabel(t), t.imei, t.grade_code,
        centsToDecimal(toCentsOrNull(t.final_customer_value) ?? 0), centsToDecimal(toCentsOrNull(t.commission_value) ?? 0),
        centsToDecimal(toCentsOrNull(t.total_settlement) ?? 0)]);
    await ctx.db.query('update public.trade_ins set collection_batch_id = $1 where id = $2', [batchId, t.id]);
  }
  await audit(ctx, ACTIONS.COLLECTION_CREATED, 'COLLECTION', batchId, {
    newValue: ids.length, vendorId, branchId: branchId ?? undefined,
    details: { vendorId, branchId: branchId || '(all branches)', expectedAmount: centsToNumber(expected) },
  });
  for (const id of ids) await audit(ctx, ACTIONS.COLLECTION_CREATED, 'TRADEIN', id, { vendorId, details: { batchId } });
  await emit.collectionReady(ctx.db, batchId, vendorId, ids.length, expected, branchId ?? '');
  return { ok: true, batchId, deviceCount: ids.length, message: `Collection note created for ${ids.length} device(s).` };
}

/** markBatchCollected_: per-device outcomes; anything not named counts as COLLECTED. */
export async function markCollected(ctx: Ctx, batchId: string, d: { items?: { tradeInId: string; status?: string; reason?: string }[]; notes?: string }) {
  const batch = await loadBatchScoped<BatchRow>(ctx, batchId, { lock: true });
  if (!COLLECTION_OPEN_STATUSES.includes(batch.status)) throw fail('That collection note is not open.');

  const decisions = new Map<string, { status: string; reason: string }>();
  for (const row of d.items ?? []) {
    const status = trim(row.status).toUpperCase();
    if (!(status in COLLECTION_ITEM_STATUS)) continue;
    // PENDING is the state being resolved, not an outcome. 3.1 accepted it and then
    // released the device while leaving the line pending (review finding): refused.
    if (status === 'PENDING') throw invalid('A device can be marked collected, missing, rejected or as an exception — not pending.');
    decisions.set(trim(row.tradeInId), { status, reason: trim(row.reason) });
  }
  const lines = (await ctx.db.query<LineRow>(
    `select * from public.collection_items where batch_id = $1 and item_status = 'PENDING' order by id for update`, [batch.id])).rows;
  if (!lines.length) throw fail('Every device on this note has been resolved.');

  let collected = 0; let notCollected = 0;
  const unresolved: string[] = [];
  for (const line of lines) {
    const decision = decisions.get(line.trade_in_id) ?? { status: 'COLLECTED', reason: '' };
    if (decision.status !== 'COLLECTED' && !decision.reason) decision.reason = 'No reason recorded.';
    const t = (await ctx.db.query<TradeInRow>('select * from public.trade_ins where id = $1 for update', [line.trade_in_id])).rows[0];
    if (!t) {
      await markItem(ctx, line.id, 'EXCEPTION', 'The trade-in record is missing.');
      unresolved.push(`${line.trade_in_id} (record missing)`); notCollected++; continue;
    }
    if (decision.status === 'COLLECTED') {
      if (!canTransition(t.status, STATUS.COLLECTED)) {
        await markItem(ctx, line.id, 'EXCEPTION', `The trade-in is at "${statusLabel(t.status)}" and cannot be collected.`);
        await updateById(ctx.db, 'trade_ins', t.id, { collection_batch_id: null });
        unresolved.push(`${t.id} (${statusLabel(t.status)})`); notCollected++; continue;
      }
      // THE REAL COLLECTED DATE: written here and nowhere else — it decides the settlement period.
      await transition(ctx, t, 'COLLECTED', { collected_at: now(), collected_by: `${ctx.p.name} (${ctx.p.principalId})` },
        ACTIONS.DEVICE_COLLECTED, { batchId: batch.id });
      await markItem(ctx, line.id, 'COLLECTED', '');
      collected++;
      continue;
    }
    await markItem(ctx, line.id, decision.status, decision.reason);
    await updateById(ctx.db, 'trade_ins', t.id, { collection_batch_id: null });
    await audit(ctx, ACTIONS.DEVICE_NOT_COLLECTED, 'TRADEIN', t.id, {
      newValue: decision.status, vendorId: t.vendor_id, branchId: t.branch_id, details: { batchId: batch.id, reason: decision.reason },
    });
    unresolved.push(`${t.id} (${decision.status.toLowerCase()})`); notCollected++;
  }
  const summary = await recalcAndStore(ctx.db, batch.id);
  await updateById(ctx.db, 'collections', batch.id, {
    collected_by: ctx.p.principalId, collected_at: now(), notes: appendNote(batch.notes, d.notes, fmtDateTime(now())),
  });
  await audit(ctx, ACTIONS.COLLECTION_MARKED, 'COLLECTION', batch.id, {
    newValue: collected, vendorId: batch.vendor_id,
    details: { collected, notCollected, status: summary.status, actualAmount: centsToNumber(summary.actualCents), unresolved },
  });
  if (summary.status === 'COLLECTION_EXCEPTION') await emit.collectionException(ctx.db, batch.id, unresolved);
  return {
    ok: true, collected, notCollected, unresolved, status: summary.status, actualAmount: centsToNumber(summary.actualCents),
    message: `${collected} device(s) collected.${notCollected ? ` ${notCollected} were not, and have been returned to the branch list so they can be collected later.` : ''}`,
  };
}

/** closeBatch_: refused while anything is pending or unresolved. */
export async function closeBatch(ctx: Ctx, batchId: string) {
  const batch = await loadBatchScoped<BatchRow>(ctx, batchId, { lock: true });
  const s = await recalcAndStore(ctx.db, batch.id);
  if (s.pending) throw fail(`${s.pending} device(s) on this note have not been accounted for. Record what happened to them first.`);
  if (s.missing || s.rejected || s.exception) {
    throw fail(`This note has ${s.missing + s.rejected + s.exception} unresolved device(s). Resolve them before closing it.`);
  }
  await updateById(ctx.db, 'collections', batch.id, { status: 'CLOSED', closed_at: now() });
  await audit(ctx, ACTIONS.COLLECTION_CLOSED, 'COLLECTION', batch.id, { vendorId: batch.vendor_id });
  return { ok: true, message: 'Collection note closed.' };
}

/** cancelBatch_: only while nothing on it has been collected. */
export async function cancelBatch(ctx: Ctx, batchId: string, reason: string | undefined) {
  const batch = await loadBatchScoped<BatchRow>(ctx, batchId, { lock: true });
  if (isBlank(reason)) throw fail('Say why this note is being cancelled.');
  const s = await recalcAndStore(ctx.db, batch.id);
  if (s.collected) throw fail(`${s.collected} device(s) on this note have already been collected, so it cannot be cancelled.`);
  const pending = (await ctx.db.query<LineRow>(`select * from public.collection_items where batch_id = $1 and item_status = 'PENDING' for update`, [batch.id])).rows;
  for (const line of pending) {
    await markItem(ctx, line.id, 'EXCEPTION', `Note cancelled: ${trim(reason)}`);
    await ctx.db.query('update public.trade_ins set collection_batch_id = null where id = $1 and collection_batch_id = $2', [line.trade_in_id, batch.id]);
  }
  await updateById(ctx.db, 'collections', batch.id, {
    status: 'CANCELLED', cancelled_by: ctx.p.principalId, cancelled_at: now(), cancel_reason: trim(reason),
    notes: appendNote(batch.notes, `Cancelled: ${trim(reason)}`, fmtDateTime(now())),
  });
  await audit(ctx, ACTIONS.COLLECTION_CANCELLED, 'COLLECTION', batch.id, { vendorId: batch.vendor_id, details: { reason: trim(reason), released: s.pending } });
  return { ok: true, message: `Collection note cancelled. ${s.pending} device(s) are available to collect again.` };
}

/** admin.updateBatch: COLLECT (default) | CLOSE | CANCEL. */
export async function updateBatch(ctx: Ctx, p: { batchId: string; action?: string; reason?: string; items?: { tradeInId: string; status?: string; reason?: string }[]; notes?: string }) {
  const action = trim(p.action).toUpperCase();
  if (action === 'CLOSE') return closeBatch(ctx, p.batchId);
  if (action === 'CANCEL') return cancelBatch(ctx, p.batchId, p.reason);
  return markCollected(ctx, p.batchId, p);
}

/* ------------------------------------------------------------------ views */

async function batchView(L: Lookups, b: BatchRow) {
  return {
    batchId: b.id, vendorId: b.vendor_id, vendorName: (await L.vendor(b.vendor_id))?.name ?? '',
    branchId: b.branch_id ?? '', branchName: (await L.branch(b.branch_id))?.name ?? 'All branches',
    expectedDevices: b.expected_device_count || b.device_count || 0, collectedDevices: b.collected_device_count || 0,
    missingDevices: b.missing_device_count || 0, exceptionDevices: b.exception_device_count || 0, deviceCount: b.device_count || 0,
    customerValue: m(b.customer_value_total), commission: m(b.commission_total), settlement: m(b.settlement_total),
    expectedAmount: m(b.expected_amount) || m(b.settlement_total), actualAmount: m(b.actual_amount),
    currency: b.currency?.trim() || CURRENCY, status: b.status, statusLabel: statusLabel(b.status),
    createdDate: fmtDateTime(b.created_at), createdBy: b.created_by ?? '', collectedDate: fmtDateTime(b.collected_at),
    collectedBy: b.collected_by ?? '', closedDate: fmtDate(b.closed_at), cancelReason: b.cancel_reason ?? '', notes: b.notes ?? '',
  };
}

function scopeWhere(ctx: Ctx, params: unknown[], alias = ''): string[] {
  const where: string[] = [];
  if (!ctx.p.isPlatform) {
    params.push(ctx.p.vendorId); where.push(`${alias}vendor_id = $${params.length}`);
    if (ctx.p.branchId) { params.push(ctx.p.branchId); where.push(`${alias}branch_id = $${params.length}`); }
  }
  return where;
}

export async function listCollections(ctx: Ctx, f: { status?: string; vendorId?: string; branchId?: string; from?: string; to?: string; limit?: number }) {
  const params: unknown[] = [];
  const where = scopeWhere(ctx, params);
  if (f.status) { params.push(f.status); where.push(`status = $${params.length}`); }
  if (f.vendorId) { params.push(f.vendorId); where.push(`vendor_id = $${params.length}`); }
  if (f.branchId) { params.push(f.branchId); where.push(`branch_id = $${params.length}`); }
  const from = parseDayStart(f.from); const to = parseDayEnd(f.to);
  if (from) { params.push(from); where.push(`created_at >= $${params.length}`); }
  if (to) { params.push(to); where.push(`created_at <= $${params.length}`); }
  const rows = (await ctx.db.query<BatchRow>(`select * from public.collections ${where.length ? `where ${where.join(' and ')}` : ''} order by created_at desc limit 5000`, params)).rows;
  const open = rows.filter((b) => COLLECTION_OPEN_STATUSES.includes(b.status));
  const L = new Lookups(ctx.db);
  const batches = [];
  for (const b of rows.slice(0, clampLimit(f.limit, 100, 500))) batches.push(await batchView(L, b));
  const openValue = open.reduce((a, b) => a + ((toCentsOrNull(b.expected_amount) || toCentsOrNull(b.settlement_total) || 0) - (toCentsOrNull(b.actual_amount) ?? 0)), 0);
  return {
    total: rows.length, openCount: open.length, openValue: centsToNumber(openValue),
    exceptionCount: rows.filter((b) => b.status === 'COLLECTION_EXCEPTION').length, currency: CURRENCY, batches,
  };
}

export async function batchDetail(ctx: Ctx, batchId: string) {
  const b = await loadBatchScoped<BatchRow>(ctx, batchId);
  const view: Record<string, unknown> = await batchView(new Lookups(ctx.db), b);
  const lines = (await ctx.db.query<LineRow & { trade_in_status: string | null }>(
    `select i.*, t.status as trade_in_status from public.collection_items i left join public.trade_ins t on t.id = i.trade_in_id
      where i.batch_id = $1 order by i.id`, [b.id])).rows;
  const full = canSeeFullImei(ctx.p);
  view.devices = lines.map((l) => ({
    itemId: l.id, tradeInId: l.trade_in_id, device: l.device_snapshot ?? '', grade: l.grade_code ?? '',
    imei: full ? (l.imei ?? '') : maskImei(l.imei), value: m(l.customer_value), settlement: m(l.settlement_value),
    itemStatus: l.item_status, reason: l.exception_reason ?? '', collectedDate: fmtDateTime(l.collected_at),
    collectedBy: l.collected_by ?? '', tradeInStatus: l.trade_in_status ?? 'MISSING',
  }));
  view.itemStatuses = Object.keys(COLLECTION_ITEM_STATUS).map((k) => ({ value: k, label: statusLabel(k) }));
  return { ok: true, ...view };
}

/** pendingCollectionSummary_: what is sitting at each branch, and for how long. */
export async function pendingCollectionSummary(ctx: Ctx) {
  const params: unknown[] = [COLLECTION_OPEN_STATUSES];
  const where = scopeWhere(ctx, params, 't.');
  const rows = (await ctx.db.query<{ branch_id: string; vendor_id: string; n: number; value: string; oldest: Date | null }>(
    `select t.branch_id, t.vendor_id, count(*)::int as n, coalesce(sum(t.total_settlement),0)::text as value,
            min(coalesce(v.issued_at, t.device_received_at, t.created_at)) as oldest
       from public.trade_ins t left join public.vouchers v on v.id = t.voucher_id
      where t.status = 'READY_FOR_COLLECTION'
        and not exists (select 1 from public.collection_items i join public.collections c on c.id = i.batch_id
                         where i.trade_in_id = t.id and i.item_status = 'PENDING' and c.status = any($1::text[]))
        ${where.length ? `and ${where.join(' and ')}` : ''}
      group by t.branch_id, t.vendor_id`, params)).rows;
  const L = new Lookups(ctx.db);
  const out = [];
  for (const r of rows) {
    out.push({
      branchId: r.branch_id, branchName: (await L.branch(r.branch_id))?.name ?? '(no branch)', vendorId: r.vendor_id,
      vendorName: (await L.vendor(r.vendor_id))?.name ?? '', deviceCount: r.n, value: m(r.value), currency: CURRENCY,
      oldestDays: r.oldest ? Math.floor((Date.now() - new Date(r.oldest).getTime()) / 86_400_000) : 0,
    });
  }
  return out.sort((a, b) => b.value - a.value);
}

export async function adminCollections(ctx: Ctx, p: { batchId?: string } & Parameters<typeof listCollections>[1]) {
  if (p.batchId) return batchDetail(ctx, p.batchId);
  return { ok: true, batches: await listCollections(ctx, p), pending: await pendingCollectionSummary(ctx) };
}
