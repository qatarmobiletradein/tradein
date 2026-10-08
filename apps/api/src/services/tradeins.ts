/**
 * Trade-ins: creation, the customer's decision, custody, admin
 * corrections, queues and views (14_TradeIns.gs, 25_Questionnaire.gs).
 *
 * Every state change runs inside the request transaction with the trade-in
 * row locked FOR UPDATE, re-checks the state on that fresh row, and writes
 * its audit row in the same transaction.
 */
import {
  ACTIONS, ADMIN_ONLY, CORRECTABLE_STATUSES, CURRENCY, IMEI_FREE_STATUSES, ROLE_LABELS, STATUS, TRADEIN_CONFIG,
  type TradeInStatus,
} from '../../../../packages/domain/src/constants.js';
import { canTransition, inCustody } from '../../../../packages/domain/src/workflow.js';
import { customerAnswersComplete, gradeCustomerAnswers, normalizeCustomerAnswers } from '../../../../packages/domain/src/questionnaire.js';
import { topGrade } from '../../../../packages/domain/src/grading.js';
import { assertBranchBelongsTo, deny, loadTradeInScoped, scopeBranch } from '../../../../packages/auth/src/authz.js';
import { AppError, fail, forbidden, notFound } from '../../../../packages/shared/src/errors.js';
import {
  centsToDecimal, centsToNumber, clampCents, formatMoney, microToDecimal, toCents, toCentsOrNull, variance, fraction4ToDecimal,
} from '../../../../packages/shared/src/money.js';
import { digitsOnly, isBlank, isValidImei, maskImei, sameLabel, statusLabel, trim } from '../../../../packages/shared/src/text.js';
import { fmtDateTime, parseDayEnd, parseDayStart } from '../../../../packages/shared/src/time.js';
import type { Ctx } from '../context.js';
import { audit } from '../lib/audit.js';
import { nextTradeInId } from '../lib/ids.js';
import { emit } from '../lib/notify.js';
import { loadGradeLadder, loadInspectionRules, partnerFee, quote } from '../lib/rules.js';
import { appendNote, clampLimit, updateById } from './sql.js';
import {
  Lookups, adminTradeInView, customerTradeInView, deviceLabel, m, publicBranchView, technicianQueueView, vendorTradeInView,
  type TradeInRow,
} from './views.js';

/* ------------------------------------------------------------- transition */

/**
 * transition_: state machine check on the LOCKED row, the update, and the
 * audit row. The database trigger enforces the same table as a backstop.
 */
export async function transition(
  ctx: Ctx, t: TradeInRow, to: TradeInStatus, patch: Record<string, unknown>, action: string, details?: Record<string, unknown>,
): Promise<TradeInRow> {
  if (!canTransition(t.status, to)) {
    throw fail(`A trade-in at "${statusLabel(t.status)}" cannot move to "${statusLabel(to)}".`);
  }
  await updateById(ctx.db, 'trade_ins', t.id, { status: to, ...patch });
  await audit(ctx, action || 'STATUS_CHANGED', 'TRADEIN', t.id, {
    oldValue: t.status, newValue: to, details, vendorId: t.vendor_id, branchId: t.branch_id,
  });
  return { ...t, status: to, ...(patch as Partial<TradeInRow>) };
}

export async function reloadTradeIn(ctx: Ctx, id: string): Promise<TradeInRow> {
  const r = await ctx.db.query<TradeInRow>('select * from public.trade_ins where id = $1', [id]);
  if (!r.rows[0]) throw notFound('Trade-in not found.');
  return r.rows[0];
}

const now = (): Date => new Date();

/* ---------------------------------------------------------------- estimate */

interface EstimateOk {
  estimateCents: number; basePriceCents: number; currency: string; score: number; grade: string; gradeName: string;
  chosen: unknown[]; assumed: string[]; note: string;
}

