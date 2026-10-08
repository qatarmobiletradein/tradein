/**
 * Dashboards and reports (19_Reports.gs). Scope is applied to the ROWS
 * first, then every figure is computed from what is left — so no total
 * can include another partner's or another branch's money. Arithmetic is
 * in integer cents.
 */
import { BILLABLE_STATUSES, CURRENCY, ROLE_LABELS, STATUS } from '../../../../packages/domain/src/constants.js';
import { requirePlatform } from '../../../../packages/auth/src/authz.js';
import { centsToNumber, toCentsOrNull } from '../../../../packages/shared/src/money.js';
import { safeHttpsUrl, sameLabel, statusLabel, toCsv, trim, truthy } from '../../../../packages/shared/src/text.js';
import { BUSINESS_TZ, businessDate, fmtDate, inDateRange, parseDayEnd, parseDayStart } from '../../../../packages/shared/src/time.js';
import type { Ctx } from '../context.js';
import { loadGradeLadder } from '../lib/rules.js';
import { listCollections } from './collections.js';
import { countUnpricedVariants } from './pricing.js';
import { listSettlements } from './settlements.js';
import { Lookups, adminTradeInView, vendorTradeInView, type TradeInRow } from './views.js';
import { listVouchers } from './vouchers.js';

const c = (v: string | null | undefined): number => toCentsOrNull(v) ?? 0;
const sumC = (rows: TradeInRow[], k: keyof TradeInRow) => rows.reduce((a, t) => a + c(t[k] as string), 0);
const n = (cents: number) => centsToNumber(cents);
const billable = (rows: TradeInRow[]) => rows.filter((t) => BILLABLE_STATUSES.includes(t.status));
const countStatus = (rows: TradeInRow[], s: string) => rows.filter((t) => t.status === s).length;

/** filterByScope_: platform staff all rows; partner staff own partner (and branch if bound); customers their own. */
async function scopedTradeIns(ctx: Ctx): Promise<TradeInRow[]> {
  if (ctx.p.isPlatform) return (await ctx.db.query<TradeInRow>('select * from public.trade_ins')).rows;
  if (ctx.p.principalType === 'CUSTOMER') return (await ctx.db.query<TradeInRow>('select * from public.trade_ins where customer_id = $1', [ctx.p.principalId])).rows;
  return (await ctx.db.query<TradeInRow>(
    `select * from public.trade_ins where vendor_id = $1 ${ctx.p.branchId ? 'and branch_id = $2' : ''}`,
    ctx.p.branchId ? [ctx.p.vendorId, ctx.p.branchId] : [ctx.p.vendorId])).rows;
}

interface Filters { vendorId?: string; branchId?: string; status?: string; grade?: string; brand?: string; model?: string; from?: string; to?: string }
function applyFilters(rows: TradeInRow[], f: Filters & { billableOnly?: unknown }): TradeInRow[] {
  return rows.filter((t) => {
    if (f.vendorId && t.vendor_id !== f.vendorId) return false;
    if (f.branchId && t.branch_id !== f.branchId) return false;
    if (f.status && t.status !== f.status) return false;
    if (f.grade && t.grade_code !== f.grade) return false;
    if (f.brand && !sameLabel(t.brand_snapshot, f.brand)) return false;
    if (f.model && !sameLabel(t.model_snapshot, f.model)) return false;
    if (truthy(f.billableOnly) && !BILLABLE_STATUSES.includes(t.status)) return false;
    return inDateRange(t.created_at, f.from, f.to);
  });
}

function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) { const k = key(r); const l = m.get(k); if (l) l.push(r); else m.set(k, [r]); }
  return m;
}

async function topBy(rows: TradeInRow[], key: (t: TradeInRow) => string, label: (k: string) => Promise<string> | string, limit = 10) {
  const out = [];
  for (const [k, list] of groupBy(rows, key)) out.push({ key: k, label: await label(k), count: list.length, value: n(sumC(billable(list), 'final_customer_value')) });
  return out.sort((a, b) => b.count - a.count || b.value - a.value).slice(0, limit);
}

