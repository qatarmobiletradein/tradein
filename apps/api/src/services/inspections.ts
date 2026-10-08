/**
 * Inspections and the final offer (15_Inspections.gs, 14_TradeIns.gs
 * submitFinalOffer_).
 *
 * The grade is COMPUTED by the server from stored answers, never supplied.
 * A grade or value in a request is ignored and the attempt is recorded.
 * The technician never receives the submitted IMEI or the rule impacts.
 */
import {
  ACTIONS, ADMIN_ONLY, CURRENCY, INSPECTION_GROUPS, INPUT_TYPE, MEDIA, PHOTO_CATEGORIES, STATUS, TRADEIN_CONFIG,
} from '../../../../packages/domain/src/constants.js';
import { canTransition } from '../../../../packages/domain/src/workflow.js';
import { computeGrade, technicianRuleView, type GradeResult, type GradeRule, type InspectionRule } from '../../../../packages/domain/src/grading.js';
import { assessmentComparison, customerAnswerSummary } from '../../../../packages/domain/src/questionnaire.js';
import { deny, loadTradeInScoped } from '../../../../packages/auth/src/authz.js';
import { AppError, CommitThenFail, fail, invalid } from '../../../../packages/shared/src/errors.js';
import {
  centsToDecimal, centsToNumber, clampCents, formatMoney, fraction4ToDecimal, microToDecimal, toCents, toCentsOrNull, variance,
} from '../../../../packages/shared/src/money.js';
import { digitsOnly, formatPhone, isValidImei, maskImei, safeEquals, trim, truthy } from '../../../../packages/shared/src/text.js';
import { fmtDateTime } from '../../../../packages/shared/src/time.js';
import type { Ctx } from '../context.js';
import { audit } from '../lib/audit.js';
import { nextId } from '../lib/ids.js';
import { emit } from '../lib/notify.js';
import { loadGradeLadder, loadInspectionRules, partnerFee, quote } from '../lib/rules.js';
import { objectName, validateImage } from '../lib/storage.js';
import { updateById } from './sql.js';
import { Lookups, m, type TradeInRow } from './views.js';
import { transition } from './tradeins.js';

interface InspectionRow {
  id: string; trade_in_id: string; technician: string | null; started_at: Date | null; completed_at: Date | null;
  scanned_imei: string | null; imei_match: boolean; answers: Record<string, unknown>; battery_health: number | null;
  activation_lock: boolean; condition_score: string | null; grade_code: string | null; blocked_reason: string | null;
  technician_notes: string | null; status: 'IN_PROGRESS' | 'COMPLETED';
}

interface LiveResult extends GradeResult {
  gradeName: string; currency: string; priced: boolean; basePrice?: number; customerValue: number | null; priceMessage?: string;
}

const now = (): Date => new Date();

async function inspectionOf(ctx: Ctx, t: TradeInRow, lock = false): Promise<InspectionRow | null> {
  if (!t.inspection_id) return null;
  const r = await ctx.db.query<InspectionRow>(`select * from public.inspections where id = $1${lock ? ' for update' : ''}`, [t.inspection_id]);
  return r.rows[0] ?? null;
}

/** inspectionResult_: the grade AND the money, through the same quote as the offer. */
async function inspectionResult(
  ctx: Ctx, t: TradeInRow, answers: Record<string, unknown>, battery: number | null, imeiMatch: boolean,
  rules?: InspectionRule[], ladder?: GradeRule[],
): Promise<LiveResult> {
  const r = rules ?? await loadInspectionRules(ctx.db);
  const l = ladder ?? await loadGradeLadder(ctx.db);
  const graded = computeGrade(answers, { batteryHealth: battery, imeiMatch, imeiRequired: TRADEIN_CONFIG.REQUIRE_IMEI_MATCH }, r, l);
  const priced = await quote(ctx.db, t.variant_id, graded.gradeCode, t.vendor_id, now(), l);
  const out: LiveResult = {
    ...graded, gradeName: l.find((g) => g.code === graded.gradeCode)?.name ?? graded.gradeCode, currency: CURRENCY,
    priced: priced.ok, customerValue: null,
  };
  if (priced.ok) { out.basePrice = centsToNumber(priced.q.basePriceCents); out.customerValue = centsToNumber(priced.q.valueCents); }
  else out.priceMessage = priced.message;
  return out;
}

