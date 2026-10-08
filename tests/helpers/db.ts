import pg from 'pg';
import { randomBytes } from 'node:crypto';

export const HAS_DB = process.env.QM_TEST_DATABASE === '1';

/** A fresh database cloned from the template; returns its URL and a drop function. */
export async function freshDatabase(): Promise<{ url: string; drop: () => Promise<void> }> {
  const base = process.env.DATABASE_URL!;
  const name = `qm_t_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`create database ${name} template qm_template`);
  await admin.end();
  const url = base.replace(/\/[^/]+$/, `/${name}`);
  return {
    url,
    drop: async () => {
      const a = new pg.Client({ connectionString: base });
      await a.connect();
      await a.query(`drop database if exists ${name} with (force)`);
      await a.end();
    },
  };
}
