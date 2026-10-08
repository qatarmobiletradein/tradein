/**
 * Audience-specific views (14_TradeIns.gs, 16_Vouchers.gs, 07/08).
 *
 * Three audiences, three separately built objects — never a database row
 * handed over whole. What each view OMITS is the point:
 *   customer   no fee, no settlement, no internal notes, masked IMEI;
 *   partner    their own fee terms, masked IMEI, no other partner's rows;
 *   technician the platform view WITHOUT any IMEI;
 *   admin      everything, including the full IMEI (disputes, police).
 */
import type { Queryable } from '../../../../packages/database/src/db.js';
import {
  CUSTOMER_STATUS_TEXT, CUSTOMER_TIMELINE, CUSTOMER_TIMELINE_STEP, CURRENCY, DEFAULT_ESTIMATE_NOTE, type TradeInStatus,
} from '../../../../packages/domain/src/constants.js';
import { centsToNumber, toCentsOrNull } from '../../../../packages/shared/src/money.js';
import { formatPhone, maskImei, safeHttpsUrl, statusLabel } from '../../../../packages/shared/src/text.js';
import { fmtDate, fmtDateTime } from '../../../../packages/shared/src/time.js';

export interface TradeInRow {
  id: string; customer_id: string; vendor_id: string; branch_id: string; product_id: string; variant_id: string; color_id: string | null;
  brand_snapshot: string | null; category_snapshot: string | null; model_snapshot: string | null; storage_snapshot: string | null; color_snapshot: string | null;
  imei: string | null; serial_number: string | null; customer_name: string | null; customer_phone: string | null;
  condition_answers: Record<string, unknown>; estimated_score: string | null; estimated_grade: string | null; estimated_value: string | null;
  base_price_snapshot: string | null; price_effective_date: Date | null; pricing_source: string | null; pricing_rule_id: string | null;
  condition_score: string | null; grade_code: string | null; grade_percentage_snapshot: string | null; calculated_grade_value: string | null;
  grade_override_from: string | null; grade_override_to: string | null; grade_override_reason: string | null; grade_override_by: string | null; grade_override_at: Date | null;
  manual_adjustment: string; manual_adjustment_reason: string | null; manual_adjustment_by: string | null;
  final_customer_value: string | null; price_variance: string | null; price_variance_pct: string | null;
  commission_rule_id: string | null; commission_type_snapshot: string | null; commission_rate_snapshot: string | null;
  commission_value: string | null; total_settlement: string | null; currency: string;
  status: TradeInStatus; device_received: boolean; device_received_by: string | null; device_received_at: Date | null;
  device_returned_by: string | null; device_returned_at: Date | null; return_reason: string | null;
  collected_at: Date | null; collected_by: string | null;
  inspection_id: string | null; voucher_id: string | null; collection_batch_id: string | null; settlement_id: string | null;
  technician: string | null; accepted_at: Date | null; declined_at: Date | null; decline_reason: string | null;
  notes: string | null; operation_id: string | null; created_at: Date; updated_at: Date;
}

/** Money column → number for a reply (0 when absent), exactly as 3.1 replied Number(x) || 0. */
export const m = (v: string | null | undefined): number => {
  const c = toCentsOrNull(v);
  return c === null ? 0 : centsToNumber(c);
};
export const mOrNull = (v: string | null | undefined): number | null => {
  const c = toCentsOrNull(v);
  return c === null ? null : centsToNumber(c);
};

export const deviceLabel = (t: Pick<TradeInRow, 'brand_snapshot' | 'model_snapshot' | 'storage_snapshot'>): string =>
  [t.brand_snapshot, t.model_snapshot, t.storage_snapshot].filter(Boolean).join(' ');

/** Small per-request cache of names, so list views do not query per row. */
export class Lookups {
  private grades: Map<string, string> | null = null;
  private vendors = new Map<string, { name: string; code: string; logo_url: string | null } | null>();
  private branches = new Map<string, { name: string; address: string | null; contact_phone: string | null; location: string | null; vendor_id: string } | null>();
  private estimateNote: string | null = null;
  constructor(private readonly db: Queryable) {}

