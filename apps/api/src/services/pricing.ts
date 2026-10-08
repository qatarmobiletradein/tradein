/**
 * Price administration (10_Pricing.gs), the grade ladder (11_GradeRules.gs)
 * and partner-fee rules (12_CommissionRules.gs).
 *
 * "Change" means SUPERSEDE, never overwrite: the row in force gets an end
 * date and a pointer to its replacement and stays active (it was a real
 * price until then). Only CANCEL sets active=false, for rows entered in
 * error. Existing trade-ins and vouchers keep their own snapshots.
 */
import { ACTIONS, BATTERY_BANDS, COMMISSION_TYPE, CURRENCY } from '../../../../packages/domain/src/constants.js';
import { gradeLadderFor, validateGradeLadder, validateLadderShape, type GradeRule } from '../../../../packages/domain/src/grading.js';
import { pickEffective } from '../../../../packages/domain/src/pricing.js';
import { fail } from '../../../../packages/shared/src/errors.js';
import {
  centsToDecimal, centsToNumber, formatMoney, fraction4ToDecimal, microToDecimal, toCents, toCentsOrNull, toFraction4, toMicro,
} from '../../../../packages/shared/src/money.js';
import { isBlank, trim, truthy } from '../../../../packages/shared/src/text.js';
import { fmtDate } from '../../../../packages/shared/src/time.js';
import type { Ctx } from '../context.js';
import { audit } from '../lib/audit.js';
import { nextId } from '../lib/ids.js';
import { loadGradeLadder } from '../lib/rules.js';
import { updateById } from './sql.js';

const now = (): Date => new Date();
const parseWhen = (v: unknown): Date | null => {
  if (v === undefined || v === null || v === '') return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};
const ladderView = (base: number, ladder: GradeRule[]) =>
  gradeLadderFor(base, ladder).map((g) => ({ code: g.code, name: g.name, percentage: g.percentageBp / 10000, percentLabel: g.percentLabel,
    value: centsToNumber(g.value), minScore: g.minScore, terminal: g.terminal }));

interface PriceDbRow { id: string; base_price: string; effective_from: Date; effective_to: Date | null; active: boolean; superseded_by: string | null; created_by: string | null; notes: string | null }

