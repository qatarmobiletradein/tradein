/**
 * Migration tooling dry run through the REAL operator commands
 * (npm run import:sheets / compare:sheets) on FICTIONAL exports, against a
 * throwaway PostgreSQL. Never production data.
 *
 *   npm run rehearse:migration
 *
 * Covers: dry-run, validate (rollback), apply, failure + resume from
 * checkpoints, idempotent re-run, duplicate detection, deterministic ID
 * mapping, financial comparison, failed-row report (no personal data).
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { writeFictionalExport } from '../../tools/migration/fixtures/fictional-export.js';
import { createPool } from '../../packages/database/src/db.js';
import { invariantIssues } from '../../apps/api/src/jobs/reconcile.js';
import { migrate } from '../../packages/database/src/migrate.js';
import { Report, expect, skip, sleep } from '../../tools/staging/lib.js';

const url = process.env.DATABASE_URL ?? '';
if (!/@127\.0\.0\.1:\d+\//.test(url)) { console.error('Run through tests/scripts/with-local-postgres.sh'); process.exit(2); }

function cli(script: string, args: string[]) {
  const r = spawnSync(process.execPath, ['--import', 'tsx', script, ...args], {
    env: { PATH: process.env.PATH ?? '', DATABASE_URL: target, DATABASE_SSL: 'disable' }, encoding: 'utf8', timeout: 120_000,
  });
  const jsonStart = r.stdout.indexOf('{');
  let out: Record<string, unknown> = {};
  try { out = JSON.parse(r.stdout.slice(jsonStart)) as Record<string, unknown>; } catch { /* not json */ }
  return { status: r.status, out, stdout: r.stdout, stderr: r.stderr };
}