/** estimateFromQuestionnaire_: the customer's description → grade → the SAME quote path as the offer. */
async function estimateFromAnswers(ctx: Ctx, variantId: string, answers: Record<string, string>, vendorId: string | null): Promise<EstimateOk> {
  const [rules, ladder] = [await loadInspectionRules(ctx.db), await loadGradeLadder(ctx.db)];
  const g = gradeCustomerAnswers(answers, rules, ladder);
  if (!g.ok && g.reason === 'MISSING') throw fail('Answer every question first.', { missing: g.missing });
  if (!g.ok && g.reason === 'BLOCKED') throw fail(g.blockedReason, { blocked: true, blockedReason: g.blockedReason });
  if (!g.ok) throw fail('We are not able to accept this device.');
  const priced = await quote(ctx.db, variantId, g.graded.gradeCode, vendorId, now(), ladder);
  if (!priced.ok) throw fail(priced.message, { notPriced: true });
  const L = new Lookups(ctx.db);
  return {
    estimateCents: priced.q.valueCents, basePriceCents: priced.q.basePriceCents, currency: priced.q.currency || CURRENCY,
    score: g.graded.score, grade: g.graded.gradeCode, gradeName: await L.gradeName(g.graded.gradeCode),
    chosen: g.translated.chosen, assumed: g.translated.assumed.map((a) => a.question), note: await L.note(),
  };
}

/** customer.estimate — no score, no base price, no ladder in the reply. */
export async function customerEstimate(ctx: Ctx, p: { variantId: string; vendorId?: string; conditionAnswers?: unknown }) {
  const v = await ctx.db.query<{ id: string }>('select id from public.product_variants where id = $1', [p.variantId]);
  if (!v.rows[0]) throw fail('Choose a storage size.');
  const vendorId = trim(p.vendorId);
  if (vendorId) {
    const vr = await ctx.db.query<{ status: string }>('select status from public.vendors where id = $1', [vendorId]);
    if (vr.rows[0]?.status !== 'ACTIVE') throw fail('Choose a shop.');
  }
  const est = await estimateFromAnswers(ctx, p.variantId, normalizeCustomerAnswers(p.conditionAnswers), vendorId || null);
  await audit(ctx, ACTIONS.ESTIMATE_GIVEN, 'VARIANT', p.variantId, { newValue: centsToNumber(est.estimateCents), details: { grade: est.grade } });
  return {
    ok: true, estimate: centsToNumber(est.estimateCents), currency: est.currency, isEstimate: true,
    estimatedGrade: est.grade, gradeName: est.gradeName, chosen: est.chosen, assumed: est.assumed, note: est.note,
  };
}

/* ----------------------------------------------------------------- create */

export interface CreateTradeInParams {
  vendorId: string; branchId: string; variantId: string; colorId?: string; imei?: string;
  serialNumber?: string; conditionAnswers?: unknown; notes?: string;
}

/**
 * createTradeIn_. Who: from the token. What and where: validated against
 * the catalogue and the partner's own branch list. The critical section
 * of 3.1 (lock → fresh read → IMEI unique → partner/branch still open →
 * insert) is: row locks FOR SHARE on partner and branch, the IMEI check,
 * and the partial unique index trade_ins_open_imei_key as the final word.
 */