/** setBasePrice_: master price, or a partner's own price when vendorId is given. */
export async function setBasePrice(ctx: Ctx, d: { variantId?: string; basePrice?: unknown; effectiveFrom?: unknown; vendorId?: string; notes?: string }) {
  const variantId = trim(d.variantId);
  const v = (await ctx.db.query<{ product_id: string }>('select product_id from public.product_variants where id = $1', [variantId])).rows[0];
  if (!v) throw fail('That storage variant does not exist.');
  let priceCents: number;
  try { priceCents = toCents(d.basePrice); } catch { throw fail('Enter a base price of zero or more.'); }
  if (priceCents < 0) throw fail('Enter a base price of zero or more.');
  const from = parseWhen(d.effectiveFrom) ?? now();
  const vendorId = trim(d.vendorId);
  const table = vendorId ? 'vendor_prices' : 'master_prices';
  if (vendorId && !(await ctx.db.query('select 1 from public.vendors where id = $1', [vendorId])).rowCount) throw fail('That vendor does not exist.');

  // Serialise price changes for this variant (and partner).
  await ctx.db.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`qm.price:${table}:${vendorId}:${variantId}`]);
  const rows = (await ctx.db.query<PriceDbRow>(
    `select id, base_price, effective_from, effective_to, active, superseded_by, created_by, notes from public.${table}
      where variant_id = $1 and active ${vendorId ? 'and vendor_id = $2' : ''}`, vendorId ? [variantId, vendorId] : [variantId])).rows;
  const current = pickEffective(rows.map((r) => ({ ...r, effectiveFrom: r.effective_from, effectiveTo: r.effective_to })), from);
  if (current && toCents(current.base_price) === priceCents) {
    return { ok: true, message: 'That is already the price. Nothing changed.', unchanged: true };
  }
  const newId = await nextId(ctx.db, vendorId ? 'VPR' : 'MPR');
  if (vendorId) {
    await ctx.db.query(`insert into public.vendor_prices (id, vendor_id, product_id, variant_id, base_price, currency, effective_from, active, created_by, updated_by, notes)
      values ($1,$2,$3,$4,$5,'QAR',$6,true,$7,$7,$8)`, [newId, vendorId, v.product_id, variantId, centsToDecimal(priceCents), from, ctx.p.principalId, trim(d.notes) || null]);
  } else {
    await ctx.db.query(`insert into public.master_prices (id, product_id, variant_id, base_price, currency, effective_from, active, created_by, updated_by, notes)
      values ($1,$2,$3,$4,'QAR',$5,true,$6,$6,$7)`, [newId, v.product_id, variantId, centsToDecimal(priceCents), from, ctx.p.principalId, trim(d.notes) || null]);
  }
  if (current) await updateById(ctx.db, table, current.id, { effective_to: from, superseded_by: newId, updated_by: ctx.p.principalId });
  const ladder = await loadGradeLadder(ctx.db);
  await audit(ctx, vendorId ? ACTIONS.VENDOR_PRICE_SET : ACTIONS.BASE_PRICE_SET, 'VARIANT', variantId, {
    oldValue: current ? centsToNumber(toCents(current.base_price)) : null, newValue: centsToNumber(priceCents),
    details: { vendorId: vendorId || '(master)', effectiveFrom: fmtDate(from), supersededPriceId: current?.id ?? '', newPriceId: newId,
      ladder: gradeLadderFor(priceCents, ladder).map((g) => `${g.code}=${centsToNumber(g.value)}`).join(' ') },
  });
  return { ok: true, message: `Base price set to ${formatMoney(priceCents)} ${CURRENCY}.`, ladder: ladderView(priceCents, ladder) };
}

/** admin.retirePrice: mode=CANCEL cancels (active=false, reason required), else retire (end date now). */
export async function retireOrCancelPrice(ctx: Ctx, p: { priceId?: string; vendorId?: string; mode?: string; reason?: string }) {
  const table = trim(p.vendorId) ? 'vendor_prices' : 'master_prices';
  const row = (await ctx.db.query<PriceDbRow>(`select * from public.${table} where id = $1 for update`, [trim(p.priceId)])).rows[0];
  if (!row) throw fail('Price row not found.');
  if (trim(p.mode).toUpperCase() === 'CANCEL') {
    if (isBlank(p.reason)) throw fail('Say why this price is being cancelled.');
    await updateById(ctx.db, table, row.id, { active: false, updated_by: ctx.p.principalId, notes: `${row.notes ?? ''} | CANCELLED: ${trim(p.reason)}` });
    await audit(ctx, ACTIONS.PRICE_CANCELLED, 'PRICE', row.id, { oldValue: centsToNumber(toCents(row.base_price)),
      details: { reason: trim(p.reason), note: 'Row excluded from all lookups, including historical ones.' } });
    return { ok: true, message: 'Price cancelled.' };
  }
  if (row.effective_to) throw fail('That price has already been closed.');
  await updateById(ctx.db, table, row.id, { effective_to: now(), updated_by: ctx.p.principalId });
  await audit(ctx, ACTIONS.PRICE_RETIRED, 'PRICE', row.id, { oldValue: centsToNumber(toCents(row.base_price)), details: { note: 'Closed with an end date. History is preserved.' } });
  return { ok: true, message: 'Price retired.' };
}