  async gradeName(code: string | null): Promise<string> {
    if (!code) return '';
    if (!this.grades) {
      const r = await this.db.query<{ grade_code: string; grade_name: string }>('select grade_code, grade_name from public.grade_rules');
      this.grades = new Map(r.rows.map((g) => [g.grade_code, g.grade_name]));
    }
    return this.grades.get(code) ?? code;
  }
  async vendor(id: string) {
    if (!this.vendors.has(id)) {
      const r = await this.db.query<{ name: string; code: string; logo_url: string | null }>('select name, code, logo_url from public.vendors where id = $1', [id]);
      this.vendors.set(id, r.rows[0] ?? null);
    }
    return this.vendors.get(id) ?? null;
  }
  async branch(id: string | null) {
    if (!id) return null;
    if (!this.branches.has(id)) {
      const r = await this.db.query<{ name: string; address: string | null; contact_phone: string | null; location: string | null; vendor_id: string }>(
        'select name, address, contact_phone, location, vendor_id from public.branches where id = $1', [id]);
      this.branches.set(id, r.rows[0] ?? null);
    }
    return this.branches.get(id) ?? null;
  }
  async note(): Promise<string> {
    if (this.estimateNote === null) {
      const r = await this.db.query<{ value: string }>(`select value from public.settings where key = 'customer.estimateNote'`);
      this.estimateNote = (r.rows[0]?.value ?? '').trim() || DEFAULT_ESTIMATE_NOTE;
    }
    return this.estimateNote;
  }
}

/** storedVariance_: the stored figure, else worked out, else zero. */
export function storedVariance(t: TradeInRow): { amount: number; percent: number | null } {
  if (t.price_variance !== null && t.price_variance !== undefined) {
    return { amount: m(t.price_variance), percent: t.price_variance_pct === null ? null : Number(t.price_variance_pct) };
  }
  const est = toCentsOrNull(t.estimated_value);
  const fin = toCentsOrNull(t.final_customer_value);
  if (est !== null && fin !== null) {
    const amount = fin - est;
    return { amount: centsToNumber(amount), percent: est > 0 ? Math.round((amount / est) * 10000) / 100 : null };
  }
  return { amount: 0, percent: null };
}

export function customerTimelineFor(t: TradeInRow) {
  const at = CUSTOMER_TIMELINE_STEP[t.status] ?? 0;
  const text = CUSTOMER_STATUS_TEXT[t.status];
  if (at < 0) return { ended: true, label: text?.label ?? statusLabel(t.status), detail: text?.detail ?? '', steps: [] };
  const when: Record<string, string> = {
    submitted: fmtDate(t.created_at), estimate: fmtDate(t.created_at), accepted: fmtDate(t.accepted_at),
    received: fmtDate(t.device_received_at), completed: fmtDate(t.collected_at),
  };
  return {
    ended: false,
    steps: CUSTOMER_TIMELINE.map((s, i) => ({ key: s.key, label: s.label, state: i < at ? 'done' : i === at ? 'now' : 'todo', when: when[s.key] ?? '' })),
  };
}

export async function customerTradeInView(db: Queryable, L: Lookups, t: TradeInRow) {
  const text = CUSTOMER_STATUS_TEXT[t.status] ?? { label: statusLabel(t.status), detail: '' };
  const view: Record<string, unknown> = {
    tradeInId: t.id, status: t.status, statusLabel: text.label, statusDetail: text.detail,
    device: deviceLabel(t), brand: t.brand_snapshot ?? '', model: t.model_snapshot ?? '', storage: t.storage_snapshot ?? '',
    color: t.color_snapshot ?? '', imei: maskImei(t.imei),
    estimatedValue: m(t.estimated_value), estimatedGrade: t.estimated_grade ?? '',
    estimatedGradeName: t.estimated_grade ? await L.gradeName(t.estimated_grade) : '',
    estimateNote: await L.note(), currency: t.currency?.trim() || CURRENCY, createdDate: fmtDate(t.created_at),
    branch: '', branchAddress: '', branchPhone: '', vendor: '',
  };
  const b = await L.branch(t.branch_id);
  if (b) { view.branch = b.name; view.branchAddress = b.address ?? ''; view.branchPhone = formatPhone(b.contact_phone); }
  const v = await L.vendor(t.vendor_id);
  if (v) view.vendor = v.name;
  if (m(t.final_customer_value) || t.grade_code) {
    view.grade = t.grade_code ?? '';
    view.gradeName = await L.gradeName(t.grade_code);
    view.finalValue = m(t.final_customer_value);
    const cv = storedVariance(t);
    view.variance = cv.amount; view.variancePct = cv.percent;
  }
  view.awaitingDecision = t.status === 'FINAL_OFFER_READY';
  if (t.voucher_id) {
    const r = await db.query<{ voucher_number: string; customer_value: string; issued_at: Date; status: string }>(
      'select voucher_number, customer_value, issued_at, status from public.vouchers where id = $1', [t.voucher_id]);
    const vc = r.rows[0];
    if (vc && vc.status === 'ISSUED') {
      view.voucherNumber = vc.voucher_number; view.voucherValue = m(vc.customer_value); view.voucherDate = fmtDate(vc.issued_at);
    }
  }
  view.timeline = customerTimelineFor(t);
  return view;
}

