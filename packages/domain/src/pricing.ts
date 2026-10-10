/**
 * Base prices and partner fees (10_Pricing.gs, 12_CommissionRules.gs).
 *
 * Pure selection logic over rows the caller has loaded. Keeping selection
 * here (not in SQL) keeps the "most specific rule wins, ties by newest
 * start" ordering in one readable place, tested without a database.
 */
import { COMMISSION_TYPE, DEFAULT_COMMISSION_RATE, PRICE_SOURCE, type CommissionType } from './constants.js';
import { inEffectiveWindow } from '../../shared/src/time.js';
import { applyRateMicro, clampCents, roundRatio, toMicro, type Cents } from '../../shared/src/money.js';

export interface PriceRow {
  id: string;
  basePriceCents: Cents;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  active: boolean;
  currency: string;
}

/** pickEffective_: among rows whose [from,to) contains `at`, the newest start. Cancelled rows never count. */
export function pickEffective<T extends { effectiveFrom: Date; effectiveTo: Date | null; active: boolean }>(
  rows: T[], at: Date,
): T | null {
  const live = rows.filter((r) => r.active && inEffectiveWindow(r.effectiveFrom, r.effectiveTo, at));
  if (!live.length) return null;
  live.sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime());
  return live[0]!;
}

export type ResolvedPrice =
  | { ok: true; basePriceCents: Cents; source: 'VENDOR_OVERRIDE' | 'MASTER'; priceId: string; effectiveFrom: Date; currency: string }
  | { ok: false; message: string; source: 'NONE' };

/** resolveBasePrice_: the vendor's own price in force, else the master price, else none. */
export function resolveBasePrice(vendorRows: PriceRow[], masterRows: PriceRow[], at: Date): ResolvedPrice {
  const v = pickEffective(vendorRows, at);
  if (v) return { ok: true, basePriceCents: v.basePriceCents, source: PRICE_SOURCE.VENDOR, priceId: v.id, effectiveFrom: v.effectiveFrom, currency: v.currency };
  const m = pickEffective(masterRows, at);
  if (m) return { ok: true, basePriceCents: m.basePriceCents, source: PRICE_SOURCE.MASTER, priceId: m.id, effectiveFrom: m.effectiveFrom, currency: m.currency };
  return { ok: false, message: 'This model has no trade-in price yet.', source: PRICE_SOURCE.NONE };
}

export interface CommissionRuleRow {
  id: string;
  vendorId: string;
  brandId: string | null;
  categoryId: string | null;
  productId: string | null;
  type: CommissionType;
  /** numeric(12,6) as a string from the database. */
  value: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  active: boolean;
}

export interface ProductKeys { productId: string; brandId: string; categoryId: string | null }

function specificity(r: CommissionRuleRow): number {
  if (r.productId) return 4;
  if (r.categoryId) return 3;
  if (r.brandId) return 2;
  return 1;
}

/** resolveCommissionRule_: product > category > brand > vendor-wide; ties → newest start. */
export function resolveCommissionRule(
  rules: CommissionRuleRow[], vendorId: string, product: ProductKeys | null, at: Date,
): CommissionRuleRow | null {
  const productId = product?.productId ?? '';
  const brandId = product?.brandId ?? '';
  const categoryId = product?.categoryId ?? '';
  const candidates = rules.filter((r) => {
    if (!r.active) return false;
    if (r.vendorId !== vendorId) return false;
    if (!inEffectiveWindow(r.effectiveFrom, r.effectiveTo, at)) return false;
    if (r.productId && r.productId !== productId) return false;
    if (r.categoryId && r.categoryId !== categoryId) return false;
    if (r.brandId && r.brandId !== brandId) return false;
    return true;
  });
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const d = specificity(b) - specificity(a);
    return d !== 0 ? d : b.effectiveFrom.getTime() - a.effectiveFrom.getTime();
  });
  return candidates[0]!;
}

export interface CommissionResult {
  customerValueCents: Cents;
  commissionType: CommissionType;
  /** The rate as stored: a fraction for PERCENTAGE, an amount for FIXED, 6 decimals. */
  commissionRateMicro: bigint;
  commissionCents: Cents;
  totalSettlementCents: Cents;
  commissionRuleId: string;
  source: 'RULE' | 'VENDOR_DEFAULT' | 'PLATFORM_DEFAULT';
}

/**
 * commissionFor_: fee for one transaction.
 *   PERCENTAGE → clamp(value × rate); FIXED → clamp(rate).
 *   total settlement = value + fee.
 * A negative or unreadable rate is treated as zero, as 3.1 did.
 */
export function commissionFor(
  customerValueCents: Cents, rule: CommissionRuleRow | null, vendorDefaultRate: string | null,
): CommissionResult {
  const value = clampCents(customerValueCents);
  let type: CommissionType = COMMISSION_TYPE.PERCENTAGE;
  let rate: bigint;
  let ruleId = '';
  let source: CommissionResult['source'];

  const safeMicro = (v: string | null): bigint | null => {
    if (v === null || v === undefined || v === '') return null;
    try { return toMicro(v); } catch { return null; }
  };

  if (rule) {
    type = rule.type || COMMISSION_TYPE.PERCENTAGE;
    rate = safeMicro(rule.value) ?? 0n;
    ruleId = rule.id;
    source = 'RULE';
  } else {
    const vendorRate = safeMicro(vendorDefaultRate);
    if (vendorRate !== null) { rate = vendorRate; source = 'VENDOR_DEFAULT'; }
    else { rate = toMicro(DEFAULT_COMMISSION_RATE); source = 'PLATFORM_DEFAULT'; }
  }
  if (rate < 0n) rate = 0n;

  // FIXED: the stored value IS an amount (6 dp) → cents with Math.round semantics.
  // INVOICE_PERCENTAGE: invoice = value / (1 − rate), rounded to the cent (half up); the fee is the
  // difference, so value + fee = invoice exactly. A rate of 1 or more cannot be a share of an invoice
  // (the database refuses it); treated as zero here, like any unreadable rate.
  let commission: Cents;
  if (type === COMMISSION_TYPE.FIXED) commission = clampCents(Number(roundRatio(rate, 10_000n)));
  else if (type === COMMISSION_TYPE.INVOICE_PERCENTAGE) {
    if (rate >= 1_000_000n) rate = 0n;
    commission = clampCents(Number(roundRatio(BigInt(value) * 1_000_000n, 1_000_000n - rate)) - value);
  } else commission = applyRateMicro(value, rate);

  return {
    customerValueCents: value,
    commissionType: type,
    commissionRateMicro: rate,
    commissionCents: commission,
    totalSettlementCents: value + commission,
    commissionRuleId: ruleId,
    source,
  };
}