async function gradeDistribution(ctx: Ctx, rows: TradeInRow[]) {
  const graded = rows.filter((t) => t.grade_code);
  const tally = new Map<string, number>();
  for (const t of graded) tally.set(t.grade_code!, (tally.get(t.grade_code!) ?? 0) + 1);
  return (await loadGradeLadder(ctx.db)).map((r) => {
    const k = tally.get(r.code) ?? 0;
    return { code: r.code, name: r.name, count: k, percentage: graded.length ? Math.round((k * 1000) / graded.length) / 10 : 0 };
  });
}

function startOfBusinessDay(d: Date): Date { return parseDayStart(businessDate(d))!; }
function monthStart(d: Date, offset = 0): Date {
  const [y, m] = businessDate(d).split('-').map(Number) as [number, number];
  const dt = new Date(Date.UTC(y, m - 1 + offset, 1));
  return parseDayStart(`${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-01`)!;
}

function dailySeries(rows: TradeInRow[], days: number) {
  const out = [];
  const base = startOfBusinessDay(new Date());
  for (let i = days - 1; i >= 0; i--) {
    const from = new Date(base.getTime() - i * 86_400_000);
    const to = new Date(from.getTime() + 86_400_000);
    const list = rows.filter((t) => t.created_at >= from && t.created_at < to);
    out.push({ date: fmtDate(from), count: list.length, value: n(sumC(list, 'final_customer_value')) });
  }
  return out;
}

