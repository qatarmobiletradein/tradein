/**
 * Ordered, checksummed SQL migrations from supabase/migrations.
 *
 * Two supported ways to apply the same files:
 *   - the Supabase CLI (`supabase db push`), which records them in
 *     supabase_migrations.schema_migrations; or
 *   - this runner (`npm run migrate`), which records them in
 *     app.schema_migrations.
 * Use ONE of them per database (see docs/SUPABASE_SETUP.md). The runner
 * refuses to continue if a file that was already applied has changed.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type pg from 'pg';

export interface MigrationFile { version: string; name: string; sql: string; checksum: string }

export function listMigrations(dir: string): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => /^\d{14}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((f) => {
      const sql = readFileSync(join(dir, f), 'utf8');
      return { version: f.slice(0, 14), name: f, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    });
}

export interface MigrateResult { applied: string[]; skipped: string[] }

export async function migrate(pool: pg.Pool, dir: string, log: (m: string) => void = () => undefined): Promise<MigrateResult> {
  const files = listMigrations(dir);
  const client = await pool.connect();
  // Surface WARNINGs raised by a migration (e.g. an optional step that was skipped).
  const onNotice = (n: { severity?: string; message?: string }) => {
    if (n.severity === 'WARNING') log(`WARNING: ${n.message ?? ''}`);
  };
  client.on('notice', onNotice);
  const applied: string[] = [];
  const skipped: string[] = [];
  try {
    // One migrator at a time, across processes.
    await client.query('select pg_advisory_lock(hashtextextended($1, 0))', ['qm.migrate']);
    await client.query('create schema if not exists app');
    await client.query(`create table if not exists app.schema_migrations (
      version text primary key, name text not null, checksum text not null,
      applied_at timestamptz not null default now())`);
    const done = new Map<string, string>(
      (await client.query<{ version: string; checksum: string }>('select version, checksum from app.schema_migrations'))
        .rows.map((r) => [r.version, r.checksum]),
    );
    for (const f of files) {
      const prior = done.get(f.version);
      if (prior) {
        if (prior !== f.checksum) {
          throw new Error(`Migration ${f.name} was already applied and has since been modified. Refusing to continue.`);
        }
        skipped.push(f.name);
        continue;
      }
      log(`applying ${f.name}`);
      await client.query('BEGIN');
      try {
        await client.query(f.sql);
        await client.query('insert into app.schema_migrations (version, name, checksum) values ($1, $2, $3)',
          [f.version, f.name, f.checksum]);
        await client.query('COMMIT');
        applied.push(f.name);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      }
    }
    return { applied, skipped };
  } finally {
    await client.query('select pg_advisory_unlock(hashtextextended($1, 0))', ['qm.migrate']).catch(() => undefined);
    client.off('notice', onNotice);
    client.release();
  }
}
