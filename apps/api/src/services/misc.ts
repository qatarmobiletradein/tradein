/**
 * Search (27_Search.gs), the audit query (20_Audit.gs), the admin
 * trade-in detail (22_Api.gs apiAdminTradeIn_) and the public partner
 * list (apiPublicVendorContext_).
 */
import { CURRENCY, PHOTO_CATEGORIES, ROLE_LABELS } from '../../../../packages/domain/src/constants.js';
import { assessmentComparison, customerAnswerSummary } from '../../../../packages/domain/src/questionnaire.js';
import { canSeeFullImei, isBranchScoped, isPlatformAdmin, loadTradeInScoped, requirePlatform, settlementVisibleTo } from '../../../../packages/auth/src/authz.js';
import { formatMoney, toCentsOrNull } from '../../../../packages/shared/src/money.js';
import { digitsOnly, formatPhone, maskImei, phoneKey, trim, truthy } from '../../../../packages/shared/src/text.js';
import { fmtDateTime, inDateRange } from '../../../../packages/shared/src/time.js';
import type { Queryable } from '../../../../packages/database/src/db.js';
import type { Ctx } from '../context.js';
import { loadGradeLadder, loadInspectionRules } from '../lib/rules.js';
import { clampLimit } from './sql.js';
import { fail } from '../../../../packages/shared/src/errors.js';
import { Lookups, adminTradeInView, publicBranchView, publicVendorView, type TradeInRow } from './views.js';
import { tradeInTimeline } from './tradeins.js';

const SEARCH_LIMIT = 8;
const money = (v: string | null) => `${formatMoney(toCentsOrNull(v) ?? 0)} ${CURRENCY}`;