export async function createTradeIn(ctx: Ctx, d: CreateTradeInParams) {
  if (ctx.p.principalType !== 'CUSTOMER') throw forbidden();
  const cust = (await ctx.db.query<{ id: string; full_name: string; phone: string; status: string }>(
    'select id, full_name, phone, status from public.customers where id = $1', [ctx.p.principalId])).rows[0];
  if (!cust || cust.status !== 'ACTIVE') throw fail('Customer not found.');

  const vendorId = trim(d.vendorId);
  const vendor = (await ctx.db.query<{ id: string; code: string; status: string; name: string }>(
    'select id, code, status, name from public.vendors where id = $1 for share', [vendorId])).rows[0];
  if (!vendor || vendor.status !== 'ACTIVE') throw fail('Choose a shop to trade in at.');

  await ctx.db.query('select 1 from public.branches where id = $1 for share', [trim(d.branchId)]);
  const branch = await assertBranchBelongsTo(ctx.db, trim(d.branchId), vendorId);

  const variant = (await ctx.db.query<{ id: string; product_id: string; storage: string; active: boolean }>(
    'select id, product_id, storage, active from public.product_variants where id = $1', [trim(d.variantId)])).rows[0];
  if (!variant || !variant.active) throw fail('Choose a storage size.');
  const product = (await ctx.db.query<{ id: string; model: string; active: boolean; brand_name: string; category_name: string | null }>(
    `select p.id, p.model, p.active, b.name as brand_name, c.name as category_name
       from public.products p join public.brands b on b.id = p.brand_id left join public.categories c on c.id = p.category_id
      where p.id = $1`, [variant.product_id])).rows[0];
  if (!product || !product.active) throw fail('That model is not available.');

  let color: { id: string; color: string; product_id: string } | undefined;
  if (trim(d.colorId)) {
    color = (await ctx.db.query<{ id: string; color: string; product_id: string }>(
      'select id, color, product_id from public.product_colors where id = $1', [trim(d.colorId)])).rows[0];
    if (color && color.product_id !== product.id) throw fail('That colour does not belong to this model.');
  }

  const imei = digitsOnly(d.imei);
  if (TRADEIN_CONFIG.REQUIRE_IMEI) {
    if (!imei) throw fail('Enter the device IMEI. Dial *#06# to see it.');
    if (TRADEIN_CONFIG.REQUIRE_IMEI_LUHN && !isValidImei(imei)) {
      throw fail('That IMEI is not valid. Dial *#06# and check the 15 digits.');
    }
  }

  const answers = normalizeCustomerAnswers(d.conditionAnswers);
  if (!customerAnswersComplete(answers)) throw fail('Answer the condition questions before submitting.');

  let est: EstimateOk;
  try {
    est = await estimateFromAnswers(ctx, variant.id, answers, vendorId);
  } catch (err) {
    if (err instanceof AppError && err.extra.blocked) throw err;
    if (err instanceof AppError && err.code === 'BUSINESS_RULE') throw fail('We are not buying this model at the moment.');
    throw err;
  }

  if (TRADEIN_CONFIG.REQUIRE_IMEI && imei) {
    const dup = await ctx.db.query('select 1 from public.trade_ins where imei = $1 and status <> all($2::text[]) limit 1',
      [imei, IMEI_FREE_STATUSES]);
    if (dup.rowCount) throw fail('There is already an open trade-in for this device.');
  }

  const id = await nextTradeInId(ctx.db, vendor.code);
  await ctx.db.query(
    `insert into public.trade_ins
       (id, customer_id, vendor_id, branch_id, product_id, variant_id, color_id,
        brand_snapshot, category_snapshot, model_snapshot, storage_snapshot, color_snapshot,
        imei, serial_number, customer_name, customer_phone, condition_answers,
        estimated_score, estimated_grade, estimated_value, currency, status, device_received, notes, operation_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18,$19,$20,'QAR','PENDING_TECHNICIAN',false,$21,$22)`,
    [id, cust.id, vendorId, branch.id, product.id, variant.id, color?.id ?? null,
      product.brand_name, product.category_name, product.model, variant.storage, color?.color ?? null,
      imei || null, trim(d.serialNumber) || null, cust.full_name, cust.phone, JSON.stringify(answers),
      est.score, est.grade, centsToDecimal(est.estimateCents), trim(d.notes) || null, ctx.operationId || null]);

  await audit(ctx, ACTIONS.TRADEIN_CREATED, 'TRADEIN', id, {
    newValue: centsToNumber(est.estimateCents), vendorId, branchId: branch.id,
    details: { vendorId, branchId: branch.id, model: `${product.model} ${variant.storage}`, imeiMasked: maskImei(imei),
      estimatedGrade: est.grade, estimatedScore: est.score },
  });
  await audit(ctx, ACTIONS.QUESTIONNAIRE_SAVED, 'TRADEIN', id, {
    newValue: answers, vendorId, branchId: branch.id,
    details: { note: 'The customer\'s own description, kept for comparison against the technician\'s findings.' },
  });
  await emit.tradeInCreated(ctx.db, id, vendorId, `${product.model} ${variant.storage}`, est.estimateCents, branch.id);

  const b = (await ctx.db.query<{ id: string; vendor_id: string; name: string; address: string | null; location: string | null; contact_phone: string | null }>(
    'select id, vendor_id, name, address, location, contact_phone from public.branches where id = $1', [branch.id])).rows[0]!;
  return {
    ok: true, tradeInId: id, estimate: centsToNumber(est.estimateCents), estimatedGrade: est.grade, gradeName: est.gradeName,
    currency: CURRENCY, branch: publicBranchView(b), note: est.note,
    message: `Bring your device to ${b.name}. The final value is confirmed after inspection.`,
  };
}

/* ---------------------------------------------------- the customer's answer */

export async function acceptOffer(ctx: Ctx, p: { tradeInId: string }) {
  const t = await loadTradeInScoped<TradeInRow>(ctx, p.tradeInId, { lock: true });
  if (t.status !== STATUS.FINAL_OFFER_READY) throw fail('There is no offer waiting on this trade-in.');
  if (ctx.p.principalType === 'CUSTOMER' && t.customer_id !== ctx.p.principalId) {
    deny(ctx, 'tradein.accept', t.id);
    throw notFound('Trade-in not found.');
  }
  await transition(ctx, t, 'CUSTOMER_ACCEPTED', { accepted_at: now() }, ACTIONS.CUSTOMER_ACCEPTED, { value: m(t.final_customer_value) });
  return { ok: true, message: 'Offer accepted. Hand the device over at the shop to receive your voucher.' };
}

