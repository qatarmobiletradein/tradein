/**
 * Staging-readiness behaviour that needs PostgreSQL: idempotency keys
 * required, the migration ledger, fail-closed default privileges, and the
 * operator commands' safety guards.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HAS_DB, freshDatabase } from '../helpers/db.js';
import { createTestApp, type TestApp } from '../helpers/app.js';
import { actors, type Actors } from '../helpers/flow.js';
import { createPool } from '../../packages/database/src/db.js';
import { migrate } from '../../packages/database/src/migrate.js';

const PROTECTED: [string, string, Record<string, unknown>][] = [
  ['customer.submitTradeIn', 'customer', { vendorId: 'VND-001', branchId: 'BR-0001', variantId: 'VAR-000001', imei: '356938035643809', conditionAnswers: {} }],
  ['customer.acceptOffer', 'customer', { tradeInId: 'TI-DEMO-000001' }],
  ['customer.declineOffer', 'customer', { tradeInId: 'TI-DEMO-000001' }],
  ['tech.complete', 'tech', { tradeInId: 'TI-DEMO-000001' }],
  ['tech.submitOffer', 'tech', { tradeInId: 'TI-DEMO-000001' }],
  ['tech.receiveDevice', 'tech', { tradeInId: 'TI-DEMO-000001' }],
  ['tech.returnDevice', 'tech', { tradeInId: 'TI-DEMO-000001' }],
  ['vendor.issueVoucher', 'mgrMall', { tradeInId: 'TI-DEMO-000001' }],
  ['vendor.voidVoucher', 'mgrMall', { voucherId: 'VCH-000001', reason: 'x' }],
  ['vendor.saveStaff', 'partnerAdmin', { mode: 'CREATE', phone: '33000071', fullName: 'Nobody Demo', role: 'VENDOR_STAFF' }],
  ['admin.overridePrice', 'finance', { tradeInId: 'TI-DEMO-000001', manualAdjustment: 1 }],
  ['admin.overrideGrade', 'finance', { tradeInId: 'TI-DEMO-000001', gradeCode: 'B' }],
  ['admin.approveStaff', 'finance', { userId: 'USR-00090', role: 'TECHNICIAN' }],
  ['admin.updateStaff', 'finance', { userId: 'USR-00003', status: 'DISABLED' }],
  ['admin.createBatch', 'finance', { vendorId: 'VND-001' }],
  ['admin.updateBatch', 'finance', { batchId: 'BAT-00001', action: 'COLLECT' }],
  ['admin.createSettlement', 'finance', { vendorId: 'VND-001', from: '2026-01-01', to: '2030-12-31' }],
  ['admin.advanceSettlement', 'sa', { settlementId: 'STL-00001', toStatus: 'APPROVED' }],
];

describe.skipIf(!HAS_DB)('staging readiness', () => {
  let t: TestApp; let a: Actors;
  beforeAll(async () => { t = await createTestApp({ IDEMPOTENCY_KEY_REQUIRED: 'true' }); a = await actors(t); });
  afterAll(async () => { await t?.close(); });

  it('with IDEMPOTENCY_KEY_REQUIRED every money/custody write without a key is refused (428) and writes nothing', async () => {
    const count = async () => (await t.deps.pool.query(`select (select count(*) from public.trade_ins) + (select count(*) from public.idempotency_keys)
      + (select count(*) from public.audit_logs where action <> 'ACCESS_DENIED') as n`)).rows[0].n;
    const before = await count();
    for (const [action, who, params] of PROTECTED) {
      const r = await t.call(action, a[who as keyof Actors], params);
      expect([action, r.status, r.body.code]).toEqual([action, 428, 'IDEMPOTENCY_KEY_REQUIRED']);
    }
    expect(await count()).toBe(before);
    // Reads never need a key.
    expect((await t.call('customer.myTradeIns', a.customer, {})).status).toBe(200);
    expect((await t.call('admin.settlements', a.finance, {})).status).toBe(200);
    expect((await t.call('vendor.queue', a.mgrMall, {})).status).toBe(200);
  });

  it('the registry marks exactly the actions the 3.1 client sends keys for', async () => {
    const { REGISTRY } = await import('../../apps/api/src/registry.js');
    const idem = Object.entries(REGISTRY).filter(([, d]) => (d as { idem?: unknown }).idem).map(([k]) => k).sort();
    expect(idem).toEqual(PROTECTED.map(([k]) => k).sort());
  });

  it('migration ledger: every migration recorded with a checksum; a re-run applies nothing; an edited file is refused', async () => {
    const rows = (await t.deps.pool.query(`select version, checksum from app.schema_migrations order by version`)).rows;
    expect(rows.length).toBe(12);
    const pool = createPool({ connectionString: t.deps.config.DATABASE_URL, max: 1, ssl: 'disable' });
    try {
      const again = await migrate(pool, resolve('supabase/migrations'), () => undefined);
      expect(again.applied).toEqual([]);
      const dir = mkdtempSync(join(tmpdir(), 'qm-mig-'));
      writeFileSync(join(dir, '20261008000100_core_schema.sql'), '-- edited\n');
      await expect(migrate(pool, dir, () => undefined)).rejects.toThrow(/has since been modified/);
      rmSync(dir, { recursive: true, force: true });
    } finally { await pool.end(); }
  });

  it('a table added by a future migration starts with NO client access (default privileges revoked)', async () => {
    await t.deps.pool.query('create table public.zz_future_probe (id int primary key)');
    const r = (await t.deps.pool.query(`select has_table_privilege('anon', 'public.zz_future_probe', 'select') as anon_sel,
      has_table_privilege('authenticated', 'public.zz_future_probe', 'insert') as auth_ins,
      has_table_privilege('service_role', 'public.zz_future_probe', 'select') as svc`)).rows[0];
    expect(r).toEqual({ anon_sel: false, auth_ins: false, svc: true });
    const v = (await t.deps.pool.query(`select has_table_privilege('anon', 'public.settlement_lines', 'select') as a`)).rows[0];
    expect(v.a).toBe(false);
    await t.deps.pool.query('drop table public.zz_future_probe');
    // A future function is not callable by clients either (PUBLIC's default EXECUTE removed).
    await t.deps.pool.query('create function public.zz_future_fn() returns int language sql as $$ select 1 $$');
    const f = (await t.deps.pool.query(`select has_function_privilege('anon', 'public.zz_future_fn()', 'execute') as anon_x,
      has_function_privilege('authenticated', 'public.zz_future_fn()', 'execute') as auth_x`)).rows[0];
    expect(f).toEqual({ anon_x: false, auth_x: false });
    await t.deps.pool.query('drop function public.zz_future_fn()');
  });

  it('no sequence in schema public is usable by anon or authenticated (0900; found on Supabase Cloud)', async () => {
    const r = (await t.deps.pool.query(`select c.relname from pg_class c
      where c.relnamespace = 'public'::regnamespace and c.relkind = 'S'
        and (has_sequence_privilege('anon', c.oid, 'usage,select,update') or has_sequence_privilege('authenticated', c.oid, 'usage,select,update'))`)).rows;
    expect(r).toEqual([]);
  });

  it('API runtime role qm_api (1100): reads/writes app data, cannot change the schema, has no login of its own', async () => {
    const role = (await t.deps.pool.query(`select rolcanlogin, rolbypassrls, rolsuper, rolcreaterole, rolcreatedb, rolinherit
      from pg_roles where rolname = 'qm_api'`)).rows[0];
    expect(role).toEqual({ rolcanlogin: false, rolbypassrls: true, rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolinherit: false });
    const p = (await t.deps.pool.query(`select
        has_table_privilege('qm_api', 'public.trade_ins', 'select,insert,update,delete') as dml,
        has_table_privilege('qm_api', 'public.trade_ins', 'truncate') as trunc,
        has_table_privilege('qm_api', 'app.schema_migrations', 'select,insert') as ledger,
        has_schema_privilege('qm_api', 'public', 'create') as ddl_public,
        has_function_privilege('qm_api', 'app.next_counter(text, bigint)', 'execute') as fn,
        has_table_privilege('qm_api', 'auth.users', 'select') as auth_read,
        has_table_privilege('qm_api', 'auth.users', 'update') as auth_write,
        exists (select 1 from pg_class where relowner = 'qm_api'::regrole) as owns_anything`)).rows[0];
    expect(p).toEqual({ dml: true, trunc: false, ledger: true, ddl_public: false, fn: true, auth_read: true, auth_write: false, owns_anything: false });
    // A table added later by the owner is usable by the API without another grant.
    await t.deps.pool.query('create table public.zz_role_probe (id int primary key)');
    const f = (await t.deps.pool.query(`select has_table_privilege('qm_api', 'public.zz_role_probe', 'insert') as ok`)).rows[0];
    await t.deps.pool.query('drop table public.zz_role_probe');
    expect(f.ok).toBe(true);
  });
});

describe.skipIf(!HAS_DB)('Send SMS hook resilience', () => {
  it('a database failure during delivery is still a well-formed refusal (HTTP 200 + error), never a 5xx', async () => {
    const t = await createTestApp();
    const real = t.deps.pool;
    try {
      const { signWebhook } = await import('../../apps/api/src/lib/webhooks.js');
      const { HOOK_SECRET } = await import('../helpers/app.js');
      t.deps.pool = createPool({ connectionString: 'postgres://nobody@127.0.0.1:1/none', max: 1, ssl: 'disable' });
      const body = JSON.stringify({ user: { phone: '97430000010' }, sms: { otp: '123456' } });
      const id = 'msg_res'; const ts = String(Math.floor(Date.now() / 1000));
      const r = await t.app.inject({ method: 'POST', url: '/v1/hooks/send-sms', payload: body,
        headers: { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': signWebhook(HOOK_SECRET, id, ts, body) } });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ error: { http_code: 503, message: expect.stringMatching(/temporarily unavailable/) } });
      expect(t.sms.lastCodeFor('+97430000010')).toBeNull();
    } finally {
      await t.deps.pool.end().catch(() => undefined);
      t.deps.pool = real;
      await t.close();
    }
  });
});

describe.skipIf(!HAS_DB)('operator command guards', () => {
  const run = (script: string, env: Record<string, string>, args: string[] = []) =>
    spawnSync(process.execPath, ['--import', 'tsx', script, ...args], { env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8', timeout: 60_000 });

  it('migrate refuses a remote target without confirmation, a protected target, and the transaction pooler — before connecting', () => {
    const url = 'postgresql://postgres.abcdefghijklmnopqrst:pw@aws-0-x.pooler.supabase.com:5432/postgres';
    const r1 = run('packages/database/src/migrate-cli.ts', { DATABASE_URL: url });
    expect(r1.status).toBe(2);
    expect(r1.stderr).toMatch(/MIGRATION_TARGET_CONFIRM=abcdefghijklmnopqrst/);
    expect(r1.stderr + r1.stdout).not.toContain(':pw@');
    const r2 = run('packages/database/src/migrate-cli.ts', { DATABASE_URL: url, MIGRATION_TARGET_CONFIRM: 'abcdefghijklmnopqrst', QM_PROTECTED_TARGETS: 'abcdefghijklmnopqrst' });
    expect(r2.status).toBe(2);
    expect(r2.stderr).toMatch(/production is out of scope/);
    const r3 = run('packages/database/src/migrate-cli.ts', { DATABASE_URL: url.replace(':5432', ':6543'), MIGRATION_TARGET_CONFIRM: 'abcdefghijklmnopqrst' });
    expect(r3.stderr).toMatch(/TRANSACTION pooler/);
  });

  it('seed:staging refuses production, refuses real-looking data, and maps tester numbers (masked in output)', async () => {
    const db = await freshDatabase();
    const dir = mkdtempSync(join(tmpdir(), 'qm-seed-'));
    try {
      expect(run('packages/database/src/seed-staging-cli.ts', { DATABASE_URL: db.url, APP_ENV: 'production' }).status).toBe(2);
      const testers = join(dir, 'testers.json');
      writeFileSync(testers, JSON.stringify({ 'USR-00003': '55112233', 'CUS-00002': '66112233' }));
      const ok = run('packages/database/src/seed-staging-cli.ts', { DATABASE_URL: db.url, APP_ENV: 'test', DATABASE_SSL: 'disable' }, ['--testers', testers]);
      expect(ok.status, ok.stderr).toBe(0);
      expect(ok.stdout).toContain('USR-00003 →');
      expect(ok.stdout).not.toContain('55112233');
      const pool = createPool({ connectionString: db.url, max: 1, ssl: 'disable' });
      try {
        expect((await pool.query(`select phone from public.app_users where id = 'USR-00003'`)).rows[0].phone).toBe('+97455112233');
        expect((await pool.query(`select count(*)::int as n from public.vendors`)).rows[0].n).toBe(2);
        expect((await pool.query(`select value from public.settings where key = 'environment.marker'`)).rows[0].value).toBe('STAGING-FICTIONAL');
        // Re-running is safe.
        expect(run('packages/database/src/seed-staging-cli.ts', { DATABASE_URL: db.url, APP_ENV: 'test', DATABASE_SSL: 'disable' }).status).toBe(0);
        // A database holding a non-seed partner is refused.
        await pool.query(`insert into public.vendors (id, name, code) values ('VND-777', 'A Real Partner', 'REAL')`);
        const refused = run('packages/database/src/seed-staging-cli.ts', { DATABASE_URL: db.url, APP_ENV: 'test', DATABASE_SSL: 'disable' });
        expect(refused.status).toBe(2);
        expect(refused.stderr).toMatch(/not fictional seed data/);
      } finally { await pool.end(); }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await db.drop();
    }
  });
});