export async function platformDashboard(ctx: Ctx, f: Filters) {
  requirePlatform(ctx);
  const L = new Lookups(ctx.db);
  const all = applyFilters((await ctx.db.query<TradeInRow>('select * from public.trade_ins')).rows, f);
  const now = new Date();
  const thisMonth = all.filter((t) => t.created_at >= monthStart(now));
  const today = all.filter((t) => t.created_at >= startOfBusinessDay(now));
  const bill = billable(all);
  const counts = (await ctx.db.query<{ vendors: number; branches: number; products: number; customers: number; pending_staff: number; exceptions: number }>(
    `select (select count(*)::int from public.vendors where status = 'ACTIVE') as vendors,
            (select count(*)::int from public.branches where active) as branches,
            (select count(*)::int from public.products where active) as products,
            (select count(*)::int from public.customers where status = 'ACTIVE') as customers,
            (select count(*)::int from public.app_users where status = 'PENDING_APPROVAL') as pending_staff,
            (select count(*)::int from public.collections where status = 'COLLECTION_EXCEPTION') as exceptions`)).rows[0]!;
  const st = (await ctx.db.query<{ status: string; settlement_total: string }>('select status, settlement_total from public.settlements')).rows;
  const paidSt = st.filter((s) => s.status === 'PAID' || s.status === 'CLOSED');
  const undated = (await ctx.db.query<{ n: number }>(
    `select count(*)::int as n from public.trade_ins t left join public.collections c on c.id = t.collection_batch_id
      where t.status = 'COLLECTED' and t.settlement_id is null and t.collected_at is null and c.collected_at is null`)).rows[0]!.n;
  const byVendor = [];
  for (const [vendorId, list] of groupBy(all, (t) => t.vendor_id)) {
    const b = billable(list);
    byVendor.push({ vendorId, vendorName: (await L.vendor(vendorId))?.name ?? vendorId, tradeIns: list.length, completed: b.length,
      customerValue: n(sumC(b, 'final_customer_value')), commission: n(sumC(b, 'commission_value')), settlement: n(sumC(b, 'total_settlement')) });
  }
  byVendor.sort((a, b) => b.settlement - a.settlement);
  return {
    ok: true,
    marketplace: { vendors: counts.vendors, branches: counts.branches, products: counts.products, customers: counts.customers },
    average: { tradeInValue: bill.length ? n(Math.round(sumC(bill, 'final_customer_value') / bill.length)) : 0 },
    settlementSummary: { pending: st.filter((s) => ['DRAFT', 'SUBMITTED', 'APPROVED'].includes(s.status)).length, paid: paidSt.length,
      paidValue: n(paidSt.reduce((a, s) => a + c(s.settlement_total), 0)) },
    branchesTop: await topBy(all, (t) => t.branch_id, async (k) => (await L.branch(k))?.name ?? '(unassigned)'),
    modelsTop: await topBy(all, (t) => t.model_snapshot ?? '', (k) => k || '(unknown)'),
    today: { submitted: today.length, value: n(sumC(today, 'final_customer_value')) },
    month: { submitted: thisMonth.length, customerValue: n(sumC(thisMonth, 'final_customer_value')), commission: n(sumC(thisMonth, 'commission_value')), settlement: n(sumC(thisMonth, 'total_settlement')) },
    lifetime: { tradeIns: all.length, paidOut: n(sumC(bill, 'final_customer_value')), commission: n(sumC(bill, 'commission_value')) },
    queues: {
      awaitingInspection: countStatus(all, STATUS.PENDING_TECHNICIAN),
      inInspection: countStatus(all, STATUS.INSPECTION_IN_PROGRESS) + countStatus(all, STATUS.INSPECTION_COMPLETED),
      awaitingCustomer: countStatus(all, STATUS.FINAL_OFFER_READY), awaitingDevice: countStatus(all, STATUS.CUSTOMER_ACCEPTED),
      awaitingVoucher: countStatus(all, STATUS.DEVICE_RECEIVED) + countStatus(all, STATUS.AWAITING_VOUCHER),
      awaitingCollection: countStatus(all, STATUS.READY_FOR_COLLECTION), awaitingSettlement: countStatus(all, STATUS.COLLECTED),
      returnsPending: countStatus(all, STATUS.RETURN_PENDING),
    },
    attention: {
      unpricedVariants: await countUnpricedVariants(ctx), pendingStaff: counts.pending_staff,
      unsettledCollected: n(sumC(all.filter((t) => t.status === 'COLLECTED' && !t.settlement_id), 'total_settlement')),
      stuckOverAWeek: all.filter((t) => !['CLOSED', 'CANCELLED'].includes(t.status) && Date.now() - t.updated_at.getTime() > 7 * 86_400_000).length,
      undatedCollected: undated, collectionExceptions: counts.exceptions,
    },
    vendors: byVendor, grades: await gradeDistribution(ctx, thisMonth), daily: dailySeries(all, 30), currency: CURRENCY,
  };
}

