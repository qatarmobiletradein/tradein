/**
 * Validation and comparison: the Google Sheets export against PostgreSQL.
 *
 * Reports
 *   - row counts per sheet/table (export, matched in DB, missing in DB);
 *   - financial totals computed EXACTLY on both sides: live vouchers,
 *     trade-in customer value / partner fees / Qatar Mobile settlement
 *     value, settlements by status, outstanding balances, collection
 *     expected/actual;
 *   - per-record money mismatches (trade-ins, vouchers, settlements);
 *   - orphans (references to ids that do not exist in the export);
 *   - duplicates (same rules as the importer);
 *   - invalid states (unknown statuses, broken invariants);
 *   - broken file references (evidence photos with no migrated file).
 * Read-only on the database.
 */
import type pg from 'pg';
import { centsToNumber, toCents } from '../../packages/shared/src/money.js';
import { STATUS, TRADEIN_FLOW } from '../../packages/domain/src/constants.js';
import { findDuplicates, loadExport, type RowError } from './importer.js';
import { SHEETS, type Raw } from './mapping.js';

const s = (v: unknown) => (v === null || v === undefined ? '' : String(v)).trim();
const c = (v: unknown): number => { try { return s(v) === '' ? 0 : toCents(v); } catch { return 0; } };
const sum = (rows: Raw[], k: string, f: (r: Raw) => boolean = () => true) => rows.filter(f).reduce((a, r) => a + c(r[k]), 0);

export interface Finding { kind: string; sheet: string; id: string; detail: string }
export interface CompareReport {
  counts: { sheet: string; table: string; exported: number; inDatabase: number; missing: number; tableTotal: number }[];
  totals: { metric: string; export: number; database: number; difference: number }[];
  mismatches: Finding[]; orphans: Finding[]; duplicates: RowError[]; invalidStates: Finding[]; brokenFiles: Finding[]; ok: boolean;
}