/** globalSearch_: every group restricted exactly as its own screen restricts it. */
export async function globalSearch(ctx: Ctx, p: { query?: string }) {
  const q = trim(p.query).toLowerCase();
  if (q.length < 3) return { ok: true, query: trim(p.query), groups: [], total: 0, message: 'Type at least three characters.' };
  const digits = digitsOnly(q);
  const groups: { label: string; kind: string; results: unknown[]; more: number }[] = [];
  let total = 0;
  const add = (label: string, kind: string, rows: unknown[]) => {
    if (!rows.length) return;
    total += rows.length;
    groups.push({ label, kind, results: rows.slice(0, SEARCH_LIMIT), more: Math.max(0, rows.length - SEARCH_LIMIT) });
  };
  const L = new Lookups(ctx.db);
  const scope = (alias = '') => {
    if (ctx.p.isPlatform) return { sql: 'true', params: [] as unknown[] };
    return ctx.p.branchId
      ? { sql: `${alias}vendor_id = $1 and ${alias}branch_id = $2`, params: [ctx.p.vendorId, ctx.p.branchId] }
      : { sql: `${alias}vendor_id = $1`, params: [ctx.p.vendorId] };
  };
  const full = canSeeFullImei(ctx.p);
  const technician = ctx.p.isPlatform && !isPlatformAdmin(ctx.p);

  const s = scope();
  const trades = (await ctx.db.query<TradeInRow>(`select * from public.trade_ins where ${s.sql} order by created_at desc limit 20000`, s.params)).rows.filter((t) => {
    if (t.id.toLowerCase().includes(q) || (t.customer_name ?? '').toLowerCase().includes(q) || (t.model_snapshot ?? '').toLowerCase().includes(q)) return true;
    if (digits.length >= 4) {
      // Only somebody allowed to see an IMEI may search by one (technicians may not).
      if ((full || !ctx.p.isPlatform) && digitsOnly(t.imei).includes(digits)) return true;
      if (phoneKey(t.customer_phone).includes(digits.slice(-8))) return true;
    }
    return false;
  });
  add('Trade-ins', 'TRADEIN', trades.map((t) => ({
    id: t.id, title: t.id, subtitle: [t.brand_snapshot, t.model_snapshot, t.storage_snapshot].filter(Boolean).join(' '),
    detail: t.customer_name ?? '', status: t.status, extra: full ? (t.imei ?? '') : (ctx.p.isPlatform ? '' : maskImei(t.imei)),
  })));

  if (!technician) {
    const v = (await ctx.db.query<{ id: string; voucher_number: string; trade_in_id: string; customer_value: string; status: string }>(
      `select id, voucher_number, trade_in_id, customer_value, status from public.vouchers where ${s.sql}
         and (lower(voucher_number) like $${s.params.length + 1} or lower(id) like $${s.params.length + 1} or lower(trade_in_id) like $${s.params.length + 1})`,
      [...s.params, `%${q}%`])).rows;
    add('Vouchers', 'VOUCHER', v.map((x) => ({ id: x.id, title: x.voucher_number, subtitle: money(x.customer_value), detail: x.trade_in_id, status: x.status })));
  }

  const b = (await ctx.db.query<{ id: string; branch_id: string | null; expected_device_count: number; device_count: number; status: string }>(
    `select id, branch_id, expected_device_count, device_count, status from public.collections where ${s.sql} and lower(id) like $${s.params.length + 1}`,
    [...s.params, `%${q}%`])).rows;
  const notes = [];
  for (const x of b) notes.push({ id: x.id, title: x.id, subtitle: `${x.expected_device_count || x.device_count || 0} device(s)`, detail: (await L.branch(x.branch_id))?.name ?? '', status: x.status });
  add('Collection notes', 'COLLECTION', notes);

  const st = (await ctx.db.query<{ id: string; vendor_id: string; settlement_total: string; status: string }>(
    `select id, vendor_id, settlement_total, status from public.settlements where lower(id) like $1 or lower(coalesce(payment_reference,'')) like $1`, [`%${q}%`])).rows;
  const visible = [];
  for (const x of st) if (await settlementVisibleTo(ctx, x)) visible.push({ id: x.id, title: x.id, subtitle: money(x.settlement_total), detail: (await L.vendor(x.vendor_id))?.name ?? '', status: x.status });
  add('Settlements', 'SETTLEMENT', visible);

  if (isPlatformAdmin(ctx.p)) {
    const cs = (await ctx.db.query<{ id: string; full_name: string; phone: string; status: string }>('select id, full_name, phone, status from public.customers')).rows
      .filter((c) => c.full_name.toLowerCase().includes(q) || (digits.length >= 4 && phoneKey(c.phone).includes(digits.slice(-8))) || c.id.toLowerCase().includes(q));
    add('Customers', 'CUSTOMER', cs.map((c) => ({ id: c.id, title: c.full_name, subtitle: formatPhone(c.phone), detail: c.id, status: c.status })));
    const vs = (await ctx.db.query<{ id: string; name: string; code: string; status: string }>('select id, name, code, status from public.vendors where lower(name) like $1 or lower(code) like $1', [`%${q}%`])).rows;
    add('Vendors', 'VENDOR', vs.map((v) => ({ id: v.id, title: v.name, subtitle: v.code, detail: v.id, status: v.status })));
  }

  const br = (await ctx.db.query<{ id: string; vendor_id: string; name: string; address: string | null; active: boolean; code: string | null }>(
    'select id, vendor_id, name, address, active, code from public.branches')).rows.filter((x) => {
    if (!ctx.p.isPlatform && x.vendor_id !== ctx.p.vendorId) return false;
    if (isBranchScoped(ctx.p) && x.id !== ctx.p.branchId) return false;
    return x.name.toLowerCase().includes(q) || (x.code ?? '').toLowerCase().includes(q) || x.id.toLowerCase().includes(q);
  });
  const branches = [];
  for (const x of br) branches.push({ id: x.id, title: x.name, subtitle: (await L.vendor(x.vendor_id))?.name ?? '', detail: x.address ?? '', status: x.active ? 'ACTIVE' : 'INACTIVE' });
  add('Branches', 'BRANCH', branches);

  const pr = (await ctx.db.query<{ id: string; model: string; model_code: string | null; active: boolean; brand: string }>(
    `select p.id, p.model, p.model_code, p.active, b.name as brand from public.products p join public.brands b on b.id = p.brand_id
      where lower(p.model) like $1 or lower(coalesce(p.model_code,'')) like $1`, [`%${q}%`])).rows;
  add('Models', 'PRODUCT', pr.map((x) => ({ id: x.id, title: x.model, subtitle: x.brand, detail: x.model_code ?? '', status: x.active ? 'ACTIVE' : 'INACTIVE' })));

  return { ok: true, query: trim(p.query), total, groups, message: total ? '' : 'Nothing matched that.' };
}

