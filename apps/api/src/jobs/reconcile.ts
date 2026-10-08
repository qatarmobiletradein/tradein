/**
 * Reconciliation (30_Reconciliation.gs) — READ ONLY. Nothing is changed.
 *
 * Many 3.1 findings described half-finished multi-step writes; one
 * transaction per operation makes those impossible, but they are still
 * checked, because imported legacy data can contain them. Each run is
 * recorded in job_runs with its issues in reconciliation_issues, so a
 * failure or a finding is visible without reading logs.
 */
import type pg from 'pg';
import { maskImei } from '../../../../packages/shared/src/text.js';

export interface Issue { kind: string; objectId: string; detail: string }

export const CHECKS: { kind: string; sql: string; detail: (r: Record<string, unknown>) => string; id: (r: Record<string, unknown>) => string }[] = [
  { kind: 'MULTIPLE_LIVE_VOUCHERS', sql: `select trade_in_id, string_agg(voucher_number, ', ') as n from public.vouchers where status = 'ISSUED' group by trade_in_id having count(*) > 1`,
    id: (r) => String(r.trade_in_id), detail: (r) => String(r.n) },
  { kind: 'VOUCHER_NOT_LINKED', sql: `select v.id, v.voucher_number, v.trade_in_id, t.voucher_id, t.status from public.vouchers v join public.trade_ins t on t.id = v.trade_in_id
      where v.status = 'ISSUED' and t.voucher_id is distinct from v.id`,
    id: (r) => String(r.id), detail: (r) => `live voucher ${r.voucher_number} but trade-in ${r.trade_in_id} points at "${r.voucher_id ?? ''}" (${r.status})` },
  { kind: 'TRADEIN_POINTS_AT_VOIDED_VOUCHER', sql: `select t.id, t.voucher_id, v.status from public.trade_ins t join public.vouchers v on v.id = t.voucher_id where v.status <> 'ISSUED'`,
    id: (r) => String(r.id), detail: (r) => `${r.voucher_id} is ${r.status}` },
  { kind: 'DUPLICATE_OPEN_IMEI', sql: `select imei, string_agg(id, ', ') as ids from public.trade_ins where imei is not null and status not in ('CANCELLED','CLOSED','CUSTOMER_DECLINED') group by imei having count(*) > 1`,
    id: (r) => maskImei(r.imei), detail: (r) => String(r.ids) },
  { kind: 'SETTLEMENT_COUNT_MISMATCH', sql: `select s.id, s.trade_in_count, (select count(*)::int from public.trade_ins t where t.settlement_id = s.id) as claimed
      from public.settlements s where s.status <> 'CANCELLED' and s.trade_in_count <> (select count(*) from public.trade_ins t where t.settlement_id = s.id)`,
    id: (r) => String(r.id), detail: (r) => `header ${r.trade_in_count}, claimed ${r.claimed}` },
  { kind: 'SETTLEMENT_TOTAL_MISMATCH', sql: `select s.id, s.settlement_total::text as h, coalesce((select sum(t.total_settlement) from public.trade_ins t where t.settlement_id = s.id), 0)::text as l
      from public.settlements s where s.status <> 'CANCELLED' and s.settlement_total <> coalesce((select sum(t.total_settlement) from public.trade_ins t where t.settlement_id = s.id), 0)`,
    id: (r) => String(r.id), detail: (r) => `header ${r.h}, lines ${r.l}` },
  { kind: 'CANCELLED_SETTLEMENT_STILL_CLAIMS', sql: `select s.id, count(t.id)::int as n from public.settlements s join public.trade_ins t on t.settlement_id = s.id where s.status = 'CANCELLED' group by s.id`,
    id: (r) => String(r.id), detail: (r) => `${r.n} trade-in(s)` },
  { kind: 'PAID_SETTLEMENT_OPEN_TRADEINS', sql: `select s.id, count(t.id)::int as n from public.settlements s join public.trade_ins t on t.settlement_id = s.id
      where s.status in ('PAID','CLOSED') and t.status <> 'CLOSED' group by s.id`,
    id: (r) => String(r.id), detail: (r) => `${r.n} trade-in(s) not CLOSED` },
  { kind: 'COLLECTION_NOTE_WITHOUT_LINES', sql: `select c.id, c.status from public.collections c where not exists (select 1 from public.collection_items i where i.batch_id = c.id)`,
    id: (r) => String(r.id), detail: (r) => String(r.status) },
  { kind: 'COLLECTED_BUT_LINE_PENDING', sql: `select i.trade_in_id, i.batch_id from public.collection_items i join public.trade_ins t on t.id = i.trade_in_id
      where i.item_status = 'PENDING' and t.status = 'COLLECTED'`,
    id: (r) => String(r.trade_in_id), detail: (r) => `pending on ${r.batch_id}` },
  { kind: 'UNDATED_COLLECTED', sql: `select t.id, t.vendor_id from public.trade_ins t left join public.collections c on c.id = t.collection_batch_id
      where t.status = 'COLLECTED' and t.settlement_id is null and t.collected_at is null and c.collected_at is null`,
    id: (r) => String(r.id), detail: (r) => `collected for ${r.vendor_id} with no collected date — no settlement can pick it up` },
  { kind: 'TRADEIN_TOTAL_MISMATCH', sql: `select id from public.trade_ins where final_customer_value is not null and commission_value is not null and total_settlement is not null
      and total_settlement <> final_customer_value + commission_value`,
    id: (r) => String(r.id), detail: () => 'total settlement is not customer value + fee' },
  { kind: 'ORPHAN_PHOTO_ROW', sql: `select p.id from public.inspection_photos p left join public.inspections i on i.id = p.inspection_id where i.id is null`,
    id: (r) => String(r.id), detail: () => 'photo row without inspection' },
];

