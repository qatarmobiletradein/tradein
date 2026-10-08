/**
 * npm run import:files -- --dir <downloaded-drive-files> [--apply]
 *
 * Moves legacy evidence photos (downloaded from Drive by an operator, named
 * by Drive file id) into the PRIVATE inspection-photos bucket. Without
 * --apply it only validates (dry run). Both modes print the target; a
 * non-local target needs MIGRATION_TARGET_CONFIRM=<project ref>.
 * Storage credentials come from the environment only (SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY); they are never printed.
 */
import { createPool } from '../../packages/database/src/db.js';
import { assertTargetAllowed, isProtected, sslFromEnv, supabaseRefOf } from '../../packages/database/src/target.js';
import { SupabaseStorage } from '../../apps/api/src/lib/storage.js';
import { migrateFiles } from './files.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const dir = arg('dir');
  const apply = process.argv.includes('--apply');
  const url = process.env.DATABASE_URL;
  if (!dir || !url) { console.error('Usage: --dir <dir> [--apply]  (DATABASE_URL must be set)'); process.exit(2); }
  let dbRef: string | null = null;
  try {
    const t = assertTargetAllowed(url, { purpose: apply ? 'file migration' : 'file validation' });
    dbRef = t.projectRef;
    console.log(`target: ${t.label}`);
  } catch (e) { console.error((e as Error).message); process.exit(2); }
  const sbUrl = process.env.SUPABASE_URL; const sbKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!sbUrl || !sbKey) { console.error('SUPABASE_URL and SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY) must be set in the environment.'); process.exit(2); }
  // The Storage project must be the SAME project as the database, and never a protected one.
  const sbRef = supabaseRefOf(sbUrl);
  if (sbRef && isProtected({ projectRef: sbRef, host: new URL(sbUrl).hostname }, process.env)) {
    console.error(`Refusing: SUPABASE_URL (${sbRef}) is listed in QM_PROTECTED_TARGETS.`); process.exit(2);
  }
  if (dbRef && sbRef && dbRef !== sbRef) {
    console.error(`Refusing: SUPABASE_URL is project ${sbRef} but DATABASE_URL is project ${dbRef}.`); process.exit(2);
  }
  const pool = createPool({ connectionString: url, max: 2, ...sslFromEnv(process.env, url), applicationName: 'qm-import-files' });
  try {
    const report = await migrateFiles(pool, new SupabaseStorage(sbUrl, sbKey), dir, !apply);
    console.log(JSON.stringify({ apply, uploaded: report.uploaded, validatedOnly: report.skipped, missing: report.missing.length, rejected: report.rejected }, null, 2));
    process.exitCode = report.missing.length || report.rejected.length ? 1 : 0;
  } finally {
    await pool.end();
  }
}
main().catch((e) => { console.error(`File migration failed: ${(e as Error).message}`); process.exit(1); });
