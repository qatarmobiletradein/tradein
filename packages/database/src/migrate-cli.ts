/**
 * `npm run migrate` — apply supabase/migrations to DATABASE_URL.
 *
 * Never run on boot. Operator command (or a deliberate Railway pre-deploy
 * step for STAGING only). It prints the target without the password and,
 * for any non-local database, requires MIGRATION_TARGET_CONFIRM=<project
 * ref>. Targets in QM_PROTECTED_TARGETS are refused. Supabase's
 * transaction pooler (6543) is refused: the runner needs a session lock.
 */
import { resolve } from 'node:path';
import { createPool } from './db.js';
import { migrate } from './migrate.js';
import { assertTargetAllowed, sslFromEnv } from './target.js';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set.');
    process.exit(2);
  }
  let label = '';
  try {
    label = assertTargetAllowed(url, { purpose: 'migrations', needsSession: true }).label;
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
  console.log(`target: ${label}`);
  const pool = createPool({ connectionString: url, max: 1, ...sslFromEnv(process.env, url), applicationName: 'qm-migrate' });
  const dir = resolve(process.env.MIGRATIONS_DIR ?? 'supabase/migrations');
  try {
    const r = await migrate(pool, dir, (m) => console.log(m));
    console.log(JSON.stringify({ applied: r.applied.length, alreadyApplied: r.skipped.length }));
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(`Migration failed: ${(err as Error).message}`);
  process.exit(1);
});