/** pricingTable_: one row per variant with master, partner override, resolved price and ladder; unpriced first. */
export async function pricingTable(ctx: Ctx, f: { vendorId?: string; brandId?: string; categoryId?: string; productId?: string; search?: string; activeOnly?: unknown; status?: string }) {
  const at = now();
  const vendorId = trim(f.vendorId) || null;
  const rows = (await ctx.db.query<{ variant_id: string; product_id: string; brand: string; category: string | null; model: string; storage: string; active: boolean; brand_id: string; category_id: string | null }>(
    `select v.id as variant_id, p.id as product_id, b.name as brand, c.name as category, p.model, v.storage, v.active, p.brand_id, p.category_id
       from public.product_variants v join public.products p on p.id = v.product_id join public.brands b on b.id = p.brand_id
       left join public.categories c on c.id = p.category_id`)).rows
    .filter((r) => (!truthy(f.activeOnly) || r.active) && (!f.brandId || r.brand_id === f.brandId) && (!f.categoryId || r.category_id === f.categoryId)
      && (!f.productId || r.product_id === f.productId) && (!f.search || `${r.model} ${r.storage}`.toLowerCase().includes(f.search.toLowerCase())));
  const master = (await ctx.db.query<PriceDbRow & { variant_id: string }>('select * from public.master_prices where active')).rows;
  const vend = vendorId ? (await ctx.db.query<PriceDbRow & { variant_id: string }>('select * from public.vendor_prices where active and vendor_id = $1', [vendorId])).rows : [];
  const ladder = await loadGradeLadder(ctx.db);
  const eff = <T extends PriceDbRow>(list: T[]) => pickEffective(list.map((r) => ({ ...r, effectiveFrom: r.effective_from, effectiveTo: r.effective_to })), at);
  let out = rows.map((r) => {
    const m = eff(master.filter((x) => x.variant_id === r.variant_id));
    const o = eff(vend.filter((x) => x.variant_id === r.variant_id));
    const resolved = o ? toCents(o.base_price) : m ? toCents(m.base_price) : null;
    return {
      variantId: r.variant_id, productId: r.product_id, brand: r.brand, category: r.category ?? '', model: r.model, storage: r.storage,
      masterPrice: m ? centsToNumber(toCents(m.base_price)) : null, vendorPrice: o ? centsToNumber(toCents(o.base_price)) : null,
      resolvedPrice: resolved === null ? null : centsToNumber(resolved), source: o ? 'VENDOR_OVERRIDE' : m ? 'MASTER' : 'NONE',
      effectiveFrom: fmtDate((o ?? m)?.effective_from ?? null), grades: resolved === null ? [] : ladderView(resolved, ladder), active: r.active,
    };
  });
  out.sort((a, b) => ((a.resolvedPrice === null) !== (b.resolvedPrice === null) ? (a.resolvedPrice === null ? -1 : 1)
    : (a.brand + a.model + a.storage).localeCompare(b.brand + b.model + b.storage)));
  if (f.status === 'UNPRICED') out = out.filter((r) => r.resolvedPrice === null);
  else if (f.status === 'PRICED') out = out.filter((r) => r.resolvedPrice !== null);
  return {
    ok: true, rows: out, unpriced: out.filter((r) => r.resolvedPrice === null).length, currency: CURRENCY,
    grades: ladder.map((g) => ({ code: g.code, name: g.name, percentLabel: `${(g.percentageBp / 100).toFixed(0)}%` })),
  };
}

export async function priceHistory(ctx: Ctx, p: { variantId?: string; vendorId?: string }) {
  const vendorId = trim(p.vendorId);
  const rows = (await ctx.db.query<PriceDbRow>(
    `select * from public.${vendorId ? 'vendor_prices' : 'master_prices'} where variant_id = $1 ${vendorId ? 'and vendor_id = $2' : ''} order by effective_from desc`,
    vendorId ? [trim(p.variantId), vendorId] : [trim(p.variantId)])).rows;
  return {
    ok: true, currency: CURRENCY,
    history: rows.map((r) => ({ priceId: r.id, basePrice: centsToNumber(toCents(r.base_price)), effectiveFrom: fmtDate(r.effective_from),
      effectiveTo: fmtDate(r.effective_to) || 'current', supersededBy: r.superseded_by ?? '', cancelled: !r.active, setBy: r.created_by ?? '', notes: r.notes ?? '' })),
  };
}