function photoManifest(rows: { id: string; category: string; label: string | null; uploaded_by: string | null; uploaded_at: Date }[]) {
  return rows.map((p) => ({ fileId: p.id, category: p.category || 'OTHER', label: p.label ?? '', uploadedBy: p.uploaded_by ?? '', uploadedAt: fmtDateTime(p.uploaded_at) }));
}

async function photosOf(ctx: Ctx, inspectionId: string) {
  return (await ctx.db.query<{ id: string; category: string; label: string | null; uploaded_by: string | null; uploaded_at: Date }>(
    'select id, category, label, uploaded_by, uploaded_at from public.inspection_photos where inspection_id = $1 order by uploaded_at, id',
    [inspectionId])).rows;
}

/** inspectionWorkspace_: built field by field; the trade-in row is never spread (it holds the IMEI). */
async function workspace(ctx: Ctx, t: TradeInRow, i: InspectionRow) {
  const rules = await loadInspectionRules(ctx.db);
  const result = await inspectionResult(ctx, t, i.answers ?? {}, i.battery_health, i.imei_match, rules);
  const photos = photoManifest(await photosOf(ctx, i.id));
  return {
    ok: true,
    tradeInId: t.id, status: t.status,
    device: { brand: t.brand_snapshot ?? '', model: t.model_snapshot ?? '', storage: t.storage_snapshot ?? '', color: t.color_snapshot ?? '', serial: t.serial_number ?? '' },
    customer: { name: t.customer_name ?? '', phone: formatPhone(t.customer_phone) },
    estimate: m(t.estimated_value), currency: t.currency?.trim() || CURRENCY,
    inspection: {
      inspectionId: i.id, technician: i.technician ?? '', startedAt: fmtDateTime(i.started_at), answers: i.answers ?? {},
      batteryHealth: i.battery_health, imeiConfirmed: i.imei_match, imeiScanned: maskImei(i.scanned_imei),
      notes: i.technician_notes ?? '', photoCount: photos.length, photoIds: photos.map((p) => p.fileId), photos, status: i.status,
    },
    photoCategories: PHOTO_CATEGORIES,
    rules: technicianRuleView(rules),
    groups: [...INSPECTION_GROUPS],
    result,
    gates: {
      imeiRequired: TRADEIN_CONFIG.REQUIRE_IMEI_MATCH, imeiConfirmed: i.imei_match, answered: result.complete,
      missingCount: result.missing.length, blocked: result.blocked, blockedReason: result.blockedReason, priced: result.priced,
    },
  };
}

/** openInspection_: start, or resume; re-open a COMPLETED one before the offer goes out. */
export async function openInspection(ctx: Ctx, p: { tradeInId: string }) {
  let t = await loadTradeInScoped<TradeInRow>(ctx, p.tradeInId, { lock: true });
  let existing = (await ctx.db.query<InspectionRow>('select * from public.inspections where trade_in_id = $1 for update', [t.id])).rows[0];

  if (existing && t.status === STATUS.INSPECTION_COMPLETED) {
    t = await transition(ctx, t, 'INSPECTION_IN_PROGRESS', {}, ACTIONS.INSPECTION_STARTED, { reopened: true, technician: ctx.p.name });
    await updateById(ctx.db, 'inspections', existing.id, { status: 'IN_PROGRESS', completed_at: null });
    existing = { ...existing, status: 'IN_PROGRESS', completed_at: null };
  }

  if (!existing) {
    if (!canTransition(t.status, 'INSPECTION_IN_PROGRESS')) throw fail('This trade-in is not waiting for inspection.');
    const id = await nextId(ctx.db, 'INS');
    await ctx.db.query(
      `insert into public.inspections (id, trade_in_id, technician, started_at, imei_match, answers, activation_lock, status)
       values ($1,$2,$3,now(),false,'{}'::jsonb,false,'IN_PROGRESS')`, [id, t.id, ctx.p.name]);
    t = await transition(ctx, t, 'INSPECTION_IN_PROGRESS', { inspection_id: id, technician: ctx.p.name },
      ACTIONS.INSPECTION_STARTED, { technician: ctx.p.name });
    existing = (await ctx.db.query<InspectionRow>('select * from public.inspections where id = $1', [id])).rows[0]!;
  }
  return workspace(ctx, t, existing);
}