export async function vendorDashboard(ctx: Ctx) {
  const L = new Lookups(ctx.db);
  const mine = await scopedTradeIns(ctx);
  const now = new Date();
  const thisMonth = mine.filter((t) => t.created_at >= monthStart(now));
  const bill = billable(mine);
  const vendor = ctx.p.vendorId ? await L.vendor(ctx.p.vendorId) : null;
  const monthly = [];
  for (let i = 11; i >= 0; i--) {
    const from = monthStart(now, -i); const to = monthStart(now, -i + 1);
    const inMonth = mine.filter((t) => t.created_at >= from && t.created_at < to);
    const b = billable(inMonth);
    const label = new Intl.DateTimeFormat('en-GB', { timeZone: BUSINESS_TZ, month: 'short', year: 'numeric' }).format(new Date(from.getTime() + 86_400_000));
    monthly.push({ month: businessDate(new Date(from.getTime() + 3600_000 * 12)).slice(0, 7), label, count: inMonth.length,
      value: n(sumC(b, 'final_customer_value')), commission: n(sumC(b, 'commission_value')) });
  }
  const recent = [];
  for (const t of [...mine].sort((a, b) => b.created_at.getTime() - a.created_at.getTime()).slice(0, 8)) recent.push(await vendorTradeInView(L, t));
  const branches = [];
  for (const [branchId, list] of groupBy(mine, (t) => t.branch_id)) {
    const b = billable(list);
    branches.push({ branchId, branchName: (await L.branch(branchId))?.name ?? '(unassigned)', tradeIns: list.length,
      customerValue: n(sumC(b, 'final_customer_value')), commission: n(sumC(b, 'commission_value')) });
  }
  branches.sort((a, b) => b.tradeIns - a.tradeIns);
  return {
    ok: true,
    vendor: vendor ? { name: vendor.name, code: vendor.code, logoUrl: safeHttpsUrl(vendor.logo_url) } : null,
    month: { tradeIns: thisMonth.length, customerValue: n(sumC(thisMonth, 'final_customer_value')), commission: n(sumC(thisMonth, 'commission_value')), settlement: n(sumC(thisMonth, 'total_settlement')) },
    lifetime: { tradeIns: mine.length, commission: n(sumC(bill, 'commission_value')) },
    actionNeeded: { awaitingDevice: countStatus(mine, 'CUSTOMER_ACCEPTED'), awaitingVoucher: countStatus(mine, 'DEVICE_RECEIVED') + countStatus(mine, 'AWAITING_VOUCHER'),
      awaitingPickup: countStatus(mine, 'READY_FOR_COLLECTION'), returnsPending: countStatus(mine, 'RETURN_PENDING') },
    owed: n(sumC(mine.filter((t) => t.status === 'COLLECTED' && !t.settlement_id), 'total_settlement')),
    pipeline: {
      total: mine.length,
      pendingInspection: countStatus(mine, 'PENDING_TECHNICIAN') + countStatus(mine, 'INSPECTION_IN_PROGRESS') + countStatus(mine, 'INSPECTION_COMPLETED'),
      awaitingVoucher: countStatus(mine, 'DEVICE_RECEIVED') + countStatus(mine, 'AWAITING_VOUCHER'),
      readyForCollection: countStatus(mine, 'READY_FOR_COLLECTION'), collected: countStatus(mine, 'COLLECTED'),
      settled: countStatus(mine, 'SETTLED') + countStatus(mine, 'CLOSED'),
    },
    lifetimeValue: n(sumC(bill, 'final_customer_value')),
    byStatus: await topBy(mine, (t) => t.status, (k) => statusLabel(k), 20),
    byBrand: await topBy(mine, (t) => t.brand_snapshot ?? '', (k) => k || '(unknown)'),
    byModel: await topBy(mine, (t) => t.model_snapshot ?? '', (k) => k || '(unknown)'),
    monthly, recent, branches, daily: dailySeries(mine, 30), grades: await gradeDistribution(ctx, thisMonth), currency: CURRENCY,
  };
}

function reportKey(groupBy: string): (t: TradeInRow) => string {
  switch (groupBy) {
    case 'vendor': return (t) => t.vendor_id;
    case 'branch': return (t) => t.branch_id;
    case 'grade': return (t) => t.grade_code || '(ungraded)';
    case 'brand': return (t) => t.brand_snapshot || '(unknown)';
    case 'model': return (t) => t.model_snapshot || '(unknown)';
    case 'device': return (t) => [t.brand_snapshot, t.model_snapshot, t.storage_snapshot].filter(Boolean).join(' ') || '(unknown)';
    case 'technician': return (t) => t.technician || '(none)';
    case 'month': return (t) => businessDate(t.created_at).slice(0, 7);
    case 'day': return (t) => fmtDate(t.created_at) || '(no date)';
    default: return (t) => t.status;
  }
}