export async function compare(pool: pg.Pool, dir: string): Promise<CompareReport> {
  const { rows } = loadExport(dir);
  const get = (sheet: string) => rows.get(sheet) ?? [];
  const counts: CompareReport['counts'] = [];
  for (const spec of SHEETS) {
    const ids = get(spec.sheet).map((r) => s(r[spec.key])).filter(Boolean);
    const found = ids.length
      ? Number((await pool.query<{ n: number }>(`select count(*)::int as n from public.${spec.table} where ${spec.idColumn} = any($1::text[])`, [ids])).rows[0]!.n) : 0;
    const total = Number((await pool.query<{ n: number }>(`select count(*)::int as n from public.${spec.table}`)).rows[0]!.n);
    counts.push({ sheet: spec.sheet, table: spec.table, exported: ids.length, inDatabase: found, missing: ids.length - found, tableTotal: total });
  }

  const ti = get('TradeIns'); const v = get('Vouchers'); const st = get('Settlements'); const col = get('Collections');
  const billable = (r: Raw) => ['CUSTOMER_ACCEPTED', 'DEVICE_RECEIVED', 'AWAITING_VOUCHER', 'VOUCHER_ISSUED', 'READY_FOR_COLLECTION', 'COLLECTED', 'SETTLED', 'CLOSED'].includes(s(r.Status));
  const unpaid = (r: Raw) => !['PAID', 'CLOSED', 'CANCELLED'].includes(s(r.Status).toUpperCase());
  const db = async (sql: string, params: unknown[] = []) => c((await pool.query<{ v: string }>(sql, params)).rows[0]?.v ?? '0');
  const tiIds = ti.map((r) => s(r.TradeInID)); const vIds = v.map((r) => s(r.VoucherID)); const sIds = st.map((r) => s(r.SettlementID)); const bIds = col.map((r) => s(r.BatchID));
  const billableSql = `status in ('CUSTOMER_ACCEPTED','DEVICE_RECEIVED','AWAITING_VOUCHER','VOUCHER_ISSUED','READY_FOR_COLLECTION','COLLECTED','SETTLED','CLOSED')`;
  const metrics: [string, number, number][] = [
    ['trade-ins: customer value (billable)', sum(ti, 'FinalCustomerValue', billable), await db(`select coalesce(sum(final_customer_value),0)::text as v from public.trade_ins where id = any($1::text[]) and ${billableSql}`, [tiIds])],
    ['trade-ins: partner fees (billable)', sum(ti, 'CommissionValue', billable), await db(`select coalesce(sum(commission_value),0)::text as v from public.trade_ins where id = any($1::text[]) and ${billableSql}`, [tiIds])],
    ['trade-ins: Qatar Mobile settlement value (billable)', sum(ti, 'TotalSettlement', billable), await db(`select coalesce(sum(total_settlement),0)::text as v from public.trade_ins where id = any($1::text[]) and ${billableSql}`, [tiIds])],
    ['vouchers: live customer value', sum(v, 'CustomerValue', (r) => s(r.Status).toUpperCase() === 'ISSUED'), await db(`select coalesce(sum(customer_value),0)::text as v from public.vouchers where id = any($1::text[]) and status = 'ISSUED'`, [vIds])],
    ['vouchers: live partner fees', sum(v, 'CommissionValue', (r) => s(r.Status).toUpperCase() === 'ISSUED'), await db(`select coalesce(sum(commission_value),0)::text as v from public.vouchers where id = any($1::text[]) and status = 'ISSUED'`, [vIds])],
    ['settlements: total (all but cancelled)', sum(st, 'SettlementTotal', (r) => s(r.Status).toUpperCase() !== 'CANCELLED'), await db(`select coalesce(sum(settlement_total),0)::text as v from public.settlements where id = any($1::text[]) and status <> 'CANCELLED'`, [sIds])],
    ['settlements: paid', sum(st, 'SettlementTotal', (r) => ['PAID', 'CLOSED'].includes(s(r.Status).toUpperCase())), await db(`select coalesce(sum(settlement_total),0)::text as v from public.settlements where id = any($1::text[]) and status in ('PAID','CLOSED')`, [sIds])],
    ['settlements: outstanding balance', sum(st, 'SettlementTotal', unpaid), await db(`select coalesce(sum(settlement_total),0)::text as v from public.settlements where id = any($1::text[]) and status not in ('PAID','CLOSED','CANCELLED')`, [sIds])],
    ['owed, not yet settled (collected, unclaimed)', sum(ti, 'TotalSettlement', (r) => s(r.Status) === 'COLLECTED' && !s(r.SettlementID)), await db(`select coalesce(sum(total_settlement),0)::text as v from public.trade_ins where id = any($1::text[]) and status = 'COLLECTED' and settlement_id is null`, [tiIds])],
    ['collections: expected amount', sum(col, 'ExpectedAmount'), await db(`select coalesce(sum(expected_amount),0)::text as v from public.collections where id = any($1::text[])`, [bIds])],
    ['collections: actual amount', sum(col, 'ActualAmount'), await db(`select coalesce(sum(actual_amount),0)::text as v from public.collections where id = any($1::text[])`, [bIds])],
  ];
  const totals = metrics.map(([metric, e, d]) => ({ metric, export: centsToNumber(e), database: centsToNumber(d), difference: centsToNumber(d - e) }));

  // Per-record money mismatches.
  const mismatches: Finding[] = [];
  const compareRows = async (sheet: string, table: string, key: string, fields: [string, string][]) => {
    const list = get(sheet);
    if (!list.length) return;
    const dbRows = new Map((await pool.query(`select * from public.${table} where id = any($1::text[])`, [list.map((r) => s(r[key]))])).rows.map((r) => [r.id as string, r]));
    for (const r of list) {
      const d = dbRows.get(s(r[key]));
      if (!d) continue;
      for (const [ek, dk] of fields) {
        const a = s(r[ek]) === '' ? null : c(r[ek]);
        const b = d[dk] === null ? null : c(d[dk]);
        if (a !== b) mismatches.push({ kind: 'MONEY_MISMATCH', sheet, id: s(r[key]), detail: `${ek}: export ${a === null ? '—' : centsToNumber(a)} vs database ${b === null ? '—' : centsToNumber(b)}` });
      }
      if (sheet === 'TradeIns' && s(r.Status) !== d.status) mismatches.push({ kind: 'STATUS_MISMATCH', sheet, id: s(r[key]), detail: `${s(r.Status)} vs ${d.status}` });
    }
  };
  await compareRows('TradeIns', 'trade_ins', 'TradeInID', [['FinalCustomerValue', 'final_customer_value'], ['CommissionValue', 'commission_value'], ['TotalSettlement', 'total_settlement'], ['EstimatedValue', 'estimated_value']]);
  await compareRows('Vouchers', 'vouchers', 'VoucherID', [['CustomerValue', 'customer_value'], ['CommissionValue', 'commission_value'], ['TotalSettlement', 'total_settlement']]);
  await compareRows('Settlements', 'settlements', 'SettlementID', [['SettlementTotal', 'settlement_total'], ['CustomerValueTotal', 'customer_value_total'], ['CommissionTotal', 'commission_total']]);

  // Orphans, judged on the export.
  const idSet = (sheet: string, k: string) => new Set(get(sheet).map((r) => s(r[k])));
  const ids = { cus: idSet('Customers', 'CustomerID'), ven: idSet('Vendors', 'VendorID'), br: idSet('Branches', 'BranchID'), var: idSet('Variants', 'VariantID'),
    ti: new Set(tiIds), v: new Set(vIds), st: new Set(sIds), b: new Set(bIds), ins: idSet('Inspections', 'InspectionID') };
  const orphans: Finding[] = [];
  const ref = (sheet: string, key: string, field: string, set: Set<string>, label: string) => {
    for (const r of get(sheet)) { const val = s(r[field]); if (val && !set.has(val)) orphans.push({ kind: 'ORPHAN', sheet, id: s(r[key]), detail: `${field} → missing ${label} ${val}` }); }
  };
  ref('TradeIns', 'TradeInID', 'CustomerID', ids.cus, 'customer'); ref('TradeIns', 'TradeInID', 'VendorID', ids.ven, 'partner');
  ref('TradeIns', 'TradeInID', 'BranchID', ids.br, 'branch'); ref('TradeIns', 'TradeInID', 'VariantID', ids.var, 'variant');
  ref('TradeIns', 'TradeInID', 'VoucherID', ids.v, 'voucher'); ref('TradeIns', 'TradeInID', 'SettlementID', ids.st, 'settlement');
  ref('TradeIns', 'TradeInID', 'CollectionBatchID', ids.b, 'collection note'); ref('TradeIns', 'TradeInID', 'InspectionID', ids.ins, 'inspection');
  ref('Vouchers', 'VoucherID', 'TradeInID', ids.ti, 'trade-in'); ref('CollectionItems', 'ItemID', 'BatchID', ids.b, 'collection note');
  ref('CollectionItems', 'ItemID', 'TradeInID', ids.ti, 'trade-in'); ref('Inspections', 'InspectionID', 'TradeInID', ids.ti, 'trade-in');
  ref('Branches', 'BranchID', 'VendorID', ids.ven, 'partner');

  // Invalid states, judged on the export.
  const invalidStates: Finding[] = [];
  for (const r of ti) {
    const id = s(r.TradeInID); const st0 = s(r.Status);
    if (!(st0 in TRADEIN_FLOW)) invalidStates.push({ kind: 'UNKNOWN_STATUS', sheet: 'TradeIns', id, detail: st0 });
    if (st0 === STATUS.SETTLED && !s(r.SettlementID)) invalidStates.push({ kind: 'SETTLED_WITHOUT_SETTLEMENT', sheet: 'TradeIns', id, detail: '' });
    if (s(r.VoucherID) && !['TRUE', 'YES', '1', 'Y'].includes(s(r.DeviceReceived).toUpperCase()) && r.DeviceReceived !== true) {
      invalidStates.push({ kind: 'VOUCHER_WITHOUT_DEVICE', sheet: 'TradeIns', id, detail: '' });
    }
    const f = c(r.FinalCustomerValue); const k = c(r.CommissionValue); const tot = c(r.TotalSettlement);
    if (s(r.FinalCustomerValue) && s(r.CommissionValue) && s(r.TotalSettlement) && f + k !== tot) invalidStates.push({ kind: 'TOTAL_NOT_VALUE_PLUS_FEE', sheet: 'TradeIns', id, detail: `${centsToNumber(f)} + ${centsToNumber(k)} ≠ ${centsToNumber(tot)}` });
  }
  for (const r of st) {
    const claimed = ti.filter((t) => s(t.SettlementID) === s(r.SettlementID));
    if (s(r.Status).toUpperCase() !== 'CANCELLED' && claimed.length !== Number(s(r.TradeInCount) || 0)) {
      invalidStates.push({ kind: 'SETTLEMENT_COUNT_MISMATCH', sheet: 'Settlements', id: s(r.SettlementID), detail: `header ${s(r.TradeInCount)} vs ${claimed.length} claimed` });
    }
  }

  // Evidence files that have no migrated object.
  const brokenFiles: Finding[] = (await pool.query<{ trade_in_id: string; legacy_drive_file_id: string }>(
    `select p.trade_in_id, p.legacy_drive_file_id from public.inspection_photos p
      where p.legacy_drive_file_id is not null and not exists (select 1 from public.legacy_file_map m where m.legacy_drive_file_id = p.legacy_drive_file_id)`)).rows
    .map((r) => ({ kind: 'FILE_NOT_MIGRATED', sheet: 'Inspections', id: r.trade_in_id, detail: `Drive file ${r.legacy_drive_file_id.slice(0, 6)}… has no stored object` }));

  const duplicates = findDuplicates(rows);
  const ok = counts.every((x) => x.missing === 0) && totals.every((x) => x.difference === 0) && !mismatches.length && !orphans.length && !duplicates.length && !invalidStates.length;
  return { counts, totals, mismatches, orphans, duplicates, invalidStates, brokenFiles, ok };
}