export async function countUnpricedVariants(ctx: Ctx): Promise<number> {
  const r = await ctx.db.query<{ n: number }>(
    `select count(*)::int as n from public.product_variants v where v.active and not exists (
       select 1 from public.master_prices m where m.variant_id = v.id and m.active and m.effective_from <= now()
          and (m.effective_to is null or m.effective_to > now()))`);
  return r.rows[0]!.n;
}

/* ------------------------------------------------------------ grade ladder */

export async function gradeRules(ctx: Ctx) {
  const ladder = await loadGradeLadder(ctx.db);
  const check = validateGradeLadder(ladder);
  return {
    ok: true,
    grades: ladder.map((g) => ({ gradeRuleId: g.gradeRuleId, code: g.code, name: g.name, percentage: g.percentageBp / 10000,
      percentLabel: `${(g.percentageBp / 100).toFixed(0)}%`, minScore: g.minScore, order: g.order, terminal: g.terminal })),
    example: ladderView(200000, ladder), valid: check.ok, problems: check.problems, currency: CURRENCY,
  };
}

/** saveGradeRule_: the change is applied to a COPY of the ladder and validated before anything is written. */
export async function saveGradeRule(ctx: Ctx, d: { gradeCode?: string; gradeName?: string; percentage?: unknown; minScore?: unknown; order?: unknown; terminal?: unknown; active?: unknown }) {
  const code = trim(d.gradeCode).toUpperCase();
  if (!/^[A-Z][A-Z0-9]{0,3}$/.test(code)) throw fail('A grade code is one to four letters or digits, such as A or B2.');
  let pctBp: number;
  try { pctBp = toFraction4(d.percentage); } catch { throw fail('A percentage is between 0 and 1. Seventy percent is 0.7.'); }
  if (pctBp < 0 || pctBp > 10000) throw fail('A percentage is between 0 and 1. Seventy percent is 0.7.');
  const minScore = Number(d.minScore);
  if (!Number.isFinite(minScore) || minScore < 0 || minScore > 100) throw fail('A minimum score is between 0 and 100.');
  await ctx.db.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', ['qm.grade_ladder']);
  const existing = (await ctx.db.query<{ id: string; percentage_of_base: string; active: boolean }>('select id, percentage_of_base, active from public.grade_rules where grade_code = $1', [code])).rows[0];
  const isActive = d.active === undefined ? true : truthy(d.active);
  const terminal = truthy(d.terminal);
  const order = Number(d.order) || 99;
  const name = trim(d.gradeName) || code;
  const current = await loadGradeLadder(ctx.db).catch(() => [] as GradeRule[]);
  const proposed = current.filter((r) => r.code !== code).concat(isActive ? [{ gradeRuleId: existing?.id ?? '', code, name, percentageBp: pctBp, minScore, order, terminal }] : []);
  const check = validateLadderShape(proposed);
  if (!check.ok) throw fail(`That change would break the grade ladder: ${check.problems[0]}`);
  if (terminal && pctBp !== 0) throw fail('That change would break the grade ladder: a terminal grade must be 0%.');
  const row = { grade_code: code, grade_name: name, percentage_of_base: fraction4ToDecimal(pctBp), min_score: minScore, display_order: order, is_terminal: terminal, active: isActive };
  if (existing) await updateById(ctx.db, 'grade_rules', existing.id, row);
  else {
    const id = await nextId(ctx.db, 'GRD');
    await ctx.db.query(`insert into public.grade_rules (id, grade_code, grade_name, percentage_of_base, min_score, display_order, is_terminal, active)
      values ($1,$2,$3,$4,$5,$6,$7,$8)`, [id, code, name, row.percentage_of_base, minScore, order, terminal, isActive]);
  }
  await audit(ctx, ACTIONS.GRADE_RULE_CHANGED, 'GRADE_RULE', code, {
    oldValue: existing ? { percentage: Number(existing.percentage_of_base), active: existing.active } : null,
    newValue: { percentage: pctBp / 10000, minScore, active: isActive },
    details: { note: 'Applies to future offers only. Existing trade-ins keep their snapshot.' },
  });
  return { ok: true, message: `Grade ${code} saved.` };
}