/** checkImei_: returns a boolean only — never the expected value. */
export async function checkImei(ctx: Ctx, p: { tradeInId: string; scannedImei: string }) {
  const t = await loadTradeInScoped<TradeInRow>(ctx, p.tradeInId, { lock: true });
  const scanned = digitsOnly(p.scannedImei);
  if (!/^\d{15}$/.test(scanned)) throw fail('An IMEI is 15 digits. Dial *#06# on the device.');
  if (TRADEIN_CONFIG.REQUIRE_IMEI_LUHN && !isValidImei(scanned)) throw fail('That is not a valid IMEI. Check the digits and try again.');
  const matches = safeEquals(scanned, digitsOnly(t.imei));
  const i = await inspectionOf(ctx, t, true);
  if (i) await updateById(ctx.db, 'inspections', i.id, { scanned_imei: scanned, imei_match: matches });
  await audit(ctx, ACTIONS.INSPECTION_SAVED, 'TRADEIN', t.id, {
    vendorId: t.vendor_id, branchId: t.branch_id,
    details: { check: 'IMEI', result: matches ? 'match' : 'MISMATCH', scannedMasked: maskImei(scanned) },
  });
  return { ok: true, match: matches, message: matches ? 'IMEI confirmed.' : 'This is not the device the customer registered. Do not proceed.' };
}

const FORBIDDEN_INSPECTION_FIELDS = ['gradeCode', 'gradeOverride', 'finalCustomerValue', 'customerValue'];

/** saveInspection_: merge answers; battery is the one number; recompute and store what was computed. */
export async function saveInspection(ctx: Ctx, p: { tradeInId: string; answers?: Record<string, unknown>; batteryHealth?: unknown; notes?: string }) {
  const t = await loadTradeInScoped<TradeInRow>(ctx, p.tradeInId, { lock: true });
  const i = await inspectionOf(ctx, t, true);
  if (!i) throw fail('No inspection is open for this trade-in.');
  if (t.status !== STATUS.INSPECTION_IN_PROGRESS) throw fail('This inspection is no longer open.');
  if (FORBIDDEN_INSPECTION_FIELDS.some((k) => ctx.rawParams[k] !== undefined)) deny(ctx, 'inspection.gradeOverrideAttempt', t.id);

  const rules = await loadInspectionRules(ctx.db);
  const answers: Record<string, unknown> = { ...(i.answers ?? {}) };
  const incoming = p.answers ?? {};
  for (const rule of rules) {
    if (rule.input === INPUT_TYPE.PERCENTAGE) continue;
    if (incoming[rule.code] === undefined) continue;
    answers[rule.code] = truthy(incoming[rule.code]);
  }
  const patch: Record<string, unknown> = { answers, technician: ctx.p.name };
  let battery = i.battery_health;
  if (p.batteryHealth !== undefined && p.batteryHealth !== '' && p.batteryHealth !== null) {
    const h = Number(p.batteryHealth);
    if (!Number.isFinite(h) || h < 0 || h > 100) throw fail('Battery health is a percentage between 0 and 100.');
    battery = Math.round(h);
    patch.battery_health = battery;
  }
  if (answers.ACTIVATION_LOCK !== undefined) patch.activation_lock = !truthy(answers.ACTIVATION_LOCK);
  if (p.notes !== undefined) patch.technician_notes = trim(p.notes);

  const result = await inspectionResult(ctx, t, answers, battery, i.imei_match, rules);
  patch.condition_score = result.score;
  patch.grade_code = result.gradeCode;
  patch.blocked_reason = result.blockedReason || null;
  await updateById(ctx.db, 'inspections', i.id, patch);
  return {
    ok: true, result,
    message: result.complete ? `Saved. Condition score ${result.score}, grade ${result.gradeCode}.`
      : `Saved. ${result.missing.length} question(s) still to answer.`,
  };
}