export async function declineOffer(ctx: Ctx, p: { tradeInId: string; reason?: string }) {
  const t = await loadTradeInScoped<TradeInRow>(ctx, p.tradeInId, { lock: true });
  if (t.status !== STATUS.FINAL_OFFER_READY) throw fail('There is no offer waiting on this trade-in.');
  if (ctx.p.principalType === 'CUSTOMER' && t.customer_id !== ctx.p.principalId) {
    deny(ctx, 'tradein.decline', t.id);
    throw notFound('Trade-in not found.');
  }
  const reason = trim(p.reason);
  const declined = await transition(ctx, t, 'CUSTOMER_DECLINED', { declined_at: now(), decline_reason: reason || null },
    ACTIONS.CUSTOMER_DECLINED, { reason });
  await transition(ctx, declined, 'CLOSED', {}, ACTIONS.TRADEIN_CLOSED, { outcome: 'declined' });
  return { ok: true, message: 'Offer declined.' };
}

/* ----------------------------------------------------------------- custody */

export async function receiveDevice(ctx: Ctx, p: { tradeInId: string; notes?: string }) {
  const t = await loadTradeInScoped<TradeInRow>(ctx, p.tradeInId, { lock: true });
  if (!canTransition(t.status, 'DEVICE_RECEIVED')) throw fail('The customer has not accepted an offer on this trade-in.');
  if (t.device_received) throw fail('This device has already been received.');
  const received = await transition(ctx, t, 'DEVICE_RECEIVED', {
    device_received: true, device_received_by: ctx.p.principalId, device_received_at: now(),
    notes: appendNote(t.notes, p.notes, fmtDateTime(now())),
  }, ACTIONS.DEVICE_RECEIVED, { receivedBy: ctx.p.name });
  await transition(ctx, received, 'AWAITING_VOUCHER', {}, ACTIONS.DEVICE_RECEIVED, { stage: 'awaiting voucher' });
  await emit.voucherDue(ctx.db, t.id, t.vendor_id, t.branch_id, toCentsOrNull(t.final_customer_value) ?? 0);
  return { ok: true, message: 'Device received. A voucher can now be issued.' };
}

/** tech.returnDevice — two steps, because a device leaving must be recorded twice. */
export async function returnDevice(ctx: Ctx, p: { tradeInId: string; stage?: string; reason?: string; notes?: string }) {
  const t = await loadTradeInScoped<TradeInRow>(ctx, p.tradeInId, { lock: true });
  if (trim(p.stage).toUpperCase() === 'COMPLETE') {
    if (!canTransition(t.status, 'DEVICE_RETURNED')) throw fail('This trade-in is not waiting to be returned.');
    const returned = await transition(ctx, t, 'DEVICE_RETURNED', {
      device_received: false, device_returned_by: ctx.p.principalId, device_returned_at: now(),
      notes: appendNote(t.notes, p.notes, fmtDateTime(now())),
    }, ACTIONS.DEVICE_RETURNED, { returnedBy: ctx.p.name });
    await transition(ctx, returned, 'CANCELLED', {}, ACTIONS.TRADEIN_CLOSED, { outcome: 'device returned to customer' });
    return { ok: true, message: 'Device returned and the trade-in closed.' };
  }
  if (!canTransition(t.status, 'RETURN_PENDING')) throw fail('This trade-in cannot be returned from its current state.');
  if (isBlank(p.reason)) throw fail('Say why the device is being returned.');
  if (t.voucher_id) throw fail('Void the voucher before returning the device.');
  await transition(ctx, t, 'RETURN_PENDING', { return_reason: trim(p.reason) }, ACTIONS.DEVICE_RETURN_START, { reason: trim(p.reason) });
  return { ok: true, message: 'Marked for return. Record the handover when the customer collects it.' };
}

/**
 * cancelTradeIn_ — kept for parity. 3.1 had NO registry action that called
 * it, so it is not exposed through any route either (see API.md).
 */
