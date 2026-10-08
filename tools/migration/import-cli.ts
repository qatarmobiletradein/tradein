/**
 * npm run import:sheets -- --dir <export-dir> --mode dry-run|validate|apply [--resume <runId>] [--out <report-dir>]
 *
 * VALIDATE and APPLY print the target (no password) and, for any non-local
 * database, require MIGRATION_TARGET_CONFIRM=<Supabase project ref>.
 * Targets in QM_PROTECTED_TARGETS (the production ref) are refused. Reports are written to --out (default ./migration-reports).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createPool } from '../../packages/database/src/db.js';
import { assertTargetAllowed, sslFromEnv } from '../../packages/database/src/target.js';
import { errorsCsv, runImport, type Mode } from './importer.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const dir = arg('dir');
  const mode = ({ 'dry-run': 'DRY_RUN', validate: 'VALIDATE', apply: 'APPLY' } as Record<string, Mode>)[arg('mode') ?? 'dry-run'];
  if (!dir || !mode) { console.error('Usage: --dir <export-dir> --mode dry-run|validate|apply [--resume <runId>]'); process.exit(2); }
  const resume = arg('resume');
  if (resume !== undefined && !/^[1-9][0-9]*$/.test(resume)) { console.error('--resume needs the numeric run id printed by the interrupted run.'); process.exit(2); }
  const out = resolve(arg('out') ?? 'migration-reports');
  mkdirSync(out, { recursive: true });
  let pool = null;
  if (mode !== 'DRY_RUN') {
    const url = process.env.DATABASE_URL;
    if (!url) { console.error('DATABASE_URL is not set.'); process.exit(2); }
    try {
      console.log(`target: ${assertTargetAllowed(url, { purpose: `import ${mode}` }).label}`);
    } catch (e) { console.error((e as Error).message); process.exit(2); }
    pool = createPool({ connectionString: url, max: 2, ...sslFromEnv(process.env, url), applicationName: 'qm-import' });
  }
  try {
    const report = await runImport(pool ?? (null as never), resolve(dir), mode, { label: dir, resumeRunId: arg('resume') ? Number(arg('resume')) : undefined });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    writeFileSync(join(out, `import-${mode.toLowerCase()}-${stamp}.json`), JSON.stringify(report, null, 2));
    writeFileSync(join(out, `import-${mode.toLowerCase()}-${stamp}-failed-rows.csv`), errorsCsv(report.errors));
    console.log(JSON.stringify({ mode, runId: report.runId, status: report.status, errors: report.errors.length, warnings: report.warnings.length, sheets: report.sheets }, null, 2));
    process.exitCode = report.status === 'SUCCEEDED' ? 0 : 1;
  } finally {
    await pool?.end();
  }
}
main().catch((e) => { console.error(`Import failed: ${(e as Error).message}`); process.exit(1); });
