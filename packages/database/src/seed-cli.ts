/**
 * `npm run seed:dev` — load supabase/seed/seed.sql into DATABASE_URL.
 * Refuses outright when APP_ENV is production (or unset, which defaults to
 * production): seed data is fictional and must never reach live data.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPool } from './db.js';

async function main(): Promise<void> {
  const env = (process.env.APP_ENV ?? 'production').toLowerCase();
  if (env !== 'development' && env !== 'test') {
    console.error('Refusing to seed: APP_ENV must be development or test.');
    process.exit(2);
  }
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  const pool = createPool({ connectionString: url, max: 1, ssl: (process.env.DATABASE_SSL as 'require' | 'no-verify' | 'disable' | undefined) ?? 'disable', applicationName: 'qm-seed' });
  try {
    await pool.query(readFileSync(resolve('supabase/seed/seed.sql'), 'utf8'));
    console.log('Seed loaded (fictional data).');
  } finally {
    await pool.end();
  }
}
main().catch((err) => { console.error(`Seed failed: ${(err as Error).message}`); process.exit(1); });
