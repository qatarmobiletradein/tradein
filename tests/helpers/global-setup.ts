/**
 * Builds a template database (Supabase shim + every migration through the
 * real runner + seed) once.
 * Each test file then clones it, so tests never share state. Runs only when
 * the throwaway server from tests/scripts/with-local-postgres.sh is up
 * (QM_TEST_DATABASE=1) — never against any other database.
 */
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPool } from '../../packages/database/src/db.js';
import { migrate } from '../../packages/database/src/migrate.js';

export const TEMPLATE = 'qm_template';

export async function setup(): Promise<void> {
  if (process.env.QM_TEST_DATABASE !== '1') return;
  const url = process.env.DATABASE_URL!;
  if (!/@127\.0\.0\.1:\d+\//.test(url)) throw new Error('Test database must be local (127.0.0.1).');
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`drop database if exists ${TEMPLATE}`);
  await admin.query(`create database ${TEMPLATE}`);
  await admin.end();

  const c = new pg.Client({ connectionString: url.replace(/\/[^/]+$/, `/${TEMPLATE}`) });
  await c.connect();
  await c.query(readFileSync(resolve('tests/sql/00_supabase_shim.sql'), 'utf8'));
  await c.end();
  // The real, checksummed runner (the same code `npm run migrate` uses).
  const pool = createPool({ connectionString: url.replace(/\/[^/]+$/, `/${TEMPLATE}`), max: 1, ssl: 'disable', applicationName: 'qm-test-setup' });
  try {
    await migrate(pool, resolve('supabase/migrations'), () => undefined);
    await pool.query(readFileSync(resolve('supabase/seed/seed.sql'), 'utf8'));
  } finally {
    await pool.end();
  }
}