/** completeInspection_: re-validates everything; moves the trade-in to INSPECTION_COMPLETED. */
export async function completeInspection(ctx: Ctx, p: { tradeInId: string }) {
  const t = await loadTradeInScoped<TradeInRow>(ctx, p.tradeInId, { lock: true });
  if (t.status !== STATUS.INSPECTION_IN_PROGRESS && t.status !== STATUS.INSPECTION_COMPLETED) {
    throw fail(`This inspection is closed. The trade-in is at "${t.status.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())}".`);
  }
  const i = await inspectionOf(ctx, t, true);
  if (!i) throw fail('No inspection is open for this trade-in.');
  if (TRADEIN_CONFIG.REQUIRE_IMEI_MATCH && !i.imei_match) throw fail('Confirm the IMEI on the device before finishing.');
  const result = await inspectionResult(ctx, t, i.answers ?? {}, i.battery_health, i.imei_match);
  if (!result.complete) throw fail(`Answer every question first. ${result.missing.length} still outstanding.`);
  if (!result.priced) throw fail(result.priceMessage || 'This device has no price.');

  await updateById(ctx.db, 'inspections', i.id, {
    completed_at: now(), condition_score: result.score, grade_code: result.gradeCode, blocked_reason: result.blockedReason || null, status: 'COMPLETED',
  });
  if (canTransition(t.status, 'INSPECTION_COMPLETED')) {
    await transition(ctx, t, 'INSPECTION_COMPLETED', { condition_score: result.score }, ACTIONS.GRADE_COMPUTED,
      { grade: result.gradeCode, score: result.score });
  }
  await emit.inspectionDone(ctx.db, t.id, t.customer_id, t.vendor_id, t.branch_id, result.gradeCode);
  await audit(ctx, result.blocked ? ACTIONS.GRADE_BLOCKED : ACTIONS.GRADE_COMPUTED, 'TRADEIN', t.id, {
    newValue: { score: result.score, grade: result.gradeCode }, vendorId: t.vendor_id, branchId: t.branch_id,
    details: { faults: result.faults.map((f) => f.code), blockedReason: result.blockedReason,
      note: 'Computed by the server from the technician\'s answers. No grade was chosen by a person.' },
  });
  return { ok: true, result, message: `Inspection complete. Grade ${result.gradeCode}.` };
}

/** inspectionSummary_: read-only confirmation; the customer's own description is shown only here. */
export async function inspectionSummary(ctx: Ctx, p: { tradeInId: string }) {
  const t = await loadTradeInScoped<TradeInRow>(ctx, p.tradeInId);
  const i = await inspectionOf(ctx, t);
  if (!i) throw fail('No inspection is open for this trade-in.');
  const rules = await loadInspectionRules(ctx.db);
  const result = await inspectionResult(ctx, t, i.answers ?? {}, i.battery_health, i.imei_match, rules);
  const photos = await photosOf(ctx, i.id);
  return {
    ok: true, device: [t.brand_snapshot, t.model_snapshot, t.storage_snapshot].filter(Boolean).join(' '), color: t.color_snapshot ?? '',
    imeiConfirmed: i.imei_match, batteryHealth: i.battery_health, activationLock: !truthy((i.answers ?? {}).ACTIVATION_LOCK),
    photoCount: photos.length, result,
    customerSaid: customerAnswerSummary(t.condition_answers), comparison: assessmentComparison(t.condition_answers, i.answers ?? {}, rules),
    estimated: { value: m(t.estimated_value), grade: t.estimated_grade ?? '' }, currency: CURRENCY,
  };
}

/** tech.previewOffer: recomputed from what is stored; takes no grade from the caller. */
export async function previewOffer(ctx: Ctx, p: { tradeInId: string }) {
  const t = await loadTradeInScoped<TradeInRow>(ctx, p.tradeInId);
  const i = await inspectionOf(ctx, t);
  if (!i) throw fail('No inspection is open for this trade-in.');
  return { ok: true, result: await inspectionResult(ctx, t, i.answers ?? {}, i.battery_health, i.imei_match) };
}

/**
 * submitFinalOffer_: everything that decides the money is frozen onto the
 * trade-in. `d` carries ONLY an admin's manual adjustment; tech.submitOffer
 * passes nothing.
 */
