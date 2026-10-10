/**
 * Database-backed pricing inputs: the grade ladder, inspection rules,
 * prices and partner-fee rules. The selection logic lives in
 * packages/domain; this file only loads rows and converts types exactly.
 */
import type { CommissionType } from '../../../../packages/domain/src/constants.js';
import type { Queryable } from '../../../../packages/database/src/db.js';
import {
  commissionFor as computeCommission, gradeValue, resolveBasePrice, resolveCommissionRule,
  type CommissionResult, type CommissionRuleRow, type GradeRule, type InspectionRule, type PriceRow,
} from '../../../../packages/domain/src/index.js';
import { AppError } from '../../../../packages/shared/src/errors.js';
import { toCents, toFraction4, type Cents } from '../../../../packages/shared/src/money.js';

export async function loadGradeLadder(db: Queryable): Promise<GradeRule[]> {
  const r = await db.query<{ id: string; grade_code: string; grade_name: string; percentage_of_base: string; min_score: string; display_order: number; is_terminal: boolean }>(
    `select id, grade_code, grade_name, percentage_of_base, min_score, display_order, is_terminal
       from public.grade_rules where active order by display_order, grade_code`);
  if (!r.rows.length) throw new AppError('BUSINESS_RULE', 'The grade ladder is not configured.');
  return r.rows.map((g) => ({
    gradeRuleId: g.id, code: g.grade_code.toUpperCase(), name: g.grade_name,
    percentageBp: toFraction4(g.percentage_of_base), minScore: Number(g.min_score),
    order: g.display_order, terminal: g.is_terminal,
  }));
}

export async function loadInspectionRules(db: Queryable): Promise<InspectionRule[]> {
  const r = await db.query<{ id: string; code: string; group_name: string; question: string; input_type: string; good_label: string; bad_label: string; score_impact: string; is_blocking: boolean; display_order: number }>(
    `select id, code, group_name, question, input_type, good_label, bad_label, score_impact, is_blocking, display_order
       from public.inspection_rules where active order by display_order, code`);
  return r.rows.map((x) => ({
    ruleId: x.id, code: x.code.toUpperCase(), group: x.group_name, question: x.question,
    input: (x.input_type.toUpperCase() || 'SWITCH') as InspectionRule['input'],
    good: x.good_label, bad: x.bad_label, impact: Number(x.score_impact) || 0, blocking: x.is_blocking, order: x.display_order,
  }));
}

type PriceDb = { id: string; base_price: string; effective_from: Date; effective_to: Date | null; active: boolean; currency: string };
const toPriceRow = (r: PriceDb): PriceRow => ({
  id: r.id, basePriceCents: toCents(r.base_price), effectiveFrom: r.effective_from, effectiveTo: r.effective_to,
  active: r.active, currency: r.currency.trim(),
});

export async function resolvePrice(db: Queryable, variantId: string, vendorId: string | null, at: Date) {
  const vendorRows = vendorId
    ? (await db.query<PriceDb>(
      `select id, base_price, effective_from, effective_to, active, currency from public.vendor_prices
        where vendor_id = $1 and variant_id = $2 and active`, [vendorId, variantId])).rows.map(toPriceRow)
    : [];
  const masterRows = (await db.query<PriceDb>(
    `select id, base_price, effective_from, effective_to, active, currency from public.master_prices
      where variant_id = $1 and active`, [variantId])).rows.map(toPriceRow);
  return resolveBasePrice(vendorRows, masterRows, at);
}

export interface Quote {
  basePriceCents: Cents;
  source: 'VENDOR_OVERRIDE' | 'MASTER';
  priceId: string;
  priceEffectiveDate: Date;
  gradeCode: string;
  gradeName: string;
  gradePercentageBp: number;
  gradeRuleId: string;
  valueCents: Cents;
  currency: string;
}

/** quote_: the one path the technician screen, the estimate and the final offer all use. */
export async function quote(
  db: Queryable, variantId: string, gradeCode: string, vendorId: string | null, at: Date, ladder: GradeRule[],
): Promise<{ ok: true; q: Quote } | { ok: false; message: string }> {
  const price = await resolvePrice(db, variantId, vendorId, at);
  if (!price.ok) return { ok: false, message: price.message };
  const g = gradeValue(price.basePriceCents, gradeCode, ladder);
  if (!g.ok) return { ok: false, message: g.message };
  return {
    ok: true,
    q: {
      basePriceCents: price.basePriceCents, source: price.source, priceId: price.priceId,
      priceEffectiveDate: price.effectiveFrom, gradeCode: g.rule.code, gradeName: g.rule.name,
      gradePercentageBp: g.rule.percentageBp, gradeRuleId: g.rule.gradeRuleId, valueCents: g.value, currency: price.currency,
    },
  };
}

/** commissionFor_ with the rows loaded from the database. */
export async function partnerFee(db: Queryable, vendorId: string, valueCents: Cents, productId: string | null, at: Date): Promise<CommissionResult> {
  let product: { productId: string; brandId: string; categoryId: string | null } | null = null;
  if (productId) {
    const p = await db.query<{ id: string; brand_id: string; category_id: string | null }>(
      'select id, brand_id, category_id from public.products where id = $1', [productId]);
    if (p.rows[0]) product = { productId: p.rows[0].id, brandId: p.rows[0].brand_id, categoryId: p.rows[0].category_id };
  }
  const rules = (await db.query<{ id: string; vendor_id: string; brand_id: string | null; category_id: string | null; product_id: string | null; commission_type: CommissionType; commission_value: string; effective_from: Date; effective_to: Date | null; active: boolean }>(
    `select id, vendor_id, brand_id, category_id, product_id, commission_type, commission_value, effective_from, effective_to, active
       from public.commission_rules where vendor_id = $1 and active`, [vendorId])).rows
    .map<CommissionRuleRow>((r) => ({
      id: r.id, vendorId: r.vendor_id, brandId: r.brand_id, categoryId: r.category_id, productId: r.product_id,
      type: r.commission_type, value: r.commission_value, effectiveFrom: r.effective_from, effectiveTo: r.effective_to, active: r.active,
    }));
  const rule = resolveCommissionRule(rules, vendorId, product, at);
  let vendorDefault: string | null = null;
  if (!rule) {
    const v = await db.query<{ default_commission_rate: string }>('select default_commission_rate from public.vendors where id = $1', [vendorId]);
    vendorDefault = v.rows[0]?.default_commission_rate ?? null;
  }
  return computeCommission(valueCents, rule, vendorDefault);
}

export async function gradeNameOf(db: Queryable, code: string | null): Promise<string> {
  if (!code) return '';
  const r = await db.query<{ grade_name: string }>('select grade_name from public.grade_rules where grade_code = $1', [code]);
  return r.rows[0]?.grade_name ?? code;
}
