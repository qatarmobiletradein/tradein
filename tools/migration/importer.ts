/**
 * Google Sheets export → PostgreSQL importer.
 *
 * Modes
 *   DRY_RUN   parse, map and check everything in memory. Writes NOTHING.
 *   VALIDATE  additionally inserts everything inside ONE transaction and
 *             ROLLS IT BACK, so every database constraint is exercised
 *             without keeping a row. Only the run summary is recorded.
 *   APPLY     writes. Reference sheets are committed in chunks with a
 *             checkpoint after each chunk; the transactional group
 *             (trade-ins, inspections, vouchers, collections, lines,
 *             settlements) is committed as one unit so deferred foreign
 *             keys between them are checked together.
 *             --resume <runId> continues an INTERRUPTED run from its
 *             checkpoints. After fixing rejected rows in the export, run
 *             APPLY again (a new run): rows that already exist (same legacy
 *             id) are skipped, so a re-run is safe and only adds what is new.
 *
 * Every rejected row is recorded with sheet, row number, legacy id and the
 * reason — never the row's personal data — in migration_row_errors (APPLY)
 * and in the JSON/CSV report files.
 *
 * NEVER point this at the production database without the cutover plan's
 * approvals (docs/CUTOVER_PLAN.md). It has not been run against production.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import { normalizePhone, toCsv } from '../../packages/shared/src/text.js';
import { businessDateCompact } from '../../packages/shared/src/time.js';
import { COUNTER_SOURCES, EXCLUDED_SHEETS, SHEETS, type Raw, type SheetSpec } from './mapping.js';

export type Mode = 'DRY_RUN' | 'VALIDATE' | 'APPLY';

export interface RowError { sheet: string; rowNumber: number; legacyId: string; error: string }
export interface SheetResult { sheet: string; read: number; mapped: number; inserted: number; skippedExisting: number; failed: number }
export interface ImportReport {
  mode: Mode; runId: number | null; sheets: SheetResult[]; errors: RowError[]; warnings: string[];
  duplicates: RowError[]; status: 'SUCCEEDED' | 'FAILED' | 'PARTIAL'; counters?: Record<string, number>;
}

/** Read every `<Sheet>.json` and `<Sheet>.<n>.json` (chunked exports) in a directory. */
export function loadExport(dir: string): { rows: Map<string, Raw[]>; warnings: string[] } {
  const rows = new Map<string, Raw[]>();
  const warnings: string[] = [];
  if (!existsSync(dir)) throw new Error(`Export directory not found: ${dir}`);
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const f of files) {
    const sheet = f.split('.')[0]!;
    if (EXCLUDED_SHEETS.includes(sheet)) { warnings.push(`${f}: ${sheet} is never migrated (sessions, codes, idempotency) — ignored.`); continue; }
    if (!SHEETS.some((s) => s.sheet === sheet)) { warnings.push(`${f}: unknown sheet — ignored.`); continue; }
    const doc = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { sheet?: string; rows?: Raw[] } | Raw[];
    const list = Array.isArray(doc) ? doc : (doc.rows ?? []);
    rows.set(sheet, [...(rows.get(sheet) ?? []), ...list]);
  }
  for (const s of SHEETS) if (!rows.has(s.sheet)) warnings.push(`${s.sheet}: no export file — treated as empty.`);
  return { rows, warnings };
}