export async function cancelTradeIn(ctx: Ctx, p: { tradeInId: string; reason?: string }) {
  const t = await loadTradeInScoped<TradeInRow>(ctx, p.tradeInId, { lock: true });
  if (inCustody(t.status) && !TRADEIN_CONFIG.ALLOW_CANCEL_AFTER_RECEIPT) {
    throw fail('We are holding this device. Use the return process instead, so the handover is recorded.');
  }
  if (!canTransition(t.status, 'CANCELLED')) throw fail('This trade-in cannot be cancelled from its current state.');
  if (isBlank(p.reason)) throw fail('Say why this trade-in is being cancelled.');
  await transition(ctx, t, 'CANCELLED', { notes: appendNote(t.notes, `Cancelled: ${trim(p.reason)}`, fmtDateTime(now())) },
    ACTIONS.TRADEIN_CLOSED, { outcome: 'cancelled', reason: trim(p.reason) });
  return { ok: true, message: 'Trade-in cancelled.' };
}

/* ------------------------------------------------------- admin corrections */

function requireAdmin(ctx: Ctx): void {
  if (!ADMIN_ONLY.includes(ctx.p.role)) {
    deny(ctx, 'role.adminOnly', ctx.p.role);
    throw forbidden('Only a Qatar Mobile administrator can do that.');
  }
}

function assertCorrectable(t: TradeInRow): void {
  if (t.settlement_id) throw fail('This trade-in has been settled. Raise an adjustment instead.');
  if (!CORRECTABLE_STATUSES.includes(t.status)) throw fail(`A trade-in at "${statusLabel(t.status)}" can no longer be corrected.`);
  if (t.voucher_id) throw fail('Void the voucher before changing the value.');
}

async function repriceFields(ctx: Ctx, t: TradeInRow, finalCents: number) {
  const fee = await partnerFee(ctx.db, t.vendor_id, finalCents, t.product_id, now());
  const est = toCentsOrNull(t.estimated_value) ?? 0;
  const v = variance(est, finalCents);
  return {
    fee,
    fields: {
      final_customer_value: centsToDecimal(finalCents),
      price_variance: centsToDecimal(v.amount), price_variance_pct: v.percent,
      commission_rule_id: fee.commissionRuleId || null, commission_type_snapshot: fee.commissionType,
      commission_rate_snapshot: microToDecimal(fee.commissionRateMicro),
      commission_value: centsToDecimal(fee.commissionCents), total_settlement: centsToDecimal(fee.totalSettlementCents),
    },
  };
}

/** overrideGrade_: an administrator chooses a GRADE (never a price); the ladder reprices. */
export async function overrideGrade(ctx: Ctx, p: { tradeInId: string; gradeCode: string; reason?: string }) {
  requireAdmin(ctx);
  const t = await loadTradeInScoped<TradeInRow>(ctx, p.tradeInId, { lock: true });
  assertCorrectable(t);
  if (isBlank(p.reason)) throw fail('Give a reason for overriding the grade. It is recorded.');
  const wanted = trim(p.gradeCode).toUpperCase();
  const ladder = await loadGradeLadder(ctx.db);
  if (!ladder.some((g) => g.code === wanted)) throw fail('That grade does not exist.');
  const computed = t.grade_override_from || t.grade_code || '';
  if (!computed) throw fail('This trade-in has not been graded yet.');
  if (computed === wanted) return { ok: true, message: 'That is already the grade. Nothing changed.', unchanged: true };

  const priced = await quote(ctx.db, t.variant_id, wanted, t.vendor_id, now(), ladder);
  if (!priced.ok) throw fail(priced.message);
  const adjustment = toCentsOrNull(t.manual_adjustment) ?? 0;
  const finalCents = clampCents(priced.q.valueCents + adjustment);
  const { fields } = await repriceFields(ctx, t, finalCents);
  await updateById(ctx.db, 'trade_ins', t.id, {
    grade_code: wanted, grade_percentage_snapshot: fraction4ToDecimal(priced.q.gradePercentageBp),
    calculated_grade_value: centsToDecimal(priced.q.valueCents), ...fields,
    grade_override_from: computed, grade_override_to: wanted, grade_override_reason: trim(p.reason),
    grade_override_by: `${ctx.p.name} (${ctx.p.principalId})`, grade_override_at: now(),
  });
  await audit(ctx, ACTIONS.GRADE_OVERRIDDEN, 'TRADEIN', t.id, {
    oldValue: computed, newValue: wanted, vendorId: t.vendor_id, branchId: t.branch_id,
    details: { reason: trim(p.reason), wasValue: m(t.final_customer_value), nowValue: centsToNumber(finalCents),
      note: 'The grade the system computed is kept in grade_override_from.' },
  });
  return {
    ok: true, grade: wanted, finalValue: centsToNumber(finalCents),
    message: `Grade changed from ${computed} to ${wanted}. The offer is now ${formatMoney(finalCents)} ${CURRENCY}.`,
  };
}

