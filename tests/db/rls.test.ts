/**
 * Row Level Security, exercised as the Supabase `anon` and `authenticated`
 * roles with JWT claims set exactly as PostgREST sets them. This is the
 * defence-in-depth layer for a client that bypasses the API.
 *
 * Runs on PostgreSQL 16 with tests/sql/00_supabase_shim.sql standing in for
 * Supabase's auth schema and roles. Behaviour on a live Supabase project is
 * NOT EXECUTED here (docs/TEST_RESULTS.md).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { HAS_DB } from '../helpers/db.js';
import { createTestApp, type TestApp } from '../helpers/app.js';
import { actors, submit, toReadyForCollection, type Actors } from '../helpers/flow.js';

async function as<T>(pool: pg.Pool, role: 'anon' | 'authenticated', sub: string | null, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(`set local role ${role}`);
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(sub ? { sub, role } : { role })]);
    return await fn(c);
  } finally {
    await c.query('rollback').catch(() => undefined);
    c.release();
  }
}

describe.skipIf(!HAS_DB)('row level security', () => {
  let t: TestApp; let a: Actors; const sub: Record<string, string> = {};
  let mallTradeIn = ''; let souqTradeIn = '';

  beforeAll(async () => {
    t = await createTestApp();
    a = await actors(t);
    for (const id of ['USR-00001', 'USR-00003', 'USR-00004', 'USR-00005', 'USR-00006']) {
      sub[id] = (await t.deps.pool.query('select auth_user_id from public.app_users where id = $1', [id])).rows[0].auth_user_id;
    }
    sub['CUS-00001'] = (await t.deps.pool.query(`select auth_user_id from public.customers where id = 'CUS-00001'`)).rows[0].auth_user_id;
    mallTradeIn = (await toReadyForCollection(t, a, { branchId: 'BR-0001' })).tradeInId;
    souqTradeIn = (await submit(t, a.customer, { branchId: 'BR-0002' })).tradeInId;
  });
  afterAll(async () => { await t?.close(); });

  const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

  it('anon reads the public catalogue but no trade-ins, customers, prices or audit', async () => {
    await as(t.deps.pool, 'anon', null, async (c) => {
      expect((await c.query('select id from public.products')).rowCount).toBeGreaterThan(0);
      for (const table of ['trade_ins', 'customers', 'app_users', 'master_prices', 'audit_logs', 'vouchers', 'settlements', 'idempotency_keys', 'otp_send_log', 'otp_verify_attempts', 'staff_auth_attempts']) {
        await c.query('savepoint s');
        await expect(c.query(`select 1 from public.${table} limit 1`)).rejects.toThrow(/permission denied/);
        await c.query('rollback to savepoint s');
      }
    });
  });

  it('anon sees only public partner columns — never the fee rate', async () => {
    await as(t.deps.pool, 'anon', null, async (c) => {
      expect((await c.query('select id, name, code from public.vendors')).rowCount).toBeGreaterThan(0);
      await expect(c.query('select default_commission_rate from public.vendors')).rejects.toThrow(/permission denied/);
    });
  });

  it('branch user sees own-branch trade-ins only', async () => {
    const mall = await as(t.deps.pool, 'authenticated', sub['USR-00005']!, async (c) => ids((await c.query('select id from public.trade_ins')).rows));
    expect(mall).toContain(mallTradeIn);
    expect(mall).not.toContain(souqTradeIn);
    const souq = await as(t.deps.pool, 'authenticated', sub['USR-00006']!, async (c) => ids((await c.query('select id from public.trade_ins')).rows));
    expect(souq).toContain(souqTradeIn);
    expect(souq).not.toContain(mallTradeIn);
    // Asking for the other branch by id returns nothing (no error, no row).
    const probe = await as(t.deps.pool, 'authenticated', sub['USR-00006']!, async (c) => (await c.query('select id from public.trade_ins where branch_id = $1', ['BR-0001'])).rowCount);
    expect(probe).toBe(0);
  });

  it('partner-wide user sees both branches; customers see only their own', async () => {
    const pw = await as(t.deps.pool, 'authenticated', sub['USR-00004']!, async (c) => ids((await c.query('select id from public.trade_ins')).rows));
    expect(pw).toEqual(expect.arrayContaining([mallTradeIn, souqTradeIn]));
    const cust = await as(t.deps.pool, 'authenticated', sub['CUS-00001']!, async (c) => (await c.query('select id, customer_id from public.trade_ins')).rows);
    for (const r of cust) expect(r.customer_id).toBe('CUS-00001');
  });

  it('nobody signed in can read the submitted IMEI or the partner fee columns directly', async () => {
    for (const who of ['USR-00001', 'USR-00003', 'USR-00004', 'CUS-00001']) {
      await as(t.deps.pool, 'authenticated', sub[who]!, async (c) => {
        await c.query('savepoint s');
        await expect(c.query('select imei from public.trade_ins')).rejects.toThrow(/permission denied/);
        await c.query('rollback to savepoint s');
        await expect(c.query('select commission_value from public.trade_ins')).rejects.toThrow(/permission denied/);
      });
    }
  });

  it('technicians see trade-in work but not money tables, customers or vouchers', async () => {
    await as(t.deps.pool, 'authenticated', sub['USR-00003']!, async (c) => {
      expect((await c.query('select id from public.trade_ins')).rowCount).toBeGreaterThan(0);
      expect((await c.query('select id from public.vouchers')).rowCount).toBe(0);
      expect((await c.query('select id from public.settlements')).rowCount).toBe(0);
      expect((await c.query('select id from public.customers')).rowCount).toBe(0);
      expect((await c.query('select id from public.inspection_rules')).rowCount).toBe(0);
    });
  });

  it('finance tables mirror the API: branch staff see no settlements, partners see no collection notes, no partner terms', async () => {
    // Put a settlement and a collection note in place for the Mall branch.
    const batch = await t.call('admin.createBatch', a.finance, { vendorId: 'VND-001', branchId: 'BR-0001' }, 'rls-batch-key-000001');
    await t.call('admin.updateBatch', a.finance, { batchId: batch.body.batchId, action: 'COLLECT' }, 'rls-collect-key-00001');
    const st = await t.call('admin.createSettlement', a.finance, { vendorId: 'VND-001', from: '2026-01-01', to: '2030-12-31' }, 'rls-settle-key-000001');
    expect(st.body.ok).toBe(true);
    await as(t.deps.pool, 'authenticated', sub['USR-00004']!, async (c) => {   // partner admin
      expect((await c.query('select id from public.settlements')).rowCount).toBe(1);
      expect((await c.query('select id from public.collections')).rowCount).toBe(0);
      expect((await c.query('select id from public.collection_items')).rowCount).toBe(0);
      await expect(c.query('select settlement_terms from public.vendors')).rejects.toThrow(/permission denied/);
    });
    await as(t.deps.pool, 'authenticated', sub['USR-00005']!, async (c) => {   // VENDOR_MANAGER @ Mall
      expect((await c.query('select id from public.settlements')).rowCount).toBe(1);
    });
    // VENDOR_STAFF in the SAME branch as the settled device: still nothing (the API gives staff no settlements).
    await t.deps.pool.query(`insert into public.app_users (id, full_name, phone, role, vendor_id, branch_id, status)
      values ('USR-00090', 'Demo Mall Staff', '+97430000090', 'VENDOR_STAFF', 'VND-001', 'BR-0001', 'ACTIVE')`);
    await t.tokenFor('USR-00090');
    const staffSub = (await t.deps.pool.query(`select auth_user_id from public.app_users where id = 'USR-00090'`)).rows[0].auth_user_id;
    await as(t.deps.pool, 'authenticated', staffSub, async (c) => {
      expect((await c.query('select id from public.settlements')).rowCount).toBe(0);
      expect((await c.query('select id, name from public.vendors')).rowCount).toBe(1);
    });
    await as(t.deps.pool, 'authenticated', sub['USR-00001']!, async (c) => {   // platform owner
      expect((await c.query('select id from public.collections')).rowCount).toBe(1);
    });
  });

  it('nobody signed in can write anything directly', async () => {
    for (const who of ['USR-00001', 'USR-00004', 'CUS-00001']) {
      await as(t.deps.pool, 'authenticated', sub[who]!, async (c) => {
        await c.query('savepoint s');
        await expect(c.query(`update public.trade_ins set status = 'CLOSED' where id = $1`, [mallTradeIn])).rejects.toThrow(/permission denied/);
        await c.query('rollback to savepoint s');
        await expect(c.query(`insert into public.audit_logs (action) values ('FORGED')`)).rejects.toThrow(/permission denied/);
      });
    }
  });

  it('private evidence photos cannot be listed or read through storage policies', async () => {
    await t.deps.pool.query(`insert into storage.objects (bucket_id, name) values ('inspection-photos', 'TI-DEMO-000001/front/x.png'), ('catalog-media', 'products/x.png')`);
    for (const role of ['anon', 'authenticated'] as const) {
      const rows = await as(t.deps.pool, role, role === 'authenticated' ? sub['USR-00001']! : null, async (c) => (await c.query('select bucket_id, name from storage.objects')).rows);
      expect(rows.map((r) => r.bucket_id)).not.toContain('inspection-photos');
      expect(rows.map((r) => r.bucket_id)).toContain('catalog-media');
    }
  });

  it('a disabled or pending account gets nothing even with a valid JWT', async () => {
    await t.deps.pool.query(`update public.app_users set status = 'DISABLED' where id = 'USR-00006'`);
    const n = await as(t.deps.pool, 'authenticated', sub['USR-00006']!, async (c) => (await c.query('select id from public.trade_ins')).rowCount);
    expect(n).toBe(0);
    await t.deps.pool.query(`update public.app_users set status = 'ACTIVE' where id = 'USR-00006'`);
  });

  it('internal tables and the counter function are invisible to clients', async () => {
    await as(t.deps.pool, 'authenticated', sub['USR-00001']!, async (c) => {
      await expect(c.query(`select app.next_counter('VCH', 0)`)).rejects.toThrow(/permission denied/);
    });
  });
});