export async function submitFinalOffer(ctx: Ctx, tradeInId: string, d: { manualAdjustment?: unknown; manualAdjustmentReason?: string }) {
  // Already scoped by the caller (completeInspection → loadTradeInScoped); lock and read fresh.
  const t = (await ctx.db.query<TradeInRow>('select * from public.trade_ins where id = $1 for update', [tradeInId])).rows[0];
  if (!t) throw fail('Trade-in not found.');
  if (!canTransition(t.status, 'FINAL_OFFER_READY')) throw fail('This trade-in is not ready for a final offer.');
  const i = await inspectionOf(ctx, t, true);
  if (!i) throw fail('The inspection has not been completed.');
  if (TRADEIN_CONFIG.REQUIRE_IMEI_MATCH && !i.imei_match) throw fail('The IMEI on the device has not been confirmed to match.');
  if (ctx.rawParams.gradeCode !== undefined || ctx.rawParams.gradeOverride !== undefined) deny(ctx, 'tradein.gradeSupplied', t.id);

  const ladder = await loadGradeLadder(ctx.db);
  const computed = await inspectionResult(ctx, t, i.answers ?? {}, i.battery_health, i.imei_match, undefined, ladder);
  if (!computed.complete) throw fail(`The inspection is not finished. ${computed.missing.length} question(s) unanswered.`);
  if (computed.blocked && TRADEIN_CONFIG.BLOCK_ON_ACTIVATION_LOCK) {
    throw fail(computed.blockedReason || 'This device cannot be accepted in its current state.');
  }
  const grade = ladder.find((g) => g.code === computed.gradeCode);
  if (!grade) throw fail('The grade ladder is not configured.');
  const priced = await quote(ctx.db, t.variant_id, grade.code, t.vendor_id, now(), ladder);
  if (!priced.ok) throw fail(priced.message);

  let adjustment = 0; let adjustmentReason = ''; let adjustedBy = '';
  const rawAdj = d.manualAdjustment;
  if (rawAdj !== undefined && rawAdj !== '' && rawAdj !== null && Number(rawAdj) !== 0) {
    if (!ADMIN_ONLY.includes(ctx.p.role)) {
      deny(ctx, 'tradein.manualAdjustment', t.id);
      throw fail('Only a Qatar Mobile administrator can adjust an offer.');
    }
    try { adjustment = toCents(rawAdj); } catch { throw invalid('Enter an adjustment amount.'); }
    adjustmentReason = trim(d.manualAdjustmentReason);
    if (!adjustmentReason) throw fail('Give a reason for adjusting the offer.');
    adjustedBy = ctx.p.principalId;
  }
  const finalCents = clampCents(priced.q.valueCents + adjustment);
  if (finalCents === 0 && !TRADEIN_CONFIG.ALLOW_ZERO_VALUE) throw fail('This device grades to zero and cannot be accepted.');

  const fee = await partnerFee(ctx.db, t.vendor_id, finalCents, t.product_id, now());
  const v = variance(toCentsOrNull(t.estimated_value) ?? 0, finalCents);

  await transition(ctx, t, 'FINAL_OFFER_READY', {
    condition_score: computed.score, grade_code: grade.code,
    grade_percentage_snapshot: fraction4ToDecimal(priced.q.gradePercentageBp),
    base_price_snapshot: centsToDecimal(priced.q.basePriceCents), price_effective_date: priced.q.priceEffectiveDate,
    pricing_source: priced.q.source, pricing_rule_id: priced.q.priceId,
    calculated_grade_value: centsToDecimal(priced.q.valueCents),
    manual_adjustment: centsToDecimal(adjustment), manual_adjustment_reason: adjustmentReason || null, manual_adjustment_by: adjustedBy || null,
    final_customer_value: centsToDecimal(finalCents), price_variance: centsToDecimal(v.amount), price_variance_pct: v.percent,
    commission_rule_id: fee.commissionRuleId || null, commission_type_snapshot: fee.commissionType,
    commission_rate_snapshot: microToDecimal(fee.commissionRateMicro), commission_value: centsToDecimal(fee.commissionCents),
    total_settlement: centsToDecimal(fee.totalSettlementCents), currency: CURRENCY, technician: ctx.p.name,
  }, ACTIONS.OFFER_SUBMITTED, {
    grade: grade.code, basePrice: centsToNumber(priced.q.basePriceCents), gradeValue: centsToNumber(priced.q.valueCents),
    adjustment: centsToNumber(adjustment), finalValue: centsToNumber(finalCents), estimatedValue: m(t.estimated_value),
    estimatedGrade: t.estimated_grade ?? '', variance: centsToNumber(v.amount), commission: centsToNumber(fee.commissionCents),
    note: 'These figures are now frozen on the trade-in.',
  });
  await emit.offerReady(ctx.db, t.id, t.customer_id, finalCents);
  if (adjustment !== 0) {
    await audit(ctx, ACTIONS.MANUAL_OVERRIDE, 'TRADEIN', t.id, {
      oldValue: centsToNumber(priced.q.valueCents), newValue: centsToNumber(finalCents), vendorId: t.vendor_id, branchId: t.branch_id,
      details: { reason: adjustmentReason },
    });
  }
  return {
    ok: true, tradeInId: t.id, grade: grade.code, gradeName: grade.name, finalValue: centsToNumber(finalCents), currency: CURRENCY,
    message: `Final offer of ${formatMoney(finalCents)} ${CURRENCY} sent to the customer.`,
  };
}