/** adjustOffer_: change the MONEY with a reason; the grade stands; the fee is recomputed. */
export async function adjustOffer(ctx: Ctx, p: { tradeInId: string; manualAdjustment: unknown; reason?: string }) {
  requireAdmin(ctx);
  const t = await loadTradeInScoped<TradeInRow>(ctx, p.tradeInId, { lock: true });
  assertCorrectable(t);
  if (isBlank(p.reason)) throw fail('Give a reason for adjusting the offer. It is recorded.');
  let adjustment: number;
  try { adjustment = toCents(p.manualAdjustment); } catch { throw fail('Enter an adjustment amount.'); }
  const gradeValueCents = toCentsOrNull(t.calculated_grade_value) ?? 0;
  const finalCents = clampCents(gradeValueCents + adjustment);
  const { fields } = await repriceFields(ctx, t, finalCents);
  await updateById(ctx.db, 'trade_ins', t.id, {
    manual_adjustment: centsToDecimal(adjustment), manual_adjustment_reason: trim(p.reason),
    manual_adjustment_by: `${ctx.p.name} (${ctx.p.principalId})`, ...fields,
  });
  await audit(ctx, ACTIONS.MANUAL_OVERRIDE, 'TRADEIN', t.id, {
    oldValue: m(t.final_customer_value), newValue: centsToNumber(finalCents), vendorId: t.vendor_id, branchId: t.branch_id,
    details: { reason: trim(p.reason), adjustment: centsToNumber(adjustment) },
  });
  return { ok: true, finalValue: centsToNumber(finalCents), message: `Offer adjusted to ${formatMoney(finalCents)} ${CURRENCY}.` };
}

/* ------------------------------------------------------------ reads/queues */

export async function customerTradeIns(ctx: Ctx) {
  const r = await ctx.db.query<TradeInRow>('select * from public.trade_ins where customer_id = $1 order by created_at desc limit 500', [ctx.p.principalId]);
  const L = new Lookups(ctx.db);
  const out = [];
  for (const t of r.rows) out.push(await customerTradeInView(ctx.db, L, t));
  return { ok: true, tradeIns: out, currency: CURRENCY };
}

export async function customerTradeIn(ctx: Ctx, p: { tradeInId: string }) {
  const t = await loadTradeInScoped<TradeInRow>(ctx, p.tradeInId);
  return { ok: true, tradeIn: await customerTradeInView(ctx.db, new Lookups(ctx.db), t) };
}

export async function customerVoucher(ctx: Ctx, p: { tradeInId: string }) {
  const t = await loadTradeInScoped<TradeInRow>(ctx, p.tradeInId);
  if (!t.voucher_id) throw fail('No voucher has been issued yet.');
  const v = (await ctx.db.query<{ voucher_number: string; customer_value: string; currency: string; issued_at: Date; status: string; branch_id: string }>(
    'select voucher_number, customer_value, currency, issued_at, status, branch_id from public.vouchers where id = $1', [t.voucher_id])).rows[0];
  if (!v) throw fail('No voucher has been issued yet.');
  const L = new Lookups(ctx.db);
  const b = await L.branch(v.branch_id);
  const vendor = await L.vendor(t.vendor_id);
  return {
    ok: true,
    voucher: {
      voucherNumber: v.voucher_number, value: m(v.customer_value), currency: v.currency.trim() || CURRENCY,
      issuedDate: fmtDateTime(v.issued_at), status: v.status, device: deviceLabel(t),
      vendor: vendor?.name ?? '', branch: b?.name ?? '',
    },
  };
}

const TECH_COLUMNS = '*';

export async function technicianQueues(ctx: Ctx) {
  const r = await ctx.db.query<TradeInRow>(
    `select ${TECH_COLUMNS} from public.trade_ins
      where status in ('PENDING_TECHNICIAN','INSPECTION_IN_PROGRESS','INSPECTION_COMPLETED','FINAL_OFFER_READY','CUSTOMER_ACCEPTED','RETURN_PENDING')
      order by created_at desc limit 2000`);
  const L = new Lookups(ctx.db);
  const pick = async (s: string[]) => {
    const out = [];
    for (const t of r.rows.filter((x) => s.includes(x.status))) out.push(await technicianQueueView(L, t));
    return out;
  };
  return {
    ok: true,
    waiting: await pick(['PENDING_TECHNICIAN']),
    inProgress: await pick(['INSPECTION_IN_PROGRESS', 'INSPECTION_COMPLETED']),
    awaitingCustomer: await pick(['FINAL_OFFER_READY']),
    readyToReceive: await pick(['CUSTOMER_ACCEPTED']),
    returns: await pick(['RETURN_PENDING']),
  };
}