/** queryAudit_: newest first; action is a contains-match; whole-day date range. */
export async function queryAudit(ctx: Ctx, f: { vendorId?: string; action?: string; actorId?: string; role?: string; objectId?: string; from?: string; to?: string; limit?: number }) {
  requirePlatform(ctx);
  const params: unknown[] = [];
  const where: string[] = [];
  const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replaceAll('?', `$${params.length}`)); };
  if (!ctx.p.isPlatform) add('vendor_id = ?', ctx.p.vendorId);
  else if (f.vendorId) add('vendor_id = ?', f.vendorId);
  if (f.action) add('upper(action) like ?', `%${f.action.toUpperCase().replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
  if (f.actorId) add('actor_id = ?', f.actorId);
  if (f.role) add('actor_role = ?', f.role);
  if (f.objectId) add('upper(object_id) like ?', `%${f.objectId.toUpperCase().replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
  const rows = (await ctx.db.query<{ id: number; legacy_log_id: string | null; occurred_at: Date; actor_name: string | null; actor_id: string | null; actor_role: string | null; vendor_id: string | null; action: string; object_type: string | null; object_id: string | null; old_value: unknown; new_value: unknown; details: unknown }>(
    `select * from public.audit_logs ${where.length ? `where ${where.join(' and ')}` : ''} order by occurred_at desc, id desc limit 50000`, params)).rows
    .filter((r) => inDateRange(r.occurred_at, f.from, f.to));
  const limit = clampLimit(f.limit, 200, 1000);
  const s = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v));
  return {
    ok: true, total: rows.length, shown: Math.min(rows.length, limit),
    entries: rows.slice(0, limit).map((r) => ({
      logId: r.legacy_log_id ?? String(r.id), timestamp: fmtDateTime(r.occurred_at), actor: r.actor_name || r.actor_id || 'system',
      role: ROLE_LABELS[r.actor_role as keyof typeof ROLE_LABELS] ?? r.actor_role ?? '', vendorId: r.vendor_id ?? '', action: r.action,
      objectType: r.object_type ?? '', objectId: r.object_id ?? '', oldValue: s(r.old_value), newValue: s(r.new_value), details: s(r.details),
    })),
  };
}

async function auditTrailFor(db: Queryable, objectId: string) {
  const s = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v));
  return (await db.query<{ occurred_at: Date; actor_name: string | null; actor_role: string | null; action: string; old_value: unknown; new_value: unknown; details: unknown }>(
    'select occurred_at, actor_name, actor_role, action, old_value, new_value, details from public.audit_logs where object_id = $1 order by occurred_at, id', [objectId])).rows
    .map((r) => ({ timestamp: fmtDateTime(r.occurred_at), actor: r.actor_name || 'system', role: ROLE_LABELS[r.actor_role as keyof typeof ROLE_LABELS] ?? r.actor_role ?? '',
      action: r.action, oldValue: s(r.old_value), newValue: s(r.new_value), details: s(r.details) }));
}

