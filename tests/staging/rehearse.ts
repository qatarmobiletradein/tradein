/**
 * LOCAL REHEARSAL of the staging verification (npm run rehearse:staging).
 *
 * Runs tools/staging/verify-staging.ts — unchanged — against a real HTTP
 * server on 127.0.0.1 backed by a throwaway PostgreSQL 16, so the script
 * itself is proven before anyone points it at Supabase/Railway.
 *
 * What is REAL here: HTTP, Fastify, every API code path, PostgreSQL
 * transactions/constraints/locks, the migration runner, the staging seed,
 * idempotency with IDEMPOTENCY_KEY_REQUIRED=true, concurrency.
 * What is STOOD IN: Supabase Auth (tokens are minted locally with a random
 * HS256 secret), Supabase Storage (a small local HTTP object store with
 * signed URLs), the SMS provider (test provider). Direct PostgREST RLS
 * checks are SKIPPED (no PostgREST here; RLS is covered by tests/db/rls.test.ts).
 *
 * The result is a REHEARSAL, not cloud verification, and is labelled so.
 */
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { setup } from '../helpers/global-setup.js';
import { createTestApp, signToken } from '../helpers/app.js';
import { MemoryStorage } from '../../apps/api/src/lib/storage.js';
import { settleBackgroundWork } from '../../apps/api/src/services/staff-auth.js';

/** MemoryStorage reachable over HTTP with expiring signed URLs, like Supabase Storage's URL shapes. */
class LocalHttpStorage extends MemoryStorage {
  base = '';
  private readonly signatures = new Map<string, { path: string; exp: number }>();
  override async signedUrl(bucket: 'inspection-photos', path: string, ttl: number): Promise<string> {
    const token = randomBytes(16).toString('hex');
    this.signatures.set(token, { path: `${bucket}/${path}`, exp: Date.now() + ttl * 1000 });
    return `${this.base}/storage/v1/object/sign/${bucket}/${path}?token=${token}`;
  }
  override publicUrl(bucket: 'catalog-media', path: string): string {
    return `${this.base}/storage/v1/object/public/${bucket}/${path}`;
  }
  serve(): Server {
    return createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://x');
      const signed = /^\/storage\/v1\/object\/sign\/(.+)$/.exec(u.pathname);
      const pub = /^\/storage\/v1\/object\/public\/(catalog-media\/.+)$/.exec(u.pathname);
      let key = '';
      if (signed) {
        const s = this.signatures.get(u.searchParams.get('token') ?? '');
        if (s && s.exp > Date.now() && s.path === decodeURIComponent(signed[1]!)) key = s.path;
      } else if (pub) {
        key = decodeURIComponent(pub[1]!);
      }
      const obj = key ? this.objects.get(key) : undefined;
      if (!obj) { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":"not found or not public"}'); return; }
      res.writeHead(200, { 'content-type': obj.contentType });
      res.end(obj.bytes);
    });
  }
}

async function main(): Promise<void> {
  await setup();
  const storage = new LocalHttpStorage();
  const store = storage.serve();
  await new Promise<void>((r) => store.listen(0, '127.0.0.1', () => r()));
  storage.base = `http://127.0.0.1:${(store.address() as AddressInfo).port}`;

  // Production-style rules: idempotency keys required, staff sign in with email + password.
  const t = await createTestApp({ IDEMPOTENCY_KEY_REQUIRED: 'true', STAFF_SIGN_IN: 'password', LOG_LEVEL: 'silent' }, { storage });
  const dir = mkdtempSync(join(tmpdir(), 'qm-rehearsal-'));
  let exit = 1;
  try {
    // The staging seed additions, exactly as seed:staging loads them.
    await t.deps.pool.query(readFileSync(resolve('supabase/seed/staging_extra.sql'), 'utf8'));
    await t.app.listen({ host: '127.0.0.1', port: 0 });
    const api = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;

    const tokens: Record<string, string> = {};
    // Staff: the real API flow — "set or reset password" (code from the Auth stub's mailbox), which signs them in.
    for (const id of ['USR-00001', 'USR-00002', 'USR-00003', 'USR-00004', 'USR-00005', 'USR-00006', 'USR-00007', 'USR-00008', 'USR-00009']) {
      const email = `${id.toLowerCase()}@staff.example.test`;
      await t.app.inject({ method: 'POST', url: '/v1/auth/staff/reset/start', payload: { email } });
      await settleBackgroundWork();
      const code = [...t.auth.mail].reverse().find((m) => m.to === email)?.code;
      const r = await t.app.inject({ method: 'POST', url: '/v1/auth/staff/reset/finish', payload: { email, code, password: `Rehearsal-${randomBytes(6).toString('hex')}-1` } });
      const body = r.json() as { token?: string; message?: string };
      if (!body.token) throw new Error(`${id}: staff password set-up failed: ${String(body.message)}`);
      tokens[id] = body.token;
    }
    for (const id of ['CUS-00001', 'CUS-00002']) tokens[id] = await t.tokenFor(id);
    const tokensFile = join(dir, 'tokens.json');
    writeFileSync(tokensFile, JSON.stringify(tokens), { mode: 0o600 });
    const sub = (await t.deps.pool.query(`select auth_user_id from public.customers where id = 'CUS-00001'`)).rows[0].auth_user_id as string;
    const expired = await signToken(sub, '+97430000010', { iatOffsetS: -7200, expS: 60 });

    exit = await new Promise<number>((done) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'tools/staging/verify-staging.ts',
        '--api', api, '--allow-http', '--expect-environment', 'test', '--tokens', tokensFile, '--out', 'staging-reports/rehearsal'], {
        stdio: 'inherit',
        env: {
          ...process.env, STAGING_DATABASE_URL: t.deps.config.DATABASE_URL, DATABASE_SSL: 'disable', QM_EXPIRED_TOKEN: expired,
          SUPABASE_URL: '', SUPABASE_PUBLISHABLE_KEY: '', SUPABASE_ANON_KEY: '',
        },
      });
      child.on('exit', (code) => done(code ?? 1));
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await t.close();
    store.close();
  }
  console.log(`\nREHEARSAL (local stand-ins for Supabase Auth/Storage; NOT cloud verification) exit=${exit}`);
  process.exitCode = exit;
}

main().catch((e) => { console.error(`Rehearsal failed: ${(e as Error).message}`); process.exit(1); });
