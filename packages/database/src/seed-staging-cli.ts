/**
 * `npm run seed:staging -- [--testers staging-testers.json]`
 *
 * Loads the fictional base seed (supabase/seed/seed.sql) plus the staging
 * additions (supabase/seed/staging_extra.sql) into a STAGING database, then
 * optionally points selected seeded profiles at real tester handsets so the
 * team can sign in with real SMS codes.
 *
 * Safety:
 *   - APP_ENV must be staging (development/test allowed for rehearsal).
 *   - The target is printed without its password; a non-local target needs
 *     MIGRATION_TARGET_CONFIRM=<project ref>; QM_PROTECTED_TARGETS refused.
 *   - It refuses a database that holds anything that is not the fictional
 *     seed: an unknown partner, or the seed partner ids with other names.
 *   - Everything is idempotent (ON CONFLICT DO NOTHING); re-running is safe.
 *   - Tester numbers come from a git-ignored file and are never printed in
 *     full (last 4 digits only).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { maskEmail, maskPhone, normalizeEmail, normalizePhone } from '../../shared/src/text.js';
import { createPool } from './db.js';
import { assertTargetAllowed, sslFromEnv } from './target.js';
import { isMain } from '../../shared/src/main.js';

const SEED_PARTNERS: Record<string, string> = {
  'VND-001': 'Demo Electronics (fictional)',
  'VND-002': 'Second Demo Partner (fictional)',
};
const MAPPABLE = /^(USR-000(0[1-9])|CUS-0000[12])$/;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

export interface Tester { id: string; phone?: string; email?: string }

/**
 * Tester map. A value is a Qatar mobile number (customers; staff when
 * STAFF_SIGN_IN=phone), a work email (staff), or { "phone": ..., "email": ... }.
 * Customers sign in by SMS, so a customer needs a phone; staff need an email
 * when they sign in by password.
 */
export function parseTesters(json: string): Tester[] {
  const raw = JSON.parse(json) as Record<string, unknown>;
  const out: Tester[] = [];
  const phones = new Set<string>(); const emails = new Set<string>();
  for (const [id, value] of Object.entries(raw)) {
    if (id.startsWith('_')) continue;
    if (!MAPPABLE.test(id)) throw new Error(`${id} is not a seeded profile that can be mapped.`);
    const v = (value && typeof value === 'object') ? value as { phone?: unknown; email?: unknown }
      : (String(value ?? '').includes('@') ? { email: value } : { phone: value });
    const t: Tester = { id };
    if (v.phone !== undefined && v.phone !== '') {
      const phone = normalizePhone(v.phone);
      if (!phone) throw new Error(`${id}: not a valid Qatar mobile number.`);
      if (phones.has(phone)) throw new Error(`${id}: ${maskPhone(phone)} is used for more than one profile; use one number per profile.`);
      phones.add(phone); t.phone = phone;
    }
    if (v.email !== undefined && v.email !== '') {
      if (id.startsWith('CUS-')) throw new Error(`${id}: customers sign in with their mobile number; give a phone, not an email.`);
      const email = normalizeEmail(v.email);
      if (!email) throw new Error(`${id}: not a valid email address.`);
      if (emails.has(email)) throw new Error(`${id}: ${maskEmail(email)} is used for more than one profile; use one address per profile.`);
      emails.add(email); t.email = email;
    }
    if (!t.phone && !t.email) throw new Error(`${id}: give a phone number or an email address.`);
    out.push(t);
  }
  return out;
}

async function main(): Promise<void> {
  const env = (process.env.APP_ENV ?? 'production').toLowerCase();
  if (!['staging', 'development', 'test'].includes(env)) {
    console.error('Refusing to seed: APP_ENV must be staging (or development/test for a rehearsal).');
    process.exit(2);
  }
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is not set.'); process.exit(2); }
  try {
    console.log(`target: ${assertTargetAllowed(url, { purpose: 'staging seed' }).label}`);
  } catch (e) { console.error((e as Error).message); process.exit(2); }

  const testersFile = arg('testers');
  const testers = testersFile ? parseTesters(readFileSync(resolve(testersFile), 'utf8')) : [];

  const pool = createPool({ connectionString: url, max: 1, ...sslFromEnv(process.env, url), applicationName: 'qm-seed-staging' });
  try {
    // Never seed on top of real data.
    const vendors = (await pool.query<{ id: string; name: string }>('select id, name from public.vendors')).rows;
    const foreign = vendors.filter((v) => SEED_PARTNERS[v.id] !== v.name);
    if (foreign.length) {
      console.error(`Refusing to seed: this database already holds ${foreign.length} partner(s) that are not fictional seed data.`);
      process.exit(2);
    }
    await pool.query(readFileSync(resolve('supabase/seed/seed.sql'), 'utf8'));
    await pool.query(readFileSync(resolve('supabase/seed/staging_extra.sql'), 'utf8'));
    console.log('Fictional base + staging seed loaded.');

    for (const t of testers) {
      const table = t.id.startsWith('USR-') ? 'app_users' : 'customers';
      if (t.phone) {
        // A changed number unlinks the old Supabase Auth user; the profile links again on the next verified sign-in.
        const r = await pool.query(
          `update public.${table} set phone = $2,
                  auth_user_id = case when phone = $2 then auth_user_id else null end,
                  auth_valid_after = case when phone = $2 then auth_valid_after else now() end
            where id = $1`, [t.id, t.phone]);
        console.log(`${t.id} → ${maskPhone(t.phone)}${r.rowCount ? '' : ' (profile not found)'}`);
      }
      if (t.email) {
        // A changed address ends the profile's sessions; the tester then uses "Set or reset password",
        // which moves the Supabase Auth user to the new address with a fresh password.
        const r = await pool.query(
          `update public.app_users set email = $2,
                  auth_valid_after = case when lower(coalesce(email, '')) = $2 then auth_valid_after else now() end
            where id = $1`, [t.id, t.email]);
        console.log(`${t.id} → ${maskEmail(t.email)}${r.rowCount ? '' : ' (profile not found)'}`);
      }
    }
  } finally {
    await pool.end();
  }
}

if (isMain(import.meta.url)) {
  main().catch((err) => { console.error(`Seed failed: ${(err as Error).message}`); process.exit(1); });
}