/** The same integrity checks WITHOUT recording anything (used by the staging verification). */
export async function invariantIssues(db: { query(sql: string): Promise<{ rows: unknown[] }> }): Promise<Issue[]> {
  const issues: Issue[] = [];
  for (const c of CHECKS) {
    const rows = (await db.query(c.sql)).rows as Record<string, unknown>[];
    for (const r of rows) issues.push({ kind: c.kind, objectId: c.id(r), detail: c.detail(r) });
  }
  return issues;
}

export async function runReconciliation(pool: pg.Pool): Promise<{ runId: number; issues: Issue[]; counts: Record<string, number> }> {
  const run = (await pool.query<{ id: number }>(`insert into public.job_runs (job) values ('reconcile') returning id`)).rows[0]!;
  try {
    const issues: Issue[] = [];
    for (const c of CHECKS) {
      const rows = (await pool.query(c.sql)).rows as Record<string, unknown>[];
      for (const r of rows) issues.push({ kind: c.kind, objectId: c.id(r), detail: c.detail(r) });
    }
    // Counters must be at or above the highest number in use, or a create would collide.
    const counters = await pool.query<{ scope: string; last_value: number; mx: number }>(`
      with used as (
        select 'VCH' as scope, max(substring(id from '\\d+$')::bigint) as mx from public.vouchers
        union all select 'BAT', max(substring(id from '\\d+$')::bigint) from public.collections
        union all select 'STL', max(substring(id from '\\d+$')::bigint) from public.settlements
        union all select 'INS', max(substring(id from '\\d+$')::bigint) from public.inspections
        union all select 'CLI', max(substring(id from '\\d+$')::bigint) from public.collection_items
        union all select 'USR', max(substring(id from '\\d+$')::bigint) from public.app_users
        union all select 'CUS', max(substring(id from '\\d+$')::bigint) from public.customers)
      select u.scope, coalesce(c.last_value, 0)::bigint as last_value, u.mx from used u left join public.id_counters c on c.scope = u.scope
       where u.mx is not null and coalesce(c.last_value, 0) < u.mx`);
    for (const r of counters.rows) issues.push({ kind: 'COUNTER_BEHIND_DATA', objectId: r.scope, detail: `${r.last_value} < ${r.mx}` });

    for (const i of issues.slice(0, 5000)) {
      await pool.query('insert into public.reconciliation_issues (run_id, kind, object_id, detail) values ($1,$2,$3,$4)', [run.id, i.kind, i.objectId, i.detail.slice(0, 1000)]);
    }
    const counts: Record<string, number> = {};
    for (const i of issues) counts[i.kind] = (counts[i.kind] ?? 0) + 1;
    await pool.query(`update public.job_runs set status = 'SUCCEEDED', finished_at = now(), summary = $2::jsonb where id = $1`,
      [run.id, JSON.stringify({ issues: issues.length, counts })]);
    await pool.query(`insert into public.audit_logs (actor_id, actor_name, actor_role, action, object_type, object_id, details)
      values ('system','reconciliation','SYSTEM','RECONCILIATION_RUN','JOB',$1,$2::jsonb)`, [String(run.id), JSON.stringify({ issues: issues.length, counts })]);
    return { runId: run.id, issues, counts };
  } catch (err) {
    await pool.query(`update public.job_runs set status = 'FAILED', finished_at = now(), error = $2 where id = $1`,
      [run.id, (err as Error).message.slice(0, 1000)]).catch(() => undefined);
    throw err;
  }
}

/** Housekeeping: expired idempotency records and old OTP send rows. Never touches business data. */
export async function runPurge(pool: pg.Pool): Promise<{ idempotency: number; otpLog: number }> {
  const run = (await pool.query<{ id: number }>(`insert into public.job_runs (job) values ('purge') returning id`)).rows[0]!;
  try {
    const a = await pool.query('delete from public.idempotency_keys where expires_at < now()');
    const b = await pool.query(`delete from public.otp_send_log where created_at < now() - interval '90 days'`);
    await pool.query(`delete from public.otp_verify_attempts where created_at < now() - interval '90 days'`);
    await pool.query(`delete from public.staff_auth_attempts where created_at < now() - interval '90 days'`);
    const out = { idempotency: a.rowCount ?? 0, otpLog: b.rowCount ?? 0 };
    await pool.query(`update public.job_runs set status = 'SUCCEEDED', finished_at = now(), summary = $2::jsonb where id = $1`, [run.id, JSON.stringify(out)]);
    return out;
  } catch (err) {
    await pool.query(`update public.job_runs set status = 'FAILED', finished_at = now(), error = $2 where id = $1`, [run.id, (err as Error).message.slice(0, 1000)]).catch(() => undefined);
    throw err;
  }
}