/** Duplicate detection on the export itself (before any database involvement). */
export function findDuplicates(rows: Map<string, Raw[]>): RowError[] {
  const out: RowError[] = [];
  const s = (v: unknown) => (v === null || v === undefined ? '' : String(v)).trim();
  const dupBy = (sheet: string, keyOf: (r: Raw) => string, label: string, filter: (r: Raw) => boolean = () => true, idCol?: string) => {
    const seen = new Map<string, number>();
    (rows.get(sheet) ?? []).forEach((r, i) => {
      if (!filter(r)) return;
      const k = keyOf(r);
      if (!k) return;
      if (seen.has(k)) out.push({ sheet, rowNumber: i + 2, legacyId: s(r[idCol ?? SHEETS.find((x) => x.sheet === sheet)!.key]), error: `duplicate ${label} (first at row ${seen.get(k)! + 2})` });
      else seen.set(k, i);
    });
  };
  for (const spec of SHEETS) dupBy(spec.sheet, (r) => s(r[spec.key]), spec.key);
  dupBy('Users', (r) => normalizePhone(r.Phone), 'phone');
  dupBy('Customers', (r) => normalizePhone(r.Phone), 'phone');
  dupBy('Vendors', (r) => s(r.Code).toUpperCase(), 'vendor code');
  dupBy('Vouchers', (r) => s(r.VoucherNumber), 'voucher number');
  dupBy('Vouchers', (r) => s(r.TradeInID), 'live voucher for the same trade-in', (r) => s(r.Status).toUpperCase() === 'ISSUED');
  dupBy('TradeIns', (r) => s(r.IMEI).replace(/\D/g, ''), 'open IMEI', (r) => !['CANCELLED', 'CLOSED', 'CUSTOMER_DECLINED'].includes(s(r.Status)));
  const openBatches = new Set((rows.get('Collections') ?? []).filter((b) => ['DRAFT', 'READY_FOR_COLLECTION', 'PARTIALLY_COLLECTED', 'COLLECTION_EXCEPTION'].includes(s(b.CollectionStatus))).map((b) => s(b.BatchID)));
  dupBy('CollectionItems', (r) => s(r.TradeInID), 'pending line on an open note', (r) => s(r.ItemStatus) === 'PENDING' && openBatches.has(s(r.BatchID)));
  return out;
}

async function insertRow(c: pg.PoolClient, table: string, row: Record<string, unknown>, conflictSafe: boolean): Promise<void> {
  const keys = Object.keys(row);
  for (const k of [table, ...keys]) if (!/^[a-z_][a-z0-9_]*$/.test(k)) throw new Error(`bad identifier ${k}`);
  await c.query(`insert into public.${table} (${keys.join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')})${conflictSafe ? ' on conflict do nothing' : ''}`,
    keys.map((k) => row[k]));
}

async function processRows(
  c: pg.PoolClient, spec: SheetSpec, rows: Raw[], start: number, end: number, res: SheetResult, errors: RowError[], dupKeys: Set<string>,
): Promise<void> {
  for (let i = start; i < end; i++) {
    const r = rows[i]!;
    const legacyId = String(r[spec.key] ?? '').trim();
    if (dupKeys.has(`${spec.sheet}:${i}`)) { res.failed++; continue; }
    const m = spec.map(r);
    if (!m.ok) { res.failed++; errors.push({ sheet: spec.sheet, rowNumber: i + 2, legacyId, error: m.error }); continue; }
    res.mapped++;
    const exists = await c.query(`select 1 from public.${spec.table} where ${spec.idColumn} = $1`, [m.row[spec.idColumn]]);
    if (exists.rowCount) { res.skippedExisting++; continue; }
    await c.query('savepoint qm_row');
    try {
      await insertRow(c, spec.table, m.row, false);
      for (const x of m.extra ?? []) await insertRow(c, x.table, x.row, true);
      await c.query('release savepoint qm_row');
      res.inserted++;
    } catch (e) {
      await c.query('rollback to savepoint qm_row');
      res.failed++; res.inserted += 0;
      errors.push({ sheet: spec.sheet, rowNumber: i + 2, legacyId, error: (e as Error).message.slice(0, 300) });
    }
  }
}

/** Continue every legacy sequence from the highest imported number. */
export async function setCounters(c: pg.PoolClient | pg.Pool): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const src of COUNTER_SOURCES) {
    const r = await c.query<{ mx: string | null }>(`select max(substring(id from '[0-9]+$')::bigint)::text as mx from public.${src.table} where id like $1`, [`${src.prefix}%`]);
    const mx = Number(r.rows[0]?.mx ?? 0);
    if (mx > 0) {
      await c.query(`insert into public.id_counters (scope, last_value) values ($1, $2) on conflict (scope) do update set last_value = greatest(public.id_counters.last_value, excluded.last_value)`, [src.scope, mx]);
      out[src.scope] = mx;
    }
  }
  const ti = await c.query<{ code: string; mx: string }>(`select substring(id from '^TI-([A-Z0-9]+)-') as code, max(substring(id from '[0-9]+$')::bigint)::text as mx from public.trade_ins group by 1`);
  for (const r of ti.rows) {
    await c.query(`insert into public.id_counters (scope, last_value) values ($1, $2) on conflict (scope) do update set last_value = greatest(public.id_counters.last_value, excluded.last_value)`, [`TI-${r.code}`, Number(r.mx)]);
    out[`TI-${r.code}`] = Number(r.mx);
  }
  // Voucher numbers restart per partner per day; only today's sequence can collide with a new issue.
  const today = businessDateCompact(new Date());
  const vn = await c.query<{ p: string; mx: string }>(`select substring(voucher_number from '^(.*)-[0-9]+$') as p, max(substring(voucher_number from '[0-9]+$')::bigint)::text as mx
    from public.vouchers where voucher_number like $1 group by 1`, [`%-${today}-%`]);
  for (const r of vn.rows) {
    const [code, day] = [r.p.slice(0, r.p.lastIndexOf('-')), r.p.slice(r.p.lastIndexOf('-') + 1)];
    await c.query(`insert into public.id_counters (scope, last_value) values ($1, $2) on conflict (scope) do update set last_value = greatest(public.id_counters.last_value, excluded.last_value)`, [`VOUCHER-${code}-${day}`, Number(r.mx)]);
  }
  return out;
}