export async function inspectionRulesAdmin(ctx: Ctx, list: () => Promise<{ rules: unknown[] }>) {
  const r = await list();
  return { ok: true, rules: r.rules, batteryBands: BATTERY_BANDS,
    note: 'The technician never sees these numbers. Showing them would let somebody work backwards from the grade they want.' };
}

/* --------------------------------------------------------- partner fees */

interface RuleRow { id: string; vendor_id: string; brand_id: string | null; category_id: string | null; product_id: string | null; commission_type: string; commission_value: string; effective_from: Date; effective_to: Date | null; active: boolean; superseded_by: string | null; notes: string | null }

/** saveCommissionRule_: supersede the rule in force for exactly this scope. */
export async function saveCommissionRule(ctx: Ctx, d: { vendorId?: string; brandId?: string; categoryId?: string; productId?: string; commissionType?: string; commissionValue?: unknown; effectiveFrom?: unknown; effectiveTo?: unknown; notes?: string }) {
  const vendorId = trim(d.vendorId);
  if (!vendorId) throw fail('Choose a vendor.');
  if (!(await ctx.db.query('select 1 from public.vendors where id = $1', [vendorId])).rowCount) throw fail('That vendor does not exist.');
  const type = trim(d.commissionType).toUpperCase() || COMMISSION_TYPE.PERCENTAGE;
  if (type !== 'PERCENTAGE' && type !== 'FIXED') throw fail('Commission is either a percentage or a fixed amount.');
  let value: bigint;
  try { value = toMicro(d.commissionValue); } catch { throw fail('Enter a commission of zero or more.'); }
  if (value < 0n) throw fail('Enter a commission of zero or more.');
  if (type === 'PERCENTAGE' && value > 1_000_000n) throw fail('Enter a percentage as a fraction. Five percent is 0.05.');
  const from = parseWhen(d.effectiveFrom) ?? now();
  const brandId = trim(d.brandId) || null; const categoryId = trim(d.categoryId) || null; const productId = trim(d.productId) || null;
  await ctx.db.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`qm.commission:${vendorId}:${brandId}:${categoryId}:${productId}`]);
  const rows = (await ctx.db.query<RuleRow>(
    `select * from public.commission_rules where active and vendor_id = $1 and brand_id is not distinct from $2
       and category_id is not distinct from $3 and product_id is not distinct from $4`, [vendorId, brandId, categoryId, productId])).rows;
  const current = pickEffective(rows.map((r) => ({ ...r, effectiveFrom: r.effective_from, effectiveTo: r.effective_to })), from);
  if (current && current.commission_type === type && toMicro(current.commission_value) === value) {
    return { ok: true, message: 'That is already the rate. Nothing changed.', unchanged: true };
  }
  const id = await nextId(ctx.db, 'CMR');
  await ctx.db.query(`insert into public.commission_rules (id, vendor_id, brand_id, category_id, product_id, commission_type, commission_value, effective_from, effective_to, active, created_by, notes)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10,$11)`,
    [id, vendorId, brandId, categoryId, productId, type, microToDecimal(value), from, parseWhen(d.effectiveTo), ctx.p.principalId, trim(d.notes) || null]);
  if (current) await updateById(ctx.db, 'commission_rules', current.id, { effective_to: from, superseded_by: id });
  await audit(ctx, ACTIONS.COMMISSION_RULE_SET, 'COMMISSION_RULE', id, {
    oldValue: current ? Number(current.commission_value) : null, newValue: Number(microToDecimal(value)), vendorId,
    details: { vendorId, type, scope: productId || categoryId || brandId || 'vendor-wide', effectiveFrom: fmtDate(from), supersededRuleId: current?.id ?? '',
      note: 'Applies to future vouchers only. Issued vouchers keep their snapshot.' },
  });
  return { ok: true, message: 'Commission rule saved.', commissionRuleId: id };
}