/** apiAdminTradeIn_: the full record, history, timeline, inspection and the customer-vs-technician comparison. */
export async function adminTradeIn(ctx: Ctx, p: { tradeInId: string }) {
  requirePlatform(ctx);
  const t = await loadTradeInScoped<TradeInRow>(ctx, p.tradeInId);
  const L = new Lookups(ctx.db);
  const view: Record<string, unknown> = await adminTradeInView(L, t);
  view.history = await auditTrailFor(ctx.db, t.id);
  view.timeline = await tradeInTimeline(ctx, t.id);
  view.customerSaid = customerAnswerSummary(t.condition_answers);
  const rules = await loadInspectionRules(ctx.db);
  let answers: Record<string, unknown> = {};
  if (t.inspection_id) {
    const i = (await ctx.db.query<{ technician: string | null; condition_score: string | null; grade_code: string | null; battery_health: number | null; imei_match: boolean; activation_lock: boolean; blocked_reason: string | null; technician_notes: string | null; started_at: Date | null; completed_at: Date | null; answers: Record<string, unknown> }>(
      'select * from public.inspections where id = $1', [t.inspection_id])).rows[0];
    if (i) {
      answers = i.answers ?? {};
      const photos = (await ctx.db.query<{ id: string; category: string; label: string | null; uploaded_by: string | null; uploaded_at: Date }>(
        'select id, category, label, uploaded_by, uploaded_at from public.inspection_photos where inspection_id = $1 order by uploaded_at', [t.inspection_id])).rows;
      view.inspection = {
        technician: i.technician ?? '', score: Number(i.condition_score) || 0, grade: i.grade_code ?? '', batteryHealth: i.battery_health,
        imeiConfirmed: i.imei_match, activationLock: i.activation_lock, blockedReason: i.blocked_reason ?? '', notes: i.technician_notes ?? '',
        photoIds: photos.map((x) => x.id),
        photos: photos.map((x) => ({ fileId: x.id, category: x.category, label: x.label ?? '', uploadedBy: x.uploaded_by ?? '', uploadedAt: fmtDateTime(x.uploaded_at) })),
        startedAt: fmtDateTime(i.started_at), completedAt: fmtDateTime(i.completed_at), answers,
        faults: rules.filter((r) => r.input !== 'PERCENTAGE' && answers[r.code] !== undefined).map((r) => {
          const good = truthy(answers[r.code]);
          return { code: r.code, group: r.group, question: r.question, answer: good ? r.good : r.bad, fault: !good };
        }),
      };
    }
  }
  view.comparison = assessmentComparison(t.condition_answers, answers, rules);
  view.photoCategories = PHOTO_CATEGORIES;
  view.grades = (await loadGradeLadder(ctx.db)).map((g) => ({ code: g.code, name: g.name }));
  return { ok: true, tradeIn: view };
}

/** apiPublicVendorContext_: partners with at least one active branch; never fee terms. */
/**
 * public.vendorBranches: the customer chooses the partner FIRST, then a branch of that partner.
 * The branch list is filtered here on the server (only that partner's active branches); the
 * trade-in itself is still checked again on creation (assertBranchBelongsTo + the database link).
 */
export async function publicVendorBranches(db: Queryable, p: { vendorId?: unknown }) {
  const vendorId = typeof p.vendorId === 'string' ? p.vendorId.trim() : '';
  if (!/^VND-\d{3,}$/.test(vendorId)) throw fail('Choose a shop.');
  const v = (await db.query<{ id: string; name: string; code: string; logo_url: string | null }>(
    `select id, name, code, logo_url from public.vendors where id = $1 and status = 'ACTIVE'`, [vendorId])).rows[0];
  if (!v) throw fail('That shop is not accepting trade-ins right now.');
  const branches = (await db.query<{ id: string; vendor_id: string; name: string; address: string | null; location: string | null; contact_phone: string | null }>(
    'select id, vendor_id, name, address, location, contact_phone from public.branches where vendor_id = $1 and active order by display_order, name', [vendorId])).rows;
  return { ok: true, vendor: publicVendorView(v), branches: branches.map(publicBranchView) };
}

export async function publicVendorContext(db: Queryable) {
  const vendors = (await db.query<{ id: string; name: string; code: string; logo_url: string | null }>(
    `select id, name, code, logo_url from public.vendors where status = 'ACTIVE' order by name`)).rows;
  const branches = (await db.query<{ id: string; vendor_id: string; name: string; address: string | null; location: string | null; contact_phone: string | null }>(
    'select id, vendor_id, name, address, location, contact_phone from public.branches where active order by display_order, name')).rows;
  return {
    ok: true, platform: 'Qatar Mobile', currency: CURRENCY,
    vendors: vendors.map((v) => ({ ...publicVendorView(v), branches: branches.filter((b) => b.vendor_id === v.id).map(publicBranchView) }))
      .filter((v) => v.branches.length > 0),
  };
}