export async function runImport(pool: pg.Pool, dir: string, mode: Mode, opts: { label?: string; resumeRunId?: number; chunk?: number } = {}): Promise<ImportReport> {
  const { rows, warnings } = loadExport(dir);
  const duplicates = findDuplicates(rows);
  const dupKeys = new Set<string>();
  for (const d of duplicates) dupKeys.add(`${d.sheet}:${d.rowNumber - 2}`);
  const errors: RowError[] = [...duplicates];
  const results: SheetResult[] = SHEETS.map((s) => ({ sheet: s.sheet, read: rows.get(s.sheet)?.length ?? 0, mapped: 0, inserted: 0, skippedExisting: 0, failed: 0 }));
  const resOf = (sheet: string) => results.find((r) => r.sheet === sheet)!;

  if (mode === 'DRY_RUN') {
    for (const spec of SHEETS) {
      (rows.get(spec.sheet) ?? []).forEach((r, i) => {
        if (dupKeys.has(`${spec.sheet}:${i}`)) { resOf(spec.sheet).failed++; return; }
        const m = spec.map(r);
        if (m.ok) resOf(spec.sheet).mapped++;
        else { resOf(spec.sheet).failed++; errors.push({ sheet: spec.sheet, rowNumber: i + 2, legacyId: String(r[spec.key] ?? ''), error: m.error }); }
      });
    }
    return { mode, runId: null, sheets: results, errors, warnings, duplicates, status: errors.length ? 'PARTIAL' : 'SUCCEEDED' };
  }

  if (mode === 'VALIDATE') {
    const c = await pool.connect();
    try {
      await c.query('begin');
      for (const spec of SHEETS) {
        const list = rows.get(spec.sheet) ?? [];
        await processRows(c, spec, list, 0, list.length, resOf(spec.sheet), errors, dupKeys);
      }
      await c.query('savepoint qm_deferred');
      try { await c.query('set constraints all immediate'); } catch (e) {
        errors.push({ sheet: '(cross-sheet)', rowNumber: 0, legacyId: '', error: `deferred reference check failed: ${(e as Error).message.slice(0, 300)}` });
        await c.query('rollback to savepoint qm_deferred');
      }
    } finally {
      await c.query('rollback').catch(() => undefined);
      c.release();
    }
    const run = await pool.query<{ id: number }>(`insert into public.migration_runs (source_label, mode, status, finished_at, summary) values ($1, 'VALIDATE', $2, now(), $3::jsonb) returning id`,
      [opts.label ?? dir, errors.length ? 'PARTIAL' : 'SUCCEEDED', JSON.stringify({ sheets: results, errors: errors.length })]);
    return { mode, runId: run.rows[0]!.id, sheets: results, errors, warnings, duplicates, status: errors.length ? 'PARTIAL' : 'SUCCEEDED' };
  }

  // ---------------------------------------------------------------- APPLY
  if (opts.resumeRunId !== undefined) {
    // Resume only what can be resumed: an existing APPLY run that did not finish cleanly.
    const prior = (await pool.query<{ mode: string; status: string }>('select mode, status from public.migration_runs where id = $1', [opts.resumeRunId])).rows[0];
    if (!prior) throw new Error(`Run ${opts.resumeRunId} does not exist in this database.`);
    if (prior.mode !== 'APPLY') throw new Error(`Run ${opts.resumeRunId} was a ${prior.mode} run; only APPLY runs can be resumed.`);
    if (prior.status === 'SUCCEEDED') throw new Error(`Run ${opts.resumeRunId} already succeeded; nothing to resume.`);
  }
  const runId = opts.resumeRunId ?? (await pool.query<{ id: number }>(
    `insert into public.migration_runs (source_label, mode) values ($1, 'APPLY') returning id`, [opts.label ?? dir])).rows[0]!.id;
  const checkpoint = async (sheet: string): Promise<number> =>
    (await pool.query<{ next_row: number }>('select next_row from public.migration_checkpoints where run_id = $1 and sheet = $2', [runId, sheet])).rows[0]?.next_row ?? 0;
  const setCheckpoint = (c: pg.PoolClient, sheet: string, next: number) =>
    c.query(`insert into public.migration_checkpoints (run_id, sheet, next_row) values ($1,$2,$3) on conflict (run_id, sheet) do update set next_row = excluded.next_row`, [runId, sheet, next]);
  const chunk = opts.chunk ?? 500;
  let status: ImportReport['status'] = 'SUCCEEDED';

  const recordErrors = async (c: pg.PoolClient | pg.Pool, list: RowError[]) => {
    for (const e of list) await c.query('insert into public.migration_row_errors (run_id, sheet, row_number, legacy_id, error) values ($1,$2,$3,$4,$5)', [runId, e.sheet, e.rowNumber, e.legacyId, e.error]);
  };
  if (!opts.resumeRunId) await recordErrors(pool, duplicates);

  for (const spec of SHEETS.filter((s) => !s.transactional && !['Notifications', 'AuditLog'].includes(s.sheet))) {
    await applySheet(spec);
  }
  // The transactional group: committed together (deferred cross-references are checked at the
  // end, and a failure there rolls the whole group back). A row that breaks a constraint is
  // rejected and reported on its own; rows that depend on it are rejected by their foreign keys.
  if ((await checkpoint('(transactional)')) === 0) {
    const c = await pool.connect();
    const before = errors.length;
    try {
      await c.query('begin');
      for (const spec of SHEETS.filter((s) => s.transactional)) {
        const list = rows.get(spec.sheet) ?? [];
        await processRows(c, spec, list, 0, list.length, resOf(spec.sheet), errors, dupKeys);
      }
      await setCheckpoint(c, '(transactional)', 1);
      await recordErrors(c, errors.slice(before));
      await c.query('commit');
    } catch (e) {
      await c.query('rollback').catch(() => undefined);
      for (const spec of SHEETS.filter((s) => s.transactional)) resOf(spec.sheet).inserted = 0;
      errors.push({ sheet: '(transactional)', rowNumber: 0, legacyId: '', error: `group rolled back: ${(e as Error).message.slice(0, 300)}` });
      await recordErrors(pool, errors.slice(-1));
      status = 'FAILED';
    } finally {
      c.release();
    }
  }
  if (status !== 'FAILED') for (const spec of SHEETS.filter((s) => ['Notifications', 'AuditLog'].includes(s.sheet))) await applySheet(spec);

  const counters = status === 'FAILED' ? undefined : await setCounters(pool);
  if (status === 'SUCCEEDED' && errors.length) status = 'PARTIAL';
  await pool.query(`update public.migration_runs set status = $2, finished_at = now(), summary = $3::jsonb where id = $1`,
    [runId, status, JSON.stringify({ sheets: results, errors: errors.length, counters })]);
  return { mode, runId, sheets: results, errors, warnings, duplicates, status, counters };

  async function applySheet(spec: SheetSpec): Promise<void> {
    const list = rows.get(spec.sheet) ?? [];
    let start = await checkpoint(spec.sheet);
    while (start < list.length) {
      const end = Math.min(list.length, start + chunk);
      const c = await pool.connect();
      const before = errors.length;
      try {
        await c.query('begin');
        await processRows(c, spec, list, start, end, resOf(spec.sheet), errors, dupKeys);
        await recordErrors(c, errors.slice(before));
        await setCheckpoint(c, spec.sheet, end);
        await c.query('commit');
      } catch (e) {
        await c.query('rollback').catch(() => undefined);
        throw e;
      } finally {
        c.release();
      }
      start = end;
    }
  }
}

/** Failed-row report as CSV (no personal data: sheet, row, legacy id, reason). */
export function errorsCsv(errors: RowError[]): string {
  return toCsv(['Sheet', 'Row', 'Legacy ID', 'Error'], errors.map((e) => [e.sheet, e.rowNumber, e.legacyId, e.error]));
}