/** vendorQueue_: scope from the principal, never from the request. */
export async function vendorQueue(ctx: Ctx, f: { status?: string; branchId?: string; search?: string; limit?: number }) {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (!ctx.p.isPlatform) {
    add('vendor_id = ?', ctx.p.vendorId);
    if (ctx.p.branchId) add('branch_id = ?', ctx.p.branchId);
  }
  if (f.status) add('status = ?', f.status);
  if (f.branchId) add('branch_id = ?', await scopeBranch(ctx, f.branchId));
  if (f.search) {
    add(`lower(id || ' ' || coalesce(customer_name,'') || ' ' || coalesce(model_snapshot,'')) like ?`, `%${f.search.toLowerCase().replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
  }
  const w = where.length ? `where ${where.join(' and ')}` : '';
  const rows = (await ctx.db.query<TradeInRow>(`select * from public.trade_ins ${w} order by created_at desc limit 5000`, params)).rows;
  const L = new Lookups(ctx.db);
  const limit = clampLimit(f.limit, 200, 500);
  const shown = [];
  for (const t of rows.slice(0, limit)) shown.push(await vendorTradeInView(L, t));
  return {
    ok: true, total: rows.length,
    awaitingVoucher: rows.filter((t) => t.status === 'DEVICE_RECEIVED' || t.status === 'AWAITING_VOUCHER').length,
    tradeIns: shown,
  };
}

export async function vendorTradeIn(ctx: Ctx, p: { tradeInId: string }) {
  const t = await loadTradeInScoped<TradeInRow>(ctx, p.tradeInId);
  return { ok: true, tradeIn: await vendorTradeInView(new Lookups(ctx.db), t) };
}

/** adminTradeIns_: platform-wide list with filters and totals. */
export async function adminTradeIns(ctx: Ctx, f: {
  vendorId?: string; branchId?: string; status?: string; grade?: string; brand?: string; model?: string;
  from?: string; to?: string; search?: string; limit?: number;
}) {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replaceAll('?', `$${params.length}`)); };
  if (f.vendorId) add('vendor_id = ?', f.vendorId);
  if (f.branchId) add('branch_id = ?', f.branchId);
  if (f.status) add('status = ?', f.status);
  if (f.grade) add('grade_code = ?', f.grade);
  const from = parseDayStart(f.from); const to = parseDayEnd(f.to);
  if (from) add('created_at >= ?', from);
  if (to) add('created_at <= ?', to);
  if (f.search) {
    add(`lower(id || ' ' || coalesce(customer_name,'') || ' ' || coalesce(customer_phone,'') || ' ' || coalesce(model_snapshot,'') || ' ' || coalesce(imei,'')) like ?`,
      `%${f.search.toLowerCase().replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
  }
  const w = where.length ? `where ${where.join(' and ')}` : '';
  let rows = (await ctx.db.query<TradeInRow>(`select * from public.trade_ins ${w} order by created_at desc limit 20000`, params)).rows;
  if (f.brand) rows = rows.filter((t) => sameLabel(t.brand_snapshot, f.brand));
  if (f.model) rows = rows.filter((t) => sameLabel(t.model_snapshot, f.model));
  const limit = clampLimit(f.limit, 200, 1000);
  const L = new Lookups(ctx.db);
  const shown = [];
  for (const t of rows.slice(0, limit)) shown.push(await adminTradeInView(L, t));
  const sum = (k: keyof TradeInRow) => centsToNumber(rows.reduce((a, t) => a + (toCentsOrNull(t[k] as string) ?? 0), 0));
  return {
    ok: true, total: rows.length, shown: Math.min(rows.length, limit),
    totals: { customerValue: sum('final_customer_value'), commission: sum('commission_value'), settlement: sum('total_settlement') },
    tradeIns: shown,
  };
}

const TIMELINE_ACTIONS = [
  ACTIONS.TRADEIN_CREATED, ACTIONS.QUESTIONNAIRE_SAVED, ACTIONS.INSPECTION_STARTED, ACTIONS.GRADE_COMPUTED, ACTIONS.GRADE_BLOCKED,
  ACTIONS.GRADE_OVERRIDDEN, ACTIONS.OFFER_SUBMITTED, ACTIONS.MANUAL_OVERRIDE, ACTIONS.CUSTOMER_ACCEPTED, ACTIONS.CUSTOMER_DECLINED,
  ACTIONS.DEVICE_RECEIVED, ACTIONS.DEVICE_RETURN_START, ACTIONS.DEVICE_RETURNED, ACTIONS.VOUCHER_ISSUED, ACTIONS.VOUCHER_VOIDED,
  ACTIONS.VOUCHER_REISSUED, ACTIONS.COLLECTION_CREATED, ACTIONS.DEVICE_COLLECTED, ACTIONS.DEVICE_NOT_COLLECTED,
  ACTIONS.SETTLEMENT_CREATED, ACTIONS.SETTLEMENT_APPROVED, ACTIONS.SETTLEMENT_PAID, ACTIONS.TRADEIN_CLOSED, 'STATUS_CHANGED',
];
const TIMELINE_LABEL: Record<string, string> = {
  [ACTIONS.TRADEIN_CREATED]: 'Trade-in created', [ACTIONS.QUESTIONNAIRE_SAVED]: 'Customer described the device',
  [ACTIONS.INSPECTION_STARTED]: 'Inspection started', [ACTIONS.GRADE_COMPUTED]: 'Inspection completed',
  [ACTIONS.GRADE_BLOCKED]: 'Device refused by rule', [ACTIONS.GRADE_OVERRIDDEN]: 'Grade overridden by an administrator',
  [ACTIONS.OFFER_SUBMITTED]: 'Final offer made', [ACTIONS.MANUAL_OVERRIDE]: 'Offer adjusted manually',
  [ACTIONS.CUSTOMER_ACCEPTED]: 'Customer accepted', [ACTIONS.CUSTOMER_DECLINED]: 'Customer declined',
  [ACTIONS.DEVICE_RECEIVED]: 'Device received', [ACTIONS.DEVICE_RETURN_START]: 'Marked for return',
  [ACTIONS.DEVICE_RETURNED]: 'Device returned to customer', [ACTIONS.VOUCHER_ISSUED]: 'Voucher issued',
  [ACTIONS.VOUCHER_VOIDED]: 'Voucher voided', [ACTIONS.VOUCHER_REISSUED]: 'Voucher reissued',
  [ACTIONS.COLLECTION_CREATED]: 'Added to a collection note', [ACTIONS.DEVICE_COLLECTED]: 'Device collected',
  [ACTIONS.DEVICE_NOT_COLLECTED]: 'Device not collected', [ACTIONS.SETTLEMENT_CREATED]: 'Settlement created',
  [ACTIONS.SETTLEMENT_APPROVED]: 'Settlement approved', [ACTIONS.SETTLEMENT_PAID]: 'Settlement paid',
  [ACTIONS.TRADEIN_CLOSED]: 'Trade-in closed', STATUS_CHANGED: 'Status changed',
};

function timelineNote(d: Record<string, unknown> | null): string {
  if (!d) return '';
  const parts: string[] = [];
  if (d.reason) parts.push(String(d.reason));
  if (d.voucherNumber) parts.push(`Voucher ${d.voucherNumber}`);
  if (d.batchId) parts.push(`Note ${d.batchId}`);
  if (d.settlementId) parts.push(`Settlement ${d.settlementId}`);
  if (d.grade) parts.push(`Grade ${d.grade}`);
  if (d.outcome) parts.push(String(d.outcome));
  if (d.stage) parts.push(String(d.stage));
  return parts.join(' · ');
}

export async function tradeInTimeline(ctx: Ctx, tradeInId: string) {
  const r = await ctx.db.query<{ occurred_at: Date; actor_name: string | null; actor_id: string | null; actor_role: string | null; action: string; old_value: unknown; new_value: unknown; details: Record<string, unknown> | null }>(
    `select occurred_at, actor_name, actor_id, actor_role, action, old_value, new_value, details
       from public.audit_logs where object_id = $1 and action = any($2::text[]) order by occurred_at, id`, [tradeInId, TIMELINE_ACTIONS]);
  const s = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v));
  return r.rows.map((x) => ({
    date: fmtDateTime(x.occurred_at), user: x.actor_name || x.actor_id || 'system',
    role: ROLE_LABELS[x.actor_role as keyof typeof ROLE_LABELS] ?? x.actor_role ?? '', action: x.action,
    label: TIMELINE_LABEL[x.action] ?? statusLabel(x.action), status: s(x.new_value), from: s(x.old_value), notes: timelineNote(x.details),
  }));
}

export { topGrade };