/** buildReport_ + the voucher, collection, settlement and inspection reports, optionally as CSV. */
export async function buildReport(ctx: Ctx, f: Filters & { reportType?: string; groupBy?: string; billableOnly?: unknown; includeRows?: unknown; asCsv?: unknown }) {
  const type = trim(f.reportType).toUpperCase();
  const period = { from: fmtDate(parseDayStart(f.from)), to: fmtDate(parseDayEnd(f.to)) };
  let report: Record<string, unknown>;
  if (type === 'VOUCHER') {
    const l = await listVouchers(ctx, { from: f.from, to: f.to, status: f.status, branchId: f.branchId, limit: 1000 });
    report = { ok: true, reportType: 'VOUCHER', filters: period, columns: ['Voucher', 'Trade-in', 'Branch', 'Customer value', 'Commission', 'Issued', 'Status'],
      rows: l.vouchers.map((v) => [v.voucherNumber, v.tradeInId, v.branch, v.customerValue, v.commission, v.issuedDate, v.status]),
      totals: { count: l.total, ...l.totals }, currency: CURRENCY };
  } else if (type === 'COLLECTION') {
    const l = await listCollections(ctx, { from: f.from, to: f.to, status: f.status, vendorId: f.vendorId, branchId: f.branchId, limit: 500 });
    report = { ok: true, reportType: 'COLLECTION', filters: period,
      columns: ['Note', 'Vendor', 'Branch', 'Expected', 'Collected', 'Missing', 'Exceptions', 'Expected amount', 'Actual amount', 'Created', 'Collected', 'By', 'Status'],
      rows: l.batches.map((b) => [b.batchId, b.vendorName, b.branchName, b.expectedDevices, b.collectedDevices, b.missingDevices, b.exceptionDevices, b.expectedAmount, b.actualAmount, b.createdDate, b.collectedDate, b.collectedBy, b.status]),
      totals: { count: l.total, expected: n(l.batches.reduce((a, b) => a + Math.round(b.expectedAmount * 100), 0)), actual: n(l.batches.reduce((a, b) => a + Math.round(b.actualAmount * 100), 0)), exceptions: l.exceptionCount },
      currency: CURRENCY };
  } else if (type === 'SETTLEMENT') {
    const l = await listSettlements(ctx, { from: f.from, to: f.to, status: f.status, vendorId: f.vendorId, limit: 500 });
    report = { ok: true, reportType: 'SETTLEMENT', filters: period,
      columns: ['Settlement', 'Vendor', 'From', 'To', 'Devices', 'Customer value', 'Commission', 'Total', 'Status', 'Approved', 'Paid', 'Reference'],
      rows: l.settlements.map((s) => [s.settlementId, s.vendorName, s.periodFrom, s.periodTo, s.tradeInCount, s.customerValue, s.commission, s.settlement, s.statusLabel, s.approvedDate, s.paidDate, s.reference]),
      totals: { count: l.total, outstanding: l.outstanding, settlement: n(l.settlements.reduce((a, s) => a + Math.round(s.settlement * 100), 0)), commission: n(l.settlements.reduce((a, s) => a + Math.round(s.commission * 100), 0)) },
      currency: CURRENCY };
  } else if (type === 'INSPECTION') {
    const rows = (await scopedTradeIns(ctx)).filter((t) => t.inspection_id && (!f.vendorId || t.vendor_id === f.vendorId) && (!f.grade || t.grade_code === f.grade) && inDateRange(t.created_at, f.from, f.to));
    const groups = [];
    for (const [tech, list] of groupBy(rows, (t) => t.technician || '(unknown)')) {
      const scored = list.filter((t) => t.condition_score !== null);
      const withVar = list.filter((t) => t.price_variance_pct !== null);
      const mix: Record<string, number> = {};
      for (const t of list) mix[t.grade_code || '(none)'] = (mix[t.grade_code || '(none)'] ?? 0) + 1;
      groups.push({
        key: tech, label: tech, count: list.length,
        averageScore: scored.length ? Math.round(scored.reduce((a, t) => a + Number(t.condition_score), 0) / scored.length) : null,
        averageVariancePct: withVar.length ? Math.round((withVar.reduce((a, t) => a + Number(t.price_variance_pct), 0) / withVar.length) * 100) / 100 : null,
        overrides: list.filter((t) => t.grade_override_to).length,
        gradeMix: Object.entries(mix).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ key: k, count: v })),
        customerValue: n(sumC(list, 'final_customer_value')),
      });
    }
    groups.sort((a, b) => b.count - a.count);
    report = { ok: true, reportType: 'INSPECTION', filters: period,
      columns: ['Technician', 'Inspections', 'Average score', 'Average variance %', 'Grade overrides', 'Customer value'],
      rows: groups.map((g) => [g.label, g.count, g.averageScore, g.averageVariancePct, g.overrides, g.customerValue]),
      groups, totals: { count: rows.length, customerValue: n(sumC(rows, 'final_customer_value')) }, currency: CURRENCY };
  } else {
    const rows = applyFilters(await scopedTradeIns(ctx), f);
    const gb = trim(f.groupBy) || 'status';
    const L = new Lookups(ctx.db);
    const label = async (k: string) => gb === 'vendor' ? (await L.vendor(k))?.name ?? k : gb === 'branch' ? (await L.branch(k))?.name ?? '(unassigned)'
      : gb === 'grade' ? `${await L.gradeName(k)} (${k})` : gb === 'status' ? statusLabel(k) : k;
    const groups = [];
    for (const [k, list] of groupBy(rows, reportKey(gb))) {
      const withEst = list.filter((t) => c(t.estimated_value) > 0 && c(t.final_customer_value) > 0);
      groups.push({
        key: k, label: await label(k), count: list.length, customerValue: n(sumC(list, 'final_customer_value')),
        commission: n(sumC(list, 'commission_value')), settlement: n(sumC(list, 'total_settlement')),
        estimated: n(sumC(list, 'estimated_value')), variance: n(sumC(list, 'price_variance')),
        variancePct: withEst.length ? Math.round((withEst.reduce((a, t) => a + (Number(t.price_variance_pct) || 0), 0) / withEst.length) * 100) / 100 : null,
      });
    }
    groups.sort((a, b) => b.settlement - a.settlement);
    const included = [];
    if (truthy(f.includeRows)) for (const t of rows.slice(0, 500)) included.push(ctx.p.isPlatform ? await adminTradeInView(L, t) : await vendorTradeInView(L, t));
    report = {
      ok: true, reportType: 'TRADEIN', filters: { ...period, groupBy: gb },
      columns: ['Group', 'Devices', 'Estimated', 'Customer value', 'Variance', 'Commission', 'Total'],
      totals: { count: rows.length, customerValue: n(sumC(rows, 'final_customer_value')), commission: n(sumC(rows, 'commission_value')),
        settlement: n(sumC(rows, 'total_settlement')), estimated: n(sumC(rows, 'estimated_value')), variance: n(sumC(rows, 'price_variance')) },
      groups, currency: CURRENCY, rows: included,
    };
  }
  if (truthy(f.asCsv)) report.csv = reportToCsv(report);
  return report;
}

/** reportToCsv_: every text cell formula-neutralised, CRLF records. */
export function reportToCsv(report: Record<string, unknown>): string {
  const rows = report.rows as unknown[][] | undefined;
  const cols = report.columns as string[] | undefined;
  if (rows && rows.length && cols && Array.isArray(rows[0])) return toCsv(cols, rows);
  const groups = (report.groups ?? []) as Record<string, unknown>[];
  const t = (report.totals ?? {}) as Record<string, unknown>;
  return toCsv(['Group', 'Devices', 'Estimated', 'Customer value', 'Variance', 'Commission', 'Total'], [
    ...groups.map((g) => [g.label, g.count, g.estimated, g.customerValue, g.variance, g.commission, g.settlement]),
    ['TOTAL', t.count, t.estimated, t.customerValue, t.variance, t.commission, t.settlement],
  ]);
}

export { ROLE_LABELS };