export async function vendorTradeInView(L: Lookups, t: TradeInRow) {
  return {
    tradeInId: t.id, status: t.status, statusLabel: statusLabel(t.status), device: deviceLabel(t),
    color: t.color_snapshot ?? '', imei: maskImei(t.imei), grade: t.grade_code ?? '', gradeName: await L.gradeName(t.grade_code),
    customerName: t.customer_name ?? '', customerPhone: formatPhone(t.customer_phone),
    customerValue: m(t.final_customer_value), commission: m(t.commission_value), settlement: m(t.total_settlement),
    currency: t.currency?.trim() || CURRENCY, deviceReceived: t.device_received, voucherId: t.voucher_id ?? '',
    branchId: t.branch_id, createdDate: fmtDate(t.created_at), acceptedDate: fmtDate(t.accepted_at),
  };
}

export async function adminTradeInView(L: Lookups, t: TradeInRow) {
  const v: Record<string, unknown> = await vendorTradeInView(L, t);
  v.vendorId = t.vendor_id;
  v.vendorName = (await L.vendor(t.vendor_id))?.name ?? '';
  v.basePriceSnapshot = mOrNull(t.base_price_snapshot) || null;
  v.priceEffectiveDate = fmtDate(t.price_effective_date);
  v.pricingSource = t.pricing_source ?? '';
  v.gradePercentage = t.grade_percentage_snapshot === null ? null : Number(t.grade_percentage_snapshot) || null;
  v.calculatedValue = m(t.calculated_grade_value);
  v.manualAdjustment = m(t.manual_adjustment);
  v.adjustmentReason = t.manual_adjustment_reason ?? '';
  v.commissionRate = t.commission_rate_snapshot === null ? 0 : Number(t.commission_rate_snapshot) || 0;
  v.commissionType = t.commission_type_snapshot ?? '';
  v.technician = t.technician ?? '';
  v.inspectionId = t.inspection_id ?? '';
  v.collectionBatchId = t.collection_batch_id ?? '';
  v.settlementId = t.settlement_id ?? '';
  v.returnReason = t.return_reason ?? '';
  v.notes = t.notes ?? '';
  v.imeiFull = t.imei ?? '';
  v.estimatedValue = m(t.estimated_value);
  v.estimatedGrade = t.estimated_grade ?? '';
  v.estimatedScore = t.estimated_score === null ? null : Number(t.estimated_score);
  v.conditionScore = t.condition_score === null ? null : Number(t.condition_score);
  const sv = storedVariance(t);
  v.variance = sv.amount; v.variancePct = sv.percent;
  if (t.grade_override_to) {
    v.gradeOverride = { from: t.grade_override_from ?? '', to: t.grade_override_to, reason: t.grade_override_reason ?? '',
      by: t.grade_override_by ?? '', date: fmtDateTime(t.grade_override_at) };
  }
  v.collectedDate = fmtDateTime(t.collected_at);
  v.collectedBy = t.collected_by ?? '';
  return v;
}

/** technicianQueueView_: the admin view minus BOTH the full and the masked IMEI. */
export async function technicianQueueView(L: Lookups, t: TradeInRow) {
  const v = await adminTradeInView(L, t);
  delete v.imeiFull;
  delete v.imei;
  return v;
}

export function publicBranchView(b: { id: string; vendor_id: string; name: string; address: string | null; location: string | null; contact_phone: string | null }) {
  return { branchId: b.id, vendorId: b.vendor_id, name: b.name, address: b.address ?? '', location: b.location ?? '', phone: formatPhone(b.contact_phone) };
}

export function publicVendorView(v: { id: string; name: string; code: string; logo_url: string | null }) {
  return { vendorId: v.id, name: v.name, code: v.code, logoUrl: safeHttpsUrl(v.logo_url) };
}