export async function cancelCommissionRule(ctx: Ctx, p: { commissionRuleId?: string; reason?: string }) {
  const row = (await ctx.db.query<RuleRow>('select * from public.commission_rules where id = $1 for update', [trim(p.commissionRuleId)])).rows[0];
  if (!row) throw fail('That commission rule does not exist.');
  if (isBlank(p.reason)) throw fail('Say why this rule is being cancelled.');
  await updateById(ctx.db, 'commission_rules', row.id, { active: false, notes: `${row.notes ?? ''} | CANCELLED: ${trim(p.reason)}` });
  await audit(ctx, ACTIONS.COMMISSION_RULE_SET, 'COMMISSION_RULE', row.id, { oldValue: Number(row.commission_value), newValue: null, vendorId: row.vendor_id, details: { cancelled: true, reason: trim(p.reason) } });
  return { ok: true, message: 'Commission rule cancelled.' };
}

export async function listCommissionRules(ctx: Ctx, p: { vendorId?: string; includeHistory?: unknown }) {
  const rows = (await ctx.db.query<RuleRow & { vendor_name: string | null; brand_name: string | null; category_name: string | null; product_model: string | null }>(
    `select r.*, v.name as vendor_name, b.name as brand_name, c.name as category_name, p.model as product_model
       from public.commission_rules r join public.vendors v on v.id = r.vendor_id left join public.brands b on b.id = r.brand_id
       left join public.categories c on c.id = r.category_id left join public.products p on p.id = r.product_id
      where ($1::text is null or r.vendor_id = $1)`, [trim(p.vendorId) || null])).rows;
  const at = now();
  const history = truthy(p.includeHistory);
  const out = rows.filter((r) => history || (r.active && (r.effective_from <= at) && (!r.effective_to || r.effective_to > at))).map((r) => {
    const val = Number(r.commission_value) || 0;
    const scope = r.product_id ? (r.product_model ?? r.product_id) : r.category_id ? (r.category_name ?? r.category_id) : r.brand_id ? (r.brand_name ?? r.brand_id) : 'All products';
    return {
      commissionRuleId: r.id, vendorId: r.vendor_id, vendorName: r.vendor_name ?? r.vendor_id, scope, brandId: r.brand_id ?? '', categoryId: r.category_id ?? '',
      productId: r.product_id ?? '', type: r.commission_type, value: val,
      label: r.commission_type === 'FIXED' ? `${formatMoney(toCentsOrNull(r.commission_value) ?? 0)} ${CURRENCY}` : `${(val * 100).toFixed(2).replace(/\.?0+$/, '')}%`,
      effectiveFrom: fmtDate(r.effective_from), effectiveTo: fmtDate(r.effective_to) || 'current', supersededBy: r.superseded_by ?? '', cancelled: !r.active, notes: r.notes ?? '',
    };
  });
  out.sort((a, b) => a.vendorName.localeCompare(b.vendorName) || String(b.effectiveFrom).localeCompare(String(a.effectiveFrom)));
  return { ok: true, rules: out };
}

/** seedVendorCommission_: the partner-wide default rule created with a new partner. */
export async function seedVendorCommission(ctx: Ctx, vendorId: string, rate: string): Promise<string> {
  const existing = (await ctx.db.query<{ id: string }>(
    'select id from public.commission_rules where vendor_id = $1 and brand_id is null and category_id is null and product_id is null limit 1', [vendorId])).rows[0];
  if (existing) return existing.id;
  const id = await nextId(ctx.db, 'CMR');
  await ctx.db.query(`insert into public.commission_rules (id, vendor_id, commission_type, commission_value, effective_from, active, created_by, notes)
    values ($1,$2,'PERCENTAGE',$3,now(),true,$4,'Default rate for this vendor.')`, [id, vendorId, rate, ctx.p.principalId]);
  return id;
}