/**
 * tech.submitOffer = completeInspection + submitFinalOffer, as in 3.1
 * (apiTechSubmitOffer_). Request params are NOT forwarded to the offer.
 * 3.1 ran these as two locked steps, so a refused offer left the
 * inspection COMPLETED; a savepoint reproduces that: the completion is
 * committed, the refused offer is rolled back, and the refusal returned.
 */
export async function techSubmitOffer(ctx: Ctx, p: { tradeInId: string }) {
  await completeInspection(ctx, p);
  await ctx.db.query('savepoint qm_offer');
  try {
    return await submitFinalOffer(ctx, p.tradeInId, {});
  } catch (err) {
    if (err instanceof AppError && err.code === 'BUSINESS_RULE') {
      await ctx.db.query('rollback to savepoint qm_offer');
      throw new CommitThenFail(err);
    }
    throw err;
  }
}

/* -------------------------------------------------------------- evidence */

/** uploadInspectionPhotos_: bytes validated, stored privately, one row per photo. */
export async function uploadPhotos(ctx: Ctx, p: { tradeInId: string; photos: { category?: string; label?: string; dataUrl: string }[] }) {
  const t = await loadTradeInScoped<TradeInRow>(ctx, p.tradeInId, { lock: true });
  const i = await inspectionOf(ctx, t, true);
  if (!i) throw fail('No inspection is open for this trade-in.');
  const list = p.photos ?? [];
  if (!list.length) throw fail('Choose at least one photograph.');
  if (list.length > 8) throw fail('Up to eight photographs at a time.');

  const keys = new Set<string>(PHOTO_CATEGORIES.map((c) => c.key));
  const added: string[] = [];
  const problems: string[] = [];
  for (const ph of list) {
    const category = keys.has(trim(ph.category).toUpperCase()) ? trim(ph.category).toUpperCase() : 'OTHER';
    let img;
    try { img = validateImage(ph.dataUrl, MEDIA.MAX_PHOTO_BYTES); } catch (e) {
      problems.push(e instanceof AppError ? e.message : 'That file could not be read.');
      continue;
    }
    const path = objectName(`${t.id}/${category.toLowerCase()}`, img.ext);
    await ctx.deps.storage.upload('inspection-photos', path, img.bytes, img.mime);
    const r = await ctx.db.query<{ id: string }>(
      `insert into public.inspection_photos (inspection_id, trade_in_id, object_path, category, label, mime_type, size_bytes, sha256, uploaded_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
      [i.id, t.id, path, category, trim(ph.label) || null, img.mime, img.size, img.sha256, ctx.p.name]);
    added.push(r.rows[0]!.id);
  }
  if (added.length) {
    const total = (await ctx.db.query<{ n: number }>('select count(*)::int as n from public.inspection_photos where inspection_id = $1', [i.id])).rows[0]!.n;
    await audit(ctx, ACTIONS.PHOTOS_UPLOADED, 'TRADEIN', t.id, { vendorId: t.vendor_id, branchId: t.branch_id, details: { added: added.length, total } });
  }
  return { ok: true, added: added.length, problems, message: `${added.length} photograph(s) attached.` };
}

/**
 * viewInspectionPhoto_: entitlement is checked on the TRADE-IN before the
 * file is touched; the photo must belong to that trade-in's inspection.
 * Returns a short-lived signed URL. `dataUrl` carries the same URL so the
 * unchanged 3.1 screen (which passes it through QM.safeImageUrl) works.
 */
export async function viewPhoto(ctx: Ctx, p: { tradeInId: string; fileId: string }) {
  const t = await loadTradeInScoped<TradeInRow>(ctx, p.tradeInId);
  if (!t.inspection_id) throw fail('No inspection for this trade-in.');
  const fileId = trim(p.fileId);
  const isUuid = /^[0-9a-f-]{36}$/i.test(fileId);
  const r = await ctx.db.query<{ object_path: string; category: string }>(
    `select object_path, category from public.inspection_photos
      where inspection_id = $1 and ${isUuid ? 'id = $2::uuid' : 'legacy_drive_file_id = $2'}`, [t.inspection_id, fileId]);
  const ph = r.rows[0];
  if (!ph) {
    deny(ctx, 'inspection.photo', fileId);
    throw fail('That photograph does not belong to this inspection.');
  }
  const ttl = ctx.deps.config.SIGNED_URL_TTL_SECONDS;
  const url = await ctx.deps.storage.signedUrl('inspection-photos', ph.object_path, ttl);
  return { ok: true, url, dataUrl: url, expiresInSeconds: ttl, category: ph.category };
}

/* ----------------------------------------------------------- admin rules */

export async function listInspectionRules(ctx: Ctx) {
  const rules = await loadInspectionRules(ctx.db);
  return { ok: true, rules: rules.map((r) => ({ ruleId: r.ruleId, code: r.code, group: r.group, question: r.question, input: r.input, good: r.good, bad: r.bad, impact: r.impact, blocking: r.blocking, order: r.order })) };
}

export async function saveInspectionRule(ctx: Ctx, d: {
  code: string; impact: unknown; group?: string; question?: string; input?: string; good?: string; bad?: string;
  blocking?: unknown; order?: unknown; active?: unknown; notes?: string;
}) {
  const code = trim(d.code).toUpperCase();
  if (!code) throw fail('Which rule?');
  const impact = Number(d.impact);
  if (!Number.isFinite(impact) || impact < 0 || impact > 100) throw fail('An impact is between 0 and 100 points.');
  const existing = (await ctx.db.query<{ id: string; group_name: string; question: string; score_impact: string }>(
    'select id, group_name, question, score_impact from public.inspection_rules where upper(code) = $1 for update', [code])).rows[0];
  const input = trim(d.input).toUpperCase() || 'SWITCH';
  if (!['SWITCH', 'PERCENTAGE', 'LOCK'].includes(input)) throw fail('That input type is not supported.');
  const row = {
    code, group_name: trim(d.group) || existing?.group_name || '', question: trim(d.question) || existing?.question || code,
    input_type: input, good_label: trim(d.good), bad_label: trim(d.bad), score_impact: impact, is_blocking: truthy(d.blocking),
    display_order: Number(d.order) || 99, active: d.active === undefined ? true : truthy(d.active), notes: trim(d.notes) || null,
  };
  if (existing) await updateById(ctx.db, 'inspection_rules', existing.id, row);
  else {
    const id = await nextId(ctx.db, 'IRL');
    await ctx.db.query(
      `insert into public.inspection_rules (id, code, group_name, question, input_type, good_label, bad_label, score_impact, is_blocking, display_order, active, notes)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, row.code, row.group_name, row.question, row.input_type, row.good_label, row.bad_label, row.score_impact, row.is_blocking, row.display_order, row.active, row.notes]);
  }
  await audit(ctx, ACTIONS.INSPECTION_RULE_SET, 'INSPECTION_RULE', code, {
    oldValue: existing ? Number(existing.score_impact) : null, newValue: impact,
    details: { note: 'Applies to future inspections only. Completed ones keep the score they were graded at.' },
  });
  return { ok: true, message: 'Inspection rule saved.' };
}

export { invalid };