let target = '';
async function main(): Promise<void> {
  // A fresh database with the Supabase test shim + every migration (no seed: an import target starts empty).
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query('drop database if exists qm_migration_rehearsal');
  await admin.query('create database qm_migration_rehearsal');
  await admin.end();
  target = url.replace(/\/[^/]+$/, '/qm_migration_rehearsal');
  const pool = createPool({ connectionString: target, max: 2, ssl: 'disable' });
  await pool.query(readFileSync(resolve('tests/sql/00_supabase_shim.sql'), 'utf8'));
  await migrate(pool, resolve('supabase/migrations'));
  const n = async (t: string) => Number((await pool.query(`select count(*)::int as n from public.${t}`)).rows[0].n);

  const work = mkdtempSync(join(tmpdir(), 'qm-migrehearsal-'));
  const clean = join(work, 'clean'); const dirty = join(work, 'dirty'); const broken = join(work, 'broken'); const reports = join(work, 'reports');
  for (const d of [clean, dirty, broken, reports]) mkdirSync(d, { recursive: true });
  writeFictionalExport(clean); writeFictionalExport(dirty, { dirty: true }); writeFictionalExport(broken);
  // "broken": a trade-in that points at a customer that does not exist → the transactional group must fail as a unit.
  const ti = JSON.parse(readFileSync(join(broken, 'TradeIns.json'), 'utf8'));
  ti.rows[0].CustomerID = 'CUS-09999';
  writeFileSync(join(broken, 'TradeIns.json'), JSON.stringify(ti));
  // Same IMEIs in "broken" and "clean", so the resume below continues the SAME data set.
  copyFileSync(join(clean, 'Inspections.json'), join(broken, 'Inspections.json'));

  const report = new Report({ kind: 'migration tooling rehearsal (fictional exports, throwaway PostgreSQL)' });
  const IMPORT = 'tools/migration/import-cli.ts'; const COMPARE = 'tools/migration/compare-cli.ts';

  await report.check('migration', 'M-01', 'dry-run: nothing written; duplicates, invalid phones and ignored sheets reported', async () => {
    const r = cli(IMPORT, ['--dir', dirty, '--mode', 'dry-run', '--out', reports]);
    expect(r.status === 1, `exit ${r.status}`);
    expect((await n('vendors')) === 0 && (await n('migration_runs')) === 0, 'dry-run wrote to the database');
    const csv = readdirSync(reports).filter((f) => f.endsWith('failed-rows.csv')).map((f) => readFileSync(join(reports, f), 'utf8')).join('\n');
    expect(/duplicate phone/.test(csv), 'duplicate phone not reported');
    expect(/not a valid Qatar mobile number/.test(csv), 'invalid phone not reported');
    expect(!/55000600|0097455000600/.test(csv), 'the failed-row report contains a full phone number');
    return `${String(r.out.errors)} error(s) reported; failed-rows CSV written without personal data`;
  });
  await report.check('migration', 'M-02', 'validate: every constraint exercised in a transaction, then rolled back', async () => {
    const r = cli(IMPORT, ['--dir', clean, '--mode', 'validate', '--out', reports]);
    expect(r.status === 0, `exit ${r.status}: ${r.stderr.slice(0, 200)}`);
    expect((await n('trade_ins')) === 0 && (await n('vendors')) === 0, 'validate kept rows');
  });
  await report.check('migration', 'M-03', 'apply with a broken reference: the bad row and its dependents are rejected and reported; comparison and reconciliation flag the gap', async () => {
    const r = cli(IMPORT, ['--dir', broken, '--mode', 'apply', '--out', reports]);
    expect(r.status === 1, `exit ${r.status}`);
    expect(r.out.status === 'PARTIAL', `status ${String(r.out.status)}`);
    const runId = Number(r.out.runId);
    expect((await n('vendors')) === 1, 'reference sheets not committed');
    expect((await n('trade_ins')) === 1, `${await n('trade_ins')} trade-ins (expected only the valid one)`);
    expect((await n('vouchers')) === 0, 'the voucher of the rejected trade-in was imported');
    const errs = (await pool.query('select sheet, legacy_id from public.migration_row_errors where run_id = $1 order by id', [runId])).rows.map((e) => `${e.sheet}:${e.legacy_id}`);
    expect(errs.includes('TradeIns:TI-FIX-000007'), `row errors: ${errs.join(', ')}`);
    // Headers that lost their lines (a settlement for that month) are NOT silently "fixed": the
    // comparison must flag them, so the operator corrects the export and re-runs (M-04).
    const cmp = cli(COMPARE, ['--dir', broken, '--out', reports]);
    expect(cmp.status === 1 && Number(cmp.out.mismatches) + Number(cmp.out.orphans) + ((cmp.out.missing as unknown[]) ?? []).length > 0, `compare did not flag the partial import: ${cmp.stdout.slice(-300)}`);
    const issues = (await invariantIssues(pool)).map((i) => i.kind);
    expect(issues.includes('SETTLEMENT_COUNT_MISMATCH'), `reconciliation did not flag the settlement without its line: ${issues.join(',')}`);
    return `run ${runId} PARTIAL; rejected: ${errs.join(', ')}; reconciliation: ${[...new Set(issues)].join(', ')}; compare flags it (mismatches ${String(cmp.out.mismatches)}, missing ${JSON.stringify(cmp.out.missing)})`;
  });
  await report.check('migration', 'M-04', 'after fixing the export, a new APPLY run adds only what was missing', async () => {
    copyFileSync(join(clean, 'TradeIns.json'), join(broken, 'TradeIns.json'));
    const r = cli(IMPORT, ['--dir', broken, '--mode', 'apply', '--out', reports]);
    expect(r.status === 0, `exit ${r.status}: ${r.stderr.slice(0, 200)} ${r.stdout.slice(-300)}`);
    expect(r.out.status === 'SUCCEEDED', `status ${String(r.out.status)}`);
    expect((await n('trade_ins')) === 2 && (await n('vouchers')) === 1 && (await n('settlements')) === 1, 'missing rows not added');
  });
  await report.check('migration', 'M-05', 'resume: a run killed mid-way continues from its checkpoints with no duplicates', async () => {
    const big = join(work, 'big'); mkdirSync(big, { recursive: true });
    writeFictionalExport(big, { extraCustomers: 20000 });
    const before = await n('customers');
    const child = spawn(process.execPath, ['--import', 'tsx', IMPORT, '--dir', big, '--mode', 'apply', '--out', reports],
      { env: { PATH: process.env.PATH ?? '', DATABASE_URL: target, DATABASE_SSL: 'disable' }, stdio: 'ignore' });
    let runId = 0; let killedAt = 0;
    for (let i = 0; i < 600 && !killedAt; i++) {
      await sleep(50);
      const cp = (await pool.query(`select c.run_id, c.next_row from public.migration_checkpoints c join public.migration_runs r on r.id = c.run_id
        where c.sheet = 'Customers' and r.status = 'RUNNING' order by c.run_id desc limit 1`)).rows[0];
      if (cp && cp.next_row >= 1000) { child.kill('SIGKILL'); runId = Number(cp.run_id); killedAt = Number(cp.next_row); }
    }
    await new Promise((r) => child.on('exit', r));
    if (!killedAt) skip('the import finished before it could be interrupted');
    const mid = await n('customers');
    expect(mid > before && mid < before + 20000, `after the kill: ${mid - before} new customers`);
    const st = (await pool.query('select status from public.migration_runs where id = $1', [runId])).rows[0].status;
    expect(st === 'RUNNING', `interrupted run status ${st}`);
    const r = cli(IMPORT, ['--dir', big, '--mode', 'apply', '--resume', String(runId), '--out', reports]);
    expect(r.status === 0, `resume exit ${r.status}: ${r.stderr.slice(0, 300)}`);
    expect((await n('customers')) === before + 20000, `${(await n('customers')) - before} of 20000 imported`);
    const dup = (await pool.query(`select count(*)::int as n from (select phone from public.customers group by phone having count(*) > 1) d`)).rows[0].n;
    expect(dup === 0, `${dup} duplicate phones`);
    const bad = cli(IMPORT, ['--dir', big, '--mode', 'apply', '--resume', String(runId), '--out', reports]);
    expect(bad.status !== 0 && /already succeeded/.test(bad.stderr), 'a finished run was resumed again');
    return `killed run ${runId} at row ${killedAt}; resumed to ${(await n('customers')) - before} rows; re-resume refused`;
  });
  await report.check('migration', 'M-06', 'deterministic ID mapping: legacy ids kept; counters continue after them', async () => {
    const ids = (await pool.query(`select id from public.trade_ins order by id`)).rows.map((r) => r.id);
    expect(JSON.stringify(ids) === JSON.stringify(['TI-FIX-000007', 'TI-FIX-000008']), `ids ${ids.join(',')}`);
    const v = (await pool.query(`select voucher_number from public.vouchers`)).rows[0]?.voucher_number;
    expect(v === 'FIX-20260901-0001', `voucher number ${v}`);
    const c = (await pool.query(`select last_value from public.id_counters where scope = 'TI-FIX'`)).rows[0]?.last_value;
    expect(Number(c) >= 8, `TI-FIX counter ${c}`);
    const cus = (await pool.query(`select last_value from public.id_counters where scope = 'CUS'`)).rows[0]?.last_value;
    expect(Number(cus) >= 29999, `CUS counter ${cus}`);
  });
  await report.check('migration', 'M-07a', 're-running apply is idempotent (nothing inserted twice)', async () => {
    const before = await n('audit_logs');
    const r = cli(IMPORT, ['--dir', clean, '--mode', 'apply', '--out', reports]);
    expect(r.status === 0, `exit ${r.status}`);
    const sheets = (r.out.sheets ?? []) as { inserted: number }[];
    expect(sheets.every((x) => x.inserted === 0), 'rows were inserted again');
    expect((await n('trade_ins')) === 2 && (await n('audit_logs')) === before, 'duplicates created');
  });
  await report.check('migration', 'M-07b', '--resume with an unknown run id is refused clearly', async () => {
    const r = cli(IMPORT, ['--dir', clean, '--mode', 'apply', '--resume', '999999', '--out', reports]);
    expect(r.status !== 0 && /does not exist/.test(r.stderr), `got: ${r.stderr.slice(0, 200)}`);
  });
  await report.check('migration', 'M-07', 'compare: counts, exact financial totals, orphans, invalid states, broken files', async () => {
    const r = cli(COMPARE, ['--dir', clean, '--out', reports]);
    expect(r.status === 0 || (r.out.brokenFiles as number) > 0, `exit ${r.status}: ${r.stdout.slice(0, 300)}`);
    const totals = (r.out.totals ?? []) as { metric: string; difference: number }[];
    expect(totals.length > 0 && totals.every((t) => t.difference === 0), `totals differ: ${JSON.stringify(totals)}`);
    return `totals: ${totals.map((t) => `${t.metric}=0 diff`).join(', ')}; broken file refs: ${String(r.out.brokenFiles)} (photos not migrated yet — expected)`;
  });
  await report.check('migration', 'M-08', 'compare flags rows the import refused (dirty export)', async () => {
    const r = cli(COMPARE, ['--dir', dirty, '--out', reports]);
    expect(r.status === 1, `exit ${r.status}`);
    const missing = (r.out.missing ?? []) as { sheet: string; missing: number }[];
    expect(missing.some((m) => m.sheet === 'Customers' && m.missing === 2), `missing: ${JSON.stringify(missing)}`);
  });

  const files = report.write('staging-reports/migration-rehearsal');
  const c = report.counts();
  console.log(`\nMIGRATION REHEARSAL: PASS ${c.PASS} · FAIL ${c.FAIL} · SKIPPED ${c.SKIPPED} → ${files.md}`);
  await pool.end();
  rmSync(work, { recursive: true, force: true });
  process.exitCode = c.FAIL ? 1 : 0;
}
main().catch((e) => { console.error(`Migration rehearsal failed: ${(e as Error).message}`); process.exit(1); });
