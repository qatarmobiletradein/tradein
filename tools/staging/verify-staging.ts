/**
 * Staging verification — runs REAL requests against a deployed STAGING API
 * (and, optionally, Supabase REST/Storage and the staging database,
 * read-only), and writes an honest PASS / FAIL / SKIPPED report.
 *
 *   npm run verify:staging -- --api https://<staging-api> --login --testers staging-testers.json
 *   npm run verify:staging -- --api https://<staging-api> --tokens staging-tokens.json
 *
 * Options
 *   --api <url>                 staging API base URL (https required unless --allow-http)
 *   --login                     interactive sign-in: sends a real SMS code to each tester
 *                               number in --testers and asks you to type it
 *   --testers <file>            profile → tester phone map (git-ignored; see staging-testers.example.json)
 *   --tokens <file>             profile → access token map (alternative to --login; SECRET file)
 *   --expect-environment <env>  what /ready must report (default: staging)
 *   --only <groups>             comma list: platform,auth,idempotency,flow,negative,concurrency,rls,storage,db
 *   --out <dir>                 report directory (default: ./staging-reports)
 *   --allow-http                allow http:// (local rehearsal only)
 *
 * Environment (all optional)
 *   SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY (or SUPABASE_ANON_KEY)   → direct-access RLS and Storage checks
 *   STAGING_DATABASE_URL (+ DATABASE_SSL, DATABASE_SSL_CA)          → read-only consistency checks
 *   QM_EXPIRED_TOKEN                                               → an access token that has expired
 *   QM_PROTECTED_TARGETS                                           → refs/hosts that must never be touched
 *
 * Safety
 *   - Refuses unless /ready reports the expected environment (staging).
 *   - The database connection is READ ONLY and refused unless the database
 *     carries the fictional staging marker (settings: environment.marker).
 *   - Creates fictional records only (test IMEIs prefixed 99, demo partner).
 *   - Never prints tokens, phone numbers, codes or keys.
 */
import { createInterface } from 'node:readline/promises';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { createPool } from '../../packages/database/src/db.js';
import { describeTarget, isProtected, sslFromEnv, supabaseRefOf } from '../../packages/database/src/target.js';
import { parseTesters, type Tester } from '../../packages/database/src/seed-staging-cli.js';
import { maskEmail, maskPhone } from '../../packages/shared/src/text.js';
import { invariantIssues } from '../../apps/api/src/jobs/reconcile.js';
import {
  Api, PNG_1x1, Report, SVG_AS_PNG, Skip, Supa, expect, expectStatus, find, idemKey, leaksSecrets, ok, peekJwt, skip, testImei,
  type Json, type Res,
} from './lib.js';

// ----------------------------------------------------------------- setup
const PROFILES: Record<string, { role: string; vendorId?: string; branchId?: string; label: string }> = {
  'USR-00001': { role: 'SUPER_ADMIN', label: 'platform owner' },
  'USR-00002': { role: 'QM_ADMIN', label: 'finance (QM admin)' },
  'USR-00003': { role: 'TECHNICIAN', label: 'technician' },
  'USR-00004': { role: 'VENDOR_ADMIN', vendorId: 'VND-001', label: 'partner-wide admin (VND-001)' },
  'USR-00005': { role: 'VENDOR_MANAGER', vendorId: 'VND-001', branchId: 'BR-0001', label: 'branch manager (BR-0001)' },
  'USR-00006': { role: 'VENDOR_STAFF', vendorId: 'VND-001', branchId: 'BR-0002', label: 'branch staff (BR-0002)' },
  'USR-00007': { role: 'QM_ADMIN', label: 'QM operations admin' },
  'USR-00008': { role: 'VENDOR_STAFF', vendorId: 'VND-001', branchId: 'BR-0001', label: 'branch staff (BR-0001)' },
  'USR-00009': { role: 'VENDOR_ADMIN', vendorId: 'VND-002', label: 'second partner admin (VND-002)' },
  'CUS-00001': { role: 'CUSTOMER', label: 'customer' },
  'CUS-00002': { role: 'CUSTOMER', label: 'second customer' },
};
const GOOD_ANSWERS = { POWER: 'ON', SCREEN: 'PERFECT', BODY: 'EXCELLENT', CAMERA: 'OK', CHARGING: 'OK', BIOMETRIC: 'OK', BATTERY: 'GOOD', ACTIVATION_LOCK: 'YES' };
const ALL_GOOD_TECH: Record<string, boolean> = Object.fromEntries([
  'ACTIVATION_LOCK', 'SCREEN_WORKS', 'SCREEN_CRACK', 'SCREEN_SCRATCH', 'BODY_INTACT', 'BODY_DENT', 'BODY_SCRATCH', 'BACK_GLASS',
  'DEVICE_POWERS_ON', 'CAMERA_WORKS', 'BIOMETRIC_WORKS', 'SPEAKER_WORKS', 'MIC_WORKS', 'BUTTONS_WORK', 'CHARGING_WORKS', 'WIFI_WORKS', 'BLUETOOTH_WORKS',
].map((k) => [k, true]));
const ALL_GROUPS = ['platform', 'auth', 'idempotency', 'flow', 'negative', 'concurrency', 'rls', 'storage', 'db'];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

/** Qatar business date (yyyy-MM-dd) — settlement periods are business days. */
const qatarDate = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Qatar', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const cents = (v: unknown) => Math.round(Number(v) * 100);

async function main(): Promise<void> {
  const base = String(arg('api') ?? process.env.STAGING_API_URL ?? '').replace(/\/+$/, '');
  if (!base) { console.error('Set --api <staging API URL>.'); process.exit(2); }
  if (!/^https:\/\//.test(base) && !(flag('allow-http') && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base))) {
    console.error('The API URL must be https:// (http://localhost only with --allow-http for a local rehearsal).');
    process.exit(2);
  }
  const expectedEnv = arg('expect-environment') ?? 'staging';
  if (!['staging', 'test', 'development'].includes(expectedEnv)) {
    console.error('Refusing: this verification creates records and only runs against staging (or a local test/development rehearsal).');
    process.exit(2);
  }
  const protectedHosts = [base, process.env.SUPABASE_URL ?? ''].filter(Boolean).map((u) => { try { return new URL(u).hostname; } catch { return ''; } });
  for (const h of protectedHosts) {
    if (isProtected({ projectRef: supabaseRefOf(`https://${h}`), host: h })) { console.error(`Refusing: ${h} is listed in QM_PROTECTED_TARGETS.`); process.exit(2); }
  }
  const groups = new Set((arg('only') ?? ALL_GROUPS.join(',')).split(',').map((x) => x.trim()).filter(Boolean));
  const api = new Api(base);

  // Refuse anything that is not the expected environment BEFORE creating data.
  const ready = await api.raw('GET', '/ready').catch((e: Error) => { console.error(`Cannot reach ${base}/ready: ${e.message}`); process.exit(2); });
  if (ready.body.environment !== expectedEnv) {
    console.error(`Refusing: /ready reports environment "${String(ready.body.environment ?? 'unknown')}", expected "${expectedEnv}".`);
    process.exit(2);
  }

  const staffSignIn = String((ready.body.checks as Json | undefined)?.staffSignIn ?? 'phone');
  const testersFile = arg('testers');
  const testers = testersFile ? parseTesters(readFileSync(resolve(testersFile), 'utf8')) : [];
  const tokens = await obtainTokens(api, staffSignIn, testers);
  const supaUrl = process.env.SUPABASE_URL?.replace(/\/+$/, '');
  const supaKey = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
  const supa = supaUrl && supaKey ? new Supa(supaUrl, supaKey) : null;
  const db = await openReadOnlyDb();

  const report = new Report({
    api: base, environment: expectedEnv, startedAt: new Date().toISOString(),
    signedInProfiles: Object.keys(tokens).sort().join(', ') || '(none)',
    supabaseDirectChecks: supa ? 'enabled' : 'not configured (SKIPPED)',
    databaseChecks: db ? `read-only: ${db.label}` : 'not configured (SKIPPED)',
  });
  const T = (id: string) => tokens[id] ?? skip(`no token for ${id} (${PROFILES[id]?.label ?? id})`);
  const ctx: Ctx = { api, supa, db: db?.pool ?? null, report, T, tokens, staffSignIn, testers };

  try {
    if (groups.has('platform')) await platform(ctx, ready);
    if (groups.has('auth')) await auth(ctx);
    if (groups.has('idempotency')) await idempotency(ctx);
    if (groups.has('flow')) await flow(ctx);
    if (groups.has('negative')) await negative(ctx);
    if (groups.has('concurrency')) await concurrency(ctx);
    if (groups.has('rls')) await rls(ctx);
    if (groups.has('storage')) await storage(ctx);
    if (groups.has('db')) await dbChecks(ctx);
  } finally {
    await db?.pool.end();
  }

  const files = report.write(arg('out') ?? 'staging-reports');
  const c = report.counts();
  console.log(`\nPASS ${c.PASS} · FAIL ${c.FAIL} · SKIPPED ${c.SKIPPED}\nReport: ${files.md}`);
  process.exitCode = c.FAIL ? 1 : 0;
}

interface Ctx {
  api: Api; supa: Supa | null; db: ReadOnlyDb | null; report: Report; T: (id: string) => string; tokens: Record<string, string>;
  staffSignIn: string; testers: Tester[];
}

// ----------------------------------------------------------------- tokens
async function ask(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(q)).trim(); } finally { rl.close(); }
}
/** A prompt that does not echo what is typed (passwords). Falls back to a plain prompt when stdin is not a terminal. */
async function askHidden(q: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return ask(q);
  process.stdout.write(q);
  return new Promise((done) => {
    let value = '';
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); process.stdout.write('\n'); done(value); return;
        }
        if (ch === '\u0003') { stdin.setRawMode(false); process.stdout.write('\n'); process.exit(130); }
        if (ch === '\u007f' || ch === '\b') { value = value.slice(0, -1); continue; }
        value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

/** Staff with STAFF_SIGN_IN=password: password, or "reset" → e-mailed code + new password. */
async function staffPasswordSignIn(api: Api, id: string, email: string): Promise<string | null> {
  const label = `${id} (${PROFILES[id]?.label}) ${maskEmail(email)}`;
  const pw = await askHidden(`  Password for ${label} — blank = skip, "reset" = email me a code: `);
  if (!pw) return null;
  if (pw.toLowerCase() !== 'reset') {
    const r = await api.raw('POST', '/v1/auth/staff/login', { body: { email, password: pw } });
    if (r.status === 200 && typeof r.body.token === 'string') return r.body.token;
    console.log(`  ${id}: sign-in refused (${r.status} ${String(r.body.message ?? '')}).`);
    return null;
  }
  const s = await api.raw('POST', '/v1/auth/staff/reset/start', { body: { email } });
  if (s.status !== 200) { console.log(`  ${id}: could not send a code (${s.status} ${String(s.body.message ?? '')}).`); return null; }
  const code = await ask(`  Code e-mailed to ${maskEmail(email)} (blank = skip): `);
  if (!code) return null;
  const p1 = await askHidden('  New password (12+ characters, letters and a number): ');
  const p2 = await askHidden('  Repeat the new password: ');
  if (!p1 || p1 !== p2) { console.log(`  ${id}: the passwords were empty or not the same — skipped.`); return null; }
  const f = await api.raw('POST', '/v1/auth/staff/reset/finish', { body: { email, code, password: p1 } });
  if (f.status === 200 && typeof f.body.token === 'string') return f.body.token;
  console.log(`  ${id}: ${f.status} ${String(f.body.message ?? '')}`);
  return null;
}

async function obtainTokens(api: Api, staffSignIn: string, testers: Tester[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const file = arg('tokens');
  if (file) {
    const raw = JSON.parse(readFileSync(resolve(file), 'utf8')) as Record<string, unknown>;
    for (const [id, t] of Object.entries(raw)) if (PROFILES[id] && typeof t === 'string' && t) out[id] = t;
  }
  if (flag('login')) {
    if (!testers.length) { console.error('--login needs --testers <file>.'); process.exit(2); }
    for (const t of testers) {
      if (out[t.id]) continue;
      if (t.id.startsWith('USR-') && staffSignIn === 'password') {
        if (!t.email) { console.log(`  ${t.id}: staff sign in by email here; no email in the testers file — SKIPPED.`); continue; }
        const tok = await staffPasswordSignIn(api, t.id, t.email);
        if (tok) out[t.id] = tok;
        continue;
      }
      if (!t.phone) { console.log(`  ${t.id}: no phone number in the testers file — SKIPPED.`); continue; }
      const start = await api.raw('POST', '/v1/auth/start', { body: { phone: t.phone } });
      if (start.status !== 200 || start.body.ok !== true) {
        console.log(`  ${t.id}: could not send a code (${start.status} ${String(start.body.message ?? '')}) — its checks will be SKIPPED.`);
        continue;
      }
      const code = await ask(`  Code sent to ${maskPhone(t.phone)} for ${t.id} (${PROFILES[t.id]?.label}). Type it (blank = skip): `);
      if (!code) continue;
      const v = await api.raw('POST', '/v1/auth/verify', { body: { phone: t.phone, code } });
      if (v.status === 200 && typeof v.body.token === 'string') out[t.id] = v.body.token;
      else console.log(`  ${t.id}: sign-in refused (${v.status} ${String(v.body.message ?? '')}).`);
    }
  }
  return out;
}

async function openReadOnlyDb(): Promise<{ pool: ReadOnlyDb; label: string } | null> {
  const url = process.env.STAGING_DATABASE_URL;
  if (!url) return null;
  const t = describeTarget(url); // refuses URLs whose parameters could redirect the connection
  if (isProtected(t)) {
    console.error('Refusing: STAGING_DATABASE_URL points at a protected (production) target.');
    process.exit(2);
  }
  const supa = supabaseRefOf(process.env.SUPABASE_URL);
  if (supa && t.projectRef && supa !== t.projectRef) {
    console.error(`Refusing: SUPABASE_URL is project ${supa} but STAGING_DATABASE_URL is project ${t.projectRef}.`);
    process.exit(2);
  }
  if (t.mode === 'supabase-transaction-pooler') {
    console.error('Use the session pooler (5432) or a direct connection for STAGING_DATABASE_URL, not the transaction pooler.');
    process.exit(2);
  }
  const raw = createPool({ connectionString: url, max: 2, ...sslFromEnv(process.env, url), applicationName: 'qm-verify-readonly' });
  // EVERY query runs inside an explicit READ ONLY transaction — this holds through any pooler,
  // whatever the connection's defaults are.
  const pool = new ReadOnlyDb(raw);
  const marker = await pool.query<{ value: string }>(`select value from public.settings where key = 'environment.marker'`).catch(() => ({ rows: [] as { value: string }[] }));
  if (marker.rows[0]?.value !== 'STAGING-FICTIONAL') {
    await pool.end();
    console.error('Refusing: this database has no STAGING-FICTIONAL marker (run npm run seed:staging on staging first).');
    process.exit(2);
  }
  return { pool, label: t.label };
}

/** A query interface that can only read: each call is BEGIN READ ONLY … COMMIT on its own client. */
class ReadOnlyDb {
  constructor(private readonly pool: pg.Pool) {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async query<R extends pg.QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<pg.QueryResult<R>> {
    const c = await this.pool.connect();
    try {
      await c.query('begin transaction read only');
      const r = await c.query<R>(sql, params);
      await c.query('commit');
      return r;
    } catch (e) {
      await c.query('rollback').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }
  end() { return this.pool.end(); }
}

// ----------------------------------------------------------------- flow helpers
async function submit(c: Ctx, customer: string, branchId = 'BR-0001', imei = testImei(), vendorId = 'VND-001') {
  const body = ok(await c.api.call('customer.submitTradeIn', customer, {
    vendorId, branchId, variantId: 'VAR-000001', colorId: 'CLR-000001', imei, conditionAnswers: GOOD_ANSWERS,
  }, idemKey()), 'submit trade-in');
  return { tradeInId: String(body.tradeInId), imei };
}
async function offer(c: Ctx, tradeInId: string, imei: string) {
  const tech = c.T('USR-00003');
  ok(await c.api.call('tech.openInspection', tech, { tradeInId }), 'open inspection');
  const chk = ok(await c.api.call('tech.checkImei', tech, { tradeInId, scannedImei: imei }), 'check IMEI');
  expect(chk.match === true, 'IMEI check did not match');
  ok(await c.api.call('tech.saveInspection', tech, { tradeInId, answers: ALL_GOOD_TECH, batteryHealth: 95 }), 'save inspection');
  return ok(await c.api.call('tech.submitOffer', tech, { tradeInId }, idemKey()), 'submit offer');
}
async function accepted(c: Ctx, branchId = 'BR-0001') {
  const s = await submit(c, c.T('CUS-00001'), branchId);
  await offer(c, s.tradeInId, s.imei);
  ok(await c.api.call('customer.acceptOffer', c.T('CUS-00001'), { tradeInId: s.tradeInId }, idemKey()), 'accept offer');
  return s;
}
async function received(c: Ctx, branchId = 'BR-0001') {
  const s = await accepted(c, branchId);
  ok(await c.api.call('tech.receiveDevice', c.T('USR-00003'), { tradeInId: s.tradeInId }, idemKey()), 'receive device');
  return s;
}
/** Issuer for BR-0001: the branch manager if signed in, else the partner admin. */
const issuer = (c: Ctx) => c.tokens['USR-00005'] ?? c.tokens['USR-00004'] ?? c.T('USR-00005');
async function vouchered(c: Ctx) {
  const s = await received(c);
  const v = ok(await c.api.call('vendor.issueVoucher', issuer(c), { tradeInId: s.tradeInId }, idemKey()), 'issue voucher');
  return { ...s, voucherId: String(v.voucherId), voucherNumber: String(v.voucherNumber) };
}
async function adminView(c: Ctx, tradeInId: string): Promise<Json> {
  return ok(await c.api.call('admin.tradeIn', c.T('USR-00002'), { tradeInId }), 'admin trade-in view');
}
async function statusOf(c: Ctx, tradeInId: string): Promise<string> {
  return String(find(await adminView(c, tradeInId), 'status'));
}
/** Audit rows for an object (database checks only). */
async function auditFor(c: Ctx, objectId: string): Promise<{ action: string; actor_id: string | null; actor_role: string | null; vendor_id: string | null; branch_id: string | null; request_id: string | null }[]> {
  if (!c.db) return [];
  return (await c.db.query(`select action, actor_id, actor_role, vendor_id, branch_id, request_id from public.audit_logs where object_id = $1 order by id`, [objectId])).rows;
}
async function expectAudit(c: Ctx, objectId: string, action: string, actor: string): Promise<string> {
  if (!c.db) return 'audit: not checked (no database)';
  const rows = (await auditFor(c, objectId)).filter((r) => r.action === action);
  expect(rows.length >= 1, `no ${action} audit row for ${objectId}`);
  const r = rows[rows.length - 1]!;
  expect(r.actor_id === actor, `${action} audit actor is ${r.actor_id}, expected ${actor}`);
  expect(!!r.request_id, `${action} audit row has no request id`);
  return `audit ${action} by ${actor}`;
}

// ----------------------------------------------------------------- 1. platform
async function platform(c: Ctx, ready: Res & { text: string }) {
  const g = 'platform';
  await c.report.check(g, 'P-01', 'GET /health answers without secrets', async () => {
    const h = await c.api.raw('GET', '/health');
    expectStatus(h, [200], '/health');
    expect(h.body.ok === true, '/health ok is not true');
    expect(!leaksSecrets(h.text), '/health body contains something secret-looking');
  });
  await c.report.check(g, 'P-02', 'GET /ready confirms the database (no internals)', async () => {
    expectStatus(ready, [200], '/ready');
    expect((ready.body.checks as Json)?.database === true, 'database check is not true');
    expect(!leaksSecrets(ready.text), '/ready body contains something secret-looking');
    // The one expected word: the staff sign-in METHOD ("password"), not a credential.
    const scrubbed = ready.text.replace(/"staffSignIn":"(password|phone)"/, '');
    expect(!/host|password|postgres|supabase\.co/i.test(scrubbed), '/ready mentions a host or connection detail');
    return `environment=${String(ready.body.environment)}, sms=${String((ready.body.checks as Json)?.sms)}`;
  });
  await c.report.check(g, 'P-03', 'idempotency keys are required in this environment', async () => {
    expect((ready.body.checks as Json)?.idempotencyKeysRequired === true, '/ready reports idempotencyKeysRequired != true');
  });
  await c.report.check(g, 'P-07', 'staff sign in with email and password (owner decision)', async () => {
    expect(c.staffSignIn === 'password', `/ready reports staffSignIn=${c.staffSignIn}; set STAFF_SIGN_IN=password (or leave it unset) on the API`);
  });
  await c.report.check(g, 'P-04', 'secure headers present; no X-Powered-By', async () => {
    const h = await c.api.raw('GET', '/health');
    for (const k of ['x-content-type-options', 'content-security-policy', 'x-request-id']) expect(h.headers.get(k), `missing ${k}`);
    expect(!h.headers.get('x-powered-by'), 'X-Powered-By is present');
    expect(h.headers.get('cache-control') === 'no-store', 'Cache-Control is not no-store');
    if (/^https:/.test(c.api.base)) expect(h.headers.get('strict-transport-security'), 'missing Strict-Transport-Security');
  });
  await c.report.check(g, 'P-05', 'CORS does not echo an unknown origin', async () => {
    const r = await c.api.raw('OPTIONS', '/v1/actions/me.context', { headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
    expect(r.headers.get('access-control-allow-origin') !== 'https://evil.example', 'unknown origin was allowed');
    expect(r.headers.get('access-control-allow-origin') !== '*', 'wildcard CORS');
  });
  await c.report.check(g, 'P-06', 'unknown route → generic 404 JSON; malformed body → sentence, no stack', async () => {
    const r = await c.api.raw('GET', '/v1/definitely-not-here');
    expectStatus(r, [404], 'unknown route');
    const bad = await fetch(`${c.api.base}/v1/actions/me.context`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"params":', signal: AbortSignal.timeout(15_000) });
    const text = await bad.text();
    expect(bad.status === 400, `malformed JSON gave ${bad.status}`);
    expect(!leaksSecrets(text) && !/at .*\.js:\d+/.test(text), 'error body leaks internals');
  });
}

// ----------------------------------------------------------------- 2. auth
async function auth(c: Ctx) {
  const g = 'auth';
  for (const [id, p] of Object.entries(PROFILES)) {
    if (!c.tokens[id]) { c.report.skip(g, `A-ME-${id}`, `${p.label}: token accepted, role/scope from the database`, 'not signed in'); continue; }
    await c.report.check(g, `A-ME-${id}`, `${p.label}: token accepted, role/scope from the database`, async () => {
      const me = ok(await c.api.call('me.context', c.tokens[id]!, {}), 'me.context');
      expect(me.role === p.role, `role is ${String(me.role)}, expected ${p.role}`);
      if (p.vendorId) expect((me.vendor as Json | null)?.vendorId === p.vendorId, `partner is not ${p.vendorId}`);
      if (p.branchId) expect((me.branch as Json | null)?.branchId === p.branchId, `branch is not ${p.branchId}`);
      if (!p.branchId && p.vendorId) expect(!me.branch, 'partner-wide user unexpectedly bound to a branch');
    });
  }
  const any = Object.values(c.tokens)[0];
  await c.report.check(g, 'A-01', 'token claims match the configured issuer/audience (decoded, not trusted)', async () => {
    if (!any) skip('no token');
    const j = peekJwt(any);
    expect(j.role === 'authenticated', `role claim is ${j.role}`);
    const supa = process.env.SUPABASE_URL?.replace(/\/+$/, '');
    if (supa) expect(j.iss === `${supa}/auth/v1`, `iss is ${j.iss}, expected ${supa}/auth/v1 — set SUPABASE_JWT_ISSUER to the token's iss`);
    return `alg=${j.alg} iss=${j.iss} aud=${JSON.stringify(j.aud)}`;
  });
  await c.report.check(g, 'A-02', 'no token → 401', async () => expectStatus(await c.api.call('me.context', null), [401], 'no token'));
  await c.report.check(g, 'A-03', 'garbage token → 401', async () => expectStatus(await c.api.call('me.context', 'not-a-jwt'), [401], 'garbage'));
  await c.report.check(g, 'A-04', 'tampered signature → 401', async () => {
    if (!any) skip('no token');
    const [h, p, s] = any.split('.');
    const flipped = `${h}.${p}.${s!.slice(0, -2)}${s!.slice(-2) === 'AA' ? 'AB' : 'AA'}`;
    expectStatus(await c.api.call('me.context', flipped), [401], 'tampered');
  });
  await c.report.check(g, 'A-05', 'tampered claims (role escalated) → 401', async () => {
    if (!any) skip('no token');
    const [h, p, s] = any.split('.');
    const claims = JSON.parse(Buffer.from(p!, 'base64url').toString('utf8')) as Json;
    claims.role = 'service_role';
    expectStatus(await c.api.call('me.context', `${h}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${s}`), [401], 'claims');
  });
  await c.report.check(g, 'A-06', 'alg "none" token → 401', async () => {
    if (!any) skip('no token');
    const p = any.split('.')[1];
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${p}.`;
    expectStatus(await c.api.call('me.context', none), [401], 'alg none');
  });
  await c.report.check(g, 'A-07', 'expired token → 401', async () => {
    const t = process.env.QM_EXPIRED_TOKEN;
    if (!t) skip('set QM_EXPIRED_TOKEN to a token whose exp has passed (e.g. one saved from an earlier run)');
    const j = peekJwt(t);
    expect(typeof j.exp === 'number' && j.exp * 1000 < Date.now(), 'QM_EXPIRED_TOKEN has not expired yet');
    expectStatus(await c.api.call('me.context', t), [401], 'expired');
  });
  await c.report.check(g, 'A-08', 'the publishable/anon key is not accepted as a user token', async () => {
    const k = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
    if (!k) skip('SUPABASE_PUBLISHABLE_KEY not set');
    expectStatus(await c.api.call('me.context', k), [401], 'anon key as bearer');
  });
  await c.report.check(g, 'A-09', 'sign-in endpoints are rate limited and never return a code', async () => {
    const r = await c.api.raw('POST', '/v1/auth/start', { body: { phone: '30000099' } });
    expect(![500, 502].includes(r.status), `auth/start returned ${r.status}`);
    expect(!('otp' in r.body) && !('token' in r.body) && !(typeof r.body.code === 'string' && /^\d{4,10}$/.test(r.body.code)), 'the response carries a code or token');
    const via = await c.api.call('auth.verify', null, { phone: '30000099', code: '123456' });
    expect(via.status === 404 || via.status === 401 || via.status === 403, `compatibility endpoint answered auth.verify with ${via.status}`);
  });
  await staffPasswordChecks(c);
}

/** STAFF_SIGN_IN=password: the rules the API promises, checked from the outside. */
async function staffPasswordChecks(c: Ctx) {
  const g = 'auth';
  const why = 'staff do not sign in by password on this API (P-07)';
  const on = c.staffSignIn === 'password';
  const nonce = Math.random().toString(36).slice(2, 10);
  await c.report.check(g, 'A-10', 'a staff number cannot get an SMS code (told to use staff sign-in)', async () => {
    if (!on) skip(why);
    const phone = c.testers.find((t) => t.id === 'USR-00002')?.phone ?? '+97430000002';
    const r = await c.api.raw('POST', '/v1/auth/start', { body: { phone } });
    expectStatus(r, [422], 'start for a staff number');
    expect(r.body.useStaffSignIn === true, 'no useStaffSignIn flag');
  });
  await c.report.check(g, 'A-11', 'wrong password and unknown address get the same answer', async () => {
    if (!on) skip(why);
    const known = c.testers.find((t) => t.id.startsWith('USR-') && t.email)?.email ?? 'usr-00007@staff.example.test';
    const a = await c.api.raw('POST', '/v1/auth/staff/login', { body: { email: known, password: `Wrong-${nonce}-1` } });
    const b = await c.api.raw('POST', '/v1/auth/staff/login', { body: { email: `qm-verify-${nonce}@staff.example.test`, password: `Wrong-${nonce}-1` } });
    expect(a.status === b.status && a.body.message === b.body.message, `different answers: ${a.status} "${String(a.body.message)}" vs ${b.status} "${String(b.body.message)}"`);
    expect(a.status === 422, `wrong password answered ${a.status}`);
  });
  await c.report.check(g, 'A-12', '"set or reset password" gives the same reply for an unknown address and sends nothing', async () => {
    if (!on) skip(why);
    const r = await c.api.raw('POST', '/v1/auth/staff/reset/start', { body: { email: `qm-verify-reset-${nonce}@staff.example.test` } });
    expectStatus(r, [200], 'reset start');
    expect(/If this email belongs to an active staff account/.test(String(r.body.message)), `reply: ${String(r.body.message)}`);
  });
  await c.report.check(g, 'A-13', 'repeated wrong passwords pause sign-in for that address (429)', async () => {
    if (!on) skip(why);
    const email = `qm-verify-pause-${nonce}@staff.example.test`;
    let last: Res | null = null;
    for (let i = 0; i < 21 && last?.status !== 429; i++) last = await c.api.raw('POST', '/v1/auth/staff/login', { body: { email, password: `Wrong-${nonce}-${i}` } });
    expect(last?.status === 429, 'never paused');
    // The per-IP limit on sign-in routes also answers 429; only the per-address pause says "for this email".
    expect(/for this email/.test(String(last?.body.message)), `429 came from another limit: "${String(last?.body.message)}" (wait a minute and re-run --only auth)`);
  });
  await c.report.check(g, 'A-14', 'a Supabase password session carries amr=password and the email claim (what the API relies on)', async () => {
    if (!on) skip(why);
    const staff = Object.entries(c.tokens).find(([id]) => id.startsWith('USR-'));
    if (!staff) skip('no staff member signed in');
    const j = peekJwt(staff[1]) as Json;
    const amr = Array.isArray(j.amr) ? (j.amr as Json[]).map((a) => String(a.method)) : [];
    expect(amr.includes('password'), `amr is ${JSON.stringify(j.amr)}`);
    expect(typeof j.email === 'string' && j.email.includes('@'), 'no email claim');
    return `amr=${amr.join(',')}`;
  });
}

// ----------------------------------------------------------------- 3. idempotency required
async function idempotency(c: Ctx) {
  const g = 'idempotency';
  const cases: [string, string, string, Json][] = [
    ['I-01', 'trade-in creation', 'CUS-00001', { vendorId: 'VND-001', branchId: 'BR-0001', variantId: 'VAR-000001', conditionAnswers: GOOD_ANSWERS, imei: testImei() }],
    ['I-02', 'offer acceptance', 'CUS-00001', { tradeInId: 'TI-DEMO-000001' }],
    ['I-03', 'device received', 'USR-00003', { tradeInId: 'TI-DEMO-000001' }],
    ['I-04', 'voucher issue', 'USR-00005', { tradeInId: 'TI-DEMO-000001' }],
    ['I-05', 'voucher cancel', 'USR-00005', { voucherId: 'VCH-000001', reason: 'verification' }],
    ['I-06', 'voucher reissue', 'USR-00005', { voucherId: 'VCH-000001', reason: 'verification', reissue: true }],
    ['I-07', 'collection (create note)', 'USR-00002', { vendorId: 'VND-001' }],
    ['I-08', 'collection (mark collected)', 'USR-00002', { batchId: 'BAT-00001', action: 'COLLECT' }],
    ['I-09', 'settlement creation', 'USR-00002', { vendorId: 'VND-001', from: '2026-01-01', to: '2026-01-02' }],
    ['I-10', 'settlement approval', 'USR-00001', { settlementId: 'STL-00001', toStatus: 'APPROVED' }],
  ];
  const actions: Record<string, string> = {
    'I-01': 'customer.submitTradeIn', 'I-02': 'customer.acceptOffer', 'I-03': 'tech.receiveDevice', 'I-04': 'vendor.issueVoucher',
    'I-05': 'vendor.voidVoucher', 'I-06': 'vendor.voidVoucher', 'I-07': 'admin.createBatch', 'I-08': 'admin.updateBatch',
    'I-09': 'admin.createSettlement', 'I-10': 'admin.advanceSettlement',
  };
  for (const [id, what, who, params] of cases) {
    await c.report.check(g, id, `missing Idempotency-Key on ${what} (${actions[id]}) → 428, nothing done`, async () => {
      const token = id === 'I-04' || id === 'I-05' || id === 'I-06' ? issuer(c) : c.T(who);
      const r = await c.api.call(actions[id]!, token, params);
      expectStatus(r, [428], 'missing key');
      expect(r.body.code === 'IDEMPOTENCY_KEY_REQUIRED', `code is ${String(r.body.code)}`);
    });
  }
  await c.report.check(g, 'I-11', 'read-only endpoints do not need a key', async () => {
    ok(await c.api.call('customer.myTradeIns', c.T('CUS-00001'), {}), 'customer list');
    ok(await c.api.call('admin.settlements', c.T('USR-00002'), {}), 'settlement list');
  });
  await c.report.check(g, 'I-12', 'a malformed key is refused before anything runs', async () => {
    expectStatus(await c.api.call('customer.acceptOffer', c.T('CUS-00001'), { tradeInId: 'TI-DEMO-000001' }, 'short'), [400], 'malformed key');
  });
}

// ----------------------------------------------------------------- 4. vertical flow
async function flow(c: Ctx) {
  const g = 'flow';
  const st: { tradeInId?: string; imei?: string; voucherId?: string; batchId?: string; settlementId?: string; submitKey?: string; submitBody?: Json } = {};
  const need = (k: keyof typeof st) => st[k] ?? skip('an earlier step did not complete');

  await c.report.check(g, 'F-01', 'customer creates a trade-in (state, scope, audit, replay)', async () => {
    const customer = c.T('CUS-00001');
    st.imei = testImei(); st.submitKey = idemKey();
    const params = { vendorId: 'VND-001', branchId: 'BR-0001', variantId: 'VAR-000001', colorId: 'CLR-000001', imei: st.imei, conditionAnswers: GOOD_ANSWERS };
    const first = ok(await c.api.call('customer.submitTradeIn', customer, params, st.submitKey), 'submit');
    st.tradeInId = String(first.tradeInId);
    const replay = ok(await c.api.call('customer.submitTradeIn', customer, params, st.submitKey), 'replay');
    expect(replay.tradeInId === st.tradeInId, 'replay returned a different trade-in');
    const view = ok(await c.api.call('customer.tradeIn', customer, { tradeInId: st.tradeInId }), 'customer view');
    expect(find(view, 'status') === 'PENDING_TECHNICIAN', `status is ${String(find(view, 'status'))}`);
    expect(!/^\d{15}$/.test(String(find(view, 'imei'))), 'customer view shows the full IMEI');
    if (c.tokens['USR-00009']) expectStatus(await c.api.call('vendor.tradeIn', c.tokens['USR-00009'], { tradeInId: st.tradeInId }), [404], 'other partner');
    if (c.tokens['USR-00006']) expectStatus(await c.api.call('vendor.tradeIn', c.tokens['USR-00006'], { tradeInId: st.tradeInId }), [404], 'other branch');
    if (c.db) {
      const n = (await c.db.query(`select count(*)::int as n from public.trade_ins where imei = $1`, [st.imei])).rows[0].n;
      expect(n === 1, `${n} rows for the IMEI after a replay`);
    }
    return `${st.tradeInId}; ${await expectAudit(c, st.tradeInId, 'TRADEIN_CREATED', 'CUS-00001')}`;
  });

  await c.report.check(g, 'F-02', 'inspection + offer by the technician (financial values)', async () => {
    const id = need('tradeInId') as string;
    await offer(c, id, st.imei!);
    const v = await adminView(c, id);
    const tv = (v.tradeIn ?? v) as Json;
    expect(tv.status === 'FINAL_OFFER_READY', `status is ${String(tv.status)}`);
    const cv = cents(tv.customerValue); const fee = cents(tv.commission); const total = cents(tv.settlement);
    expect(cv > 0, 'no customer value');
    expect(total === cv + fee, `settlement ${total / 100} ≠ value ${cv / 100} + fee ${fee / 100}`);
    if (tv.commissionType === 'PERCENTAGE') expect(fee === Math.round(cv * Number(tv.commissionRate)), `fee ${fee / 100} ≠ ${Number(tv.commissionRate) * 100}% of ${cv / 100}`);
    if (tv.basePriceSnapshot && tv.gradePercentage) {
      const calc = Math.round(cents(tv.basePriceSnapshot) * Number(tv.gradePercentage)) + cents(tv.manualAdjustment ?? 0);
      expect(calc === cv, `value ${cv / 100} ≠ base ${Number(tv.basePriceSnapshot)} × ${Number(tv.gradePercentage)} (+ adjustment)`);
    }
    // The technician never receives the submitted IMEI.
    const ws = ok(await c.api.call('tech.summary', c.T('USR-00003'), { tradeInId: id }), 'tech summary');
    expect(!JSON.stringify(ws).includes(st.imei!), 'the technician view contains the submitted IMEI');
    return `value ${cv / 100}, fee ${fee / 100}, total ${total / 100} QAR`;
  });

  await c.report.check(g, 'F-03', 'customer accepts (replay safe; other customer refused)', async () => {
    const id = need('tradeInId') as string;
    if (c.tokens['CUS-00002']) expectStatus(await c.api.call('customer.acceptOffer', c.tokens['CUS-00002'], { tradeInId: id }, idemKey()), [404], 'other customer');
    const key = idemKey();
    const a1 = ok(await c.api.call('customer.acceptOffer', c.T('CUS-00001'), { tradeInId: id }, key), 'accept');
    const a2 = ok(await c.api.call('customer.acceptOffer', c.T('CUS-00001'), { tradeInId: id }, key), 'replay');
    expect(a1.message === a2.message, 'replay returned a different answer');
    expect((await statusOf(c, id)) === 'CUSTOMER_ACCEPTED', 'status is not CUSTOMER_ACCEPTED');
    if (c.db) {
      const n = (await auditFor(c, id)).filter((r) => r.action === 'CUSTOMER_ACCEPTED').length;
      expect(n === 1, `${n} CUSTOMER_ACCEPTED audit rows after a replay`);
    }
    return await expectAudit(c, id, 'CUSTOMER_ACCEPTED', 'CUS-00001');
  });

  await c.report.check(g, 'F-04', 'technician confirms the device is received', async () => {
    const id = need('tradeInId') as string;
    ok(await c.api.call('tech.receiveDevice', c.T('USR-00003'), { tradeInId: id }, idemKey()), 'receive');
    const s = await statusOf(c, id);
    expect(['DEVICE_RECEIVED', 'AWAITING_VOUCHER'].includes(s), `status is ${s}`);
    return await expectAudit(c, id, 'DEVICE_RECEIVED', 'USR-00003');
  });

  await c.report.check(g, 'F-05', 'branch issues the voucher (other branch refused; duplicate prevented)', async () => {
    const id = need('tradeInId') as string;
    if (c.tokens['USR-00006']) expectStatus(await c.api.call('vendor.issueVoucher', c.tokens['USR-00006'], { tradeInId: id }, idemKey()), [403, 404], 'other branch');
    const v = ok(await c.api.call('vendor.issueVoucher', issuer(c), { tradeInId: id }, idemKey()), 'issue');
    st.voucherId = String(v.voucherId);
    const dup = await c.api.call('vendor.issueVoucher', issuer(c), { tradeInId: id }, idemKey());
    expect(dup.status !== 200 || dup.body.voucherId === st.voucherId, 'a second voucher was issued');
    const tv = ((await adminView(c, id)).tradeIn ?? {}) as Json;
    expect(cents(v.value) === cents(tv.customerValue), `voucher value ${String(v.value)} ≠ offer ${String(tv.customerValue)}`);
    if (c.db) {
      const live = (await c.db.query(`select count(*)::int as n from public.vouchers where trade_in_id = $1 and status = 'ISSUED'`, [id])).rows[0].n;
      expect(live === 1, `${live} live vouchers`);
    }
    return `voucher ${String(v.voucherNumber)}`;
  });

  await c.report.check(g, 'F-06', 'Qatar Mobile collects the device (note + mark collected)', async () => {
    const id = need('tradeInId') as string;
    const b = ok(await c.api.call('admin.createBatch', c.T('USR-00002'), { vendorId: 'VND-001', branchId: 'BR-0001', tradeInIds: [id] }, idemKey()), 'create note');
    st.batchId = String(b.batchId);
    expect(Number(b.deviceCount) === 1, `note has ${String(b.deviceCount)} devices`);
    if (c.tokens['USR-00004']) expectStatus(await c.api.call('admin.createBatch', c.tokens['USR-00004'], { vendorId: 'VND-001' }, idemKey()), [403], 'partner creating a note');
    const m = ok(await c.api.call('admin.updateBatch', c.T('USR-00002'), { batchId: st.batchId, action: 'COLLECT' }, idemKey()), 'collect');
    expect(Number(m.collected) >= 1, 'nothing collected');
    expect((await statusOf(c, id)) === 'COLLECTED', 'trade-in is not COLLECTED');
    return `${st.batchId}; ${await expectAudit(c, id, 'DEVICE_COLLECTED', 'USR-00002')}`;
  });

  await c.report.check(g, 'F-07', 'finance creates and submits the settlement (totals add up)', async () => {
    const id = need('tradeInId') as string;
    const today = qatarDate();
    const s = ok(await c.api.call('admin.createSettlement', c.T('USR-00002'), { vendorId: 'VND-001', from: '2026-01-01', to: today }, idemKey()), 'create settlement');
    st.settlementId = String(s.settlementId);
    const d = ok(await c.api.call('admin.settlements', c.T('USR-00002'), { settlementId: st.settlementId }), 'settlement detail');
    const lines = (d.lines ?? []) as Json[];
    expect(lines.some((l) => l.tradeInId === id), 'our trade-in is not in the settlement');
    const sumLines = lines.reduce((a, l) => a + cents(l.settlement), 0);
    expect(sumLines === cents(s.total), `lines ${sumLines / 100} ≠ header ${String(s.total)}`);
    ok(await c.api.call('admin.advanceSettlement', c.T('USR-00002'), { settlementId: st.settlementId, toStatus: 'SUBMITTED' }, idemKey()), 'submit');
    return `${st.settlementId}: ${lines.length} line(s), ${String(s.total)} QAR`;
  });

  await c.report.check(g, 'F-08', 'settlement approval: QM admin refused, platform owner approves, finance pays', async () => {
    const sid = need('settlementId') as string;
    expectStatus(await c.api.call('admin.advanceSettlement', c.T('USR-00002'), { settlementId: sid, toStatus: 'APPROVED' }, idemKey()), [403], 'QM admin approving');
    ok(await c.api.call('admin.advanceSettlement', c.T('USR-00001'), { settlementId: sid, toStatus: 'APPROVED' }, idemKey()), 'approve');
    const noRef = await c.api.call('admin.advanceSettlement', c.T('USR-00002'), { settlementId: sid, toStatus: 'PAID' }, idemKey());
    expect(noRef.status !== 200, 'PAID accepted without a payment reference');
    ok(await c.api.call('admin.advanceSettlement', c.T('USR-00002'), { settlementId: sid, toStatus: 'PAID', paymentReference: `STAGING-${Date.now()}` }, idemKey()), 'pay');
    expect((await statusOf(c, need('tradeInId') as string)) === 'CLOSED', 'trade-in is not CLOSED after payment');
    if (c.db) {
      const r = (await c.db.query(`select status, approved_by from public.settlements where id = $1`, [sid])).rows[0];
      expect(r.status === 'PAID' || r.status === 'CLOSED', `settlement status ${r.status}`);
      expect(r.approved_by === 'USR-00001', `approved_by ${r.approved_by}`);
    }
    return 'approved by USR-00001, paid';
  });
}

// ----------------------------------------------------------------- 5. negative
async function negative(c: Ctx) {
  const g = 'negative';
  await c.report.check(g, 'N-01', 'branch user → another branch\'s trade-in: denied', async () => {
    const s = await submit(c, c.T('CUS-00001'), 'BR-0001');
    expectStatus(await c.api.call('vendor.tradeIn', c.T('USR-00006'), { tradeInId: s.tradeInId }), [404], 'other branch');
  });
  await c.report.check(g, 'N-02', 'branch user cannot reach another branch by changing the branch id', async () => {
    expectStatus(await c.api.call('vendor.queue', c.T('USR-00006'), { branchId: 'BR-0001' }), [403, 404], 'branch id swap');
    const own = ok(await c.api.call('vendor.queue', c.T('USR-00006'), {}), 'own queue');
    for (const r of (own.tradeIns ?? []) as Json[]) expect(r.branchId === 'BR-0002', `row from ${String(r.branchId)}`);
  });
  await c.report.check(g, 'N-03', 'partner user → another partner\'s trade-in: denied', async () => {
    const s = await submit(c, c.T('CUS-00001'), 'BR-0001');
    expectStatus(await c.api.call('vendor.tradeIn', c.T('USR-00009'), { tradeInId: s.tradeInId }), [404], 'other partner');
    const q = ok(await c.api.call('vendor.queue', c.T('USR-00009'), {}), 'queue');
    for (const r of (q.tradeIns ?? []) as Json[]) expect(r.branchId === 'BR-0003', `row from ${String(r.branchId)}`);
  });
  await c.report.check(g, 'N-04', 'lower role modifies SUPER_ADMIN: denied (and nothing changes)', async () => {
    expectStatus(await c.api.call('admin.updateStaff', c.T('USR-00002'), { userId: 'USR-00001', status: 'DISABLED' }, idemKey()), [403], 'QM admin');
    const pa = c.tokens['USR-00004'] ?? c.tokens['USR-00005'];
    if (pa) {
      const r = await c.api.call('vendor.saveStaff', pa, { mode: 'UPDATE', userId: 'USR-00001', status: 'DISABLED' }, idemKey());
      expectStatus(r, [404], 'partner');
    }
    if (c.tokens['USR-00001']) ok(await c.api.call('me.context', c.tokens['USR-00001'], {}), 'owner still active');
  });
  await c.report.check(g, 'N-05', 'duplicate IMEI: second open trade-in refused', async () => {
    const s = await submit(c, c.T('CUS-00001'));
    const again = await c.api.call('customer.submitTradeIn', c.T('CUS-00001'), {
      vendorId: 'VND-001', branchId: 'BR-0001', variantId: 'VAR-000001', imei: s.imei, conditionAnswers: GOOD_ANSWERS,
    }, idemKey());
    expect(again.status !== 200, 'a second open trade-in was created for the same IMEI');
  });
  await c.report.check(g, 'N-06', 'same key + same device + different payload → 409 (nothing created)', async () => {
    // The key is scoped to the device (the IMEI is the idempotency target, as in 3.1).
    const key = idemKey(); const imei = testImei();
    ok(await c.api.call('customer.submitTradeIn', c.T('CUS-00001'), { vendorId: 'VND-001', branchId: 'BR-0001', variantId: 'VAR-000001', imei, conditionAnswers: GOOD_ANSWERS }, key), 'first');
    const r = await c.api.call('customer.submitTradeIn', c.T('CUS-00001'), { vendorId: 'VND-001', branchId: 'BR-0002', variantId: 'VAR-000001', imei, conditionAnswers: GOOD_ANSWERS }, key);
    expectStatus(r, [409], 'key reuse');
    expect(r.body.code === 'IDEMPOTENCY_KEY_REUSED', `code ${String(r.body.code)}`);
  });
  await c.report.check(g, 'N-07', 'duplicate collection: a device already on an open note is not claimed again', async () => {
    const v = await vouchered(c);
    const b1 = ok(await c.api.call('admin.createBatch', c.T('USR-00002'), { vendorId: 'VND-001', tradeInIds: [v.tradeInId] }, idemKey()), 'first note');
    const b2 = await c.api.call('admin.createBatch', c.T('USR-00002'), { vendorId: 'VND-001', tradeInIds: [v.tradeInId] }, idemKey());
    expect(b2.status !== 200 || Number(b2.body.deviceCount) === 0, 'the device was put on a second note');
    ok(await c.api.call('admin.updateBatch', c.T('USR-00002'), { batchId: String(b1.batchId), action: 'COLLECT' }, idemKey()), 'collect');
  });
  await c.report.check(g, 'N-08', 'duplicate settlement: a settled device is not claimed again', async () => {
    const today = qatarDate();
    const s1 = await c.api.call('admin.createSettlement', c.T('USR-00002'), { vendorId: 'VND-001', from: '2026-01-01', to: today }, idemKey());
    const s2 = await c.api.call('admin.createSettlement', c.T('USR-00002'), { vendorId: 'VND-001', from: '2026-01-01', to: today }, idemKey());
    expect(s1.status < 500 && s2.status < 500, 'a settlement request failed with a server error');
    if (s1.status === 200 && s2.status === 200) {
      // Both may exist only if each claimed different devices; a device in both would be a failure.
      const d1 = ok(await c.api.call('admin.settlements', c.T('USR-00002'), { settlementId: String(s1.body.settlementId) }), 'd1');
      const d2 = ok(await c.api.call('admin.settlements', c.T('USR-00002'), { settlementId: String(s2.body.settlementId) }), 'd2');
      const a = new Set(((d1.lines ?? []) as Json[]).map((l) => l.tradeInId));
      for (const l of (d2.lines ?? []) as Json[]) expect(!a.has(l.tradeInId), `${String(l.tradeInId)} is in two settlements`);
    }
    return `first ${s1.status}, second ${s2.status}${s2.status !== 200 ? ` (${String(s2.body.message ?? '')})` : ''}`;
  });
  await c.report.check(g, 'N-09', 'invalid state transitions are refused', async () => {
    const s = await submit(c, c.T('CUS-00001'));
    const early = await c.api.call('tech.receiveDevice', c.T('USR-00003'), { tradeInId: s.tradeInId }, idemKey());
    expect(early.status !== 200, 'device received before the offer was accepted');
    const acc = await c.api.call('customer.acceptOffer', c.T('CUS-00001'), { tradeInId: s.tradeInId }, idemKey());
    expect(acc.status !== 200, 'offer accepted before any offer existed');
    const v = await c.api.call('vendor.issueVoucher', issuer(c), { tradeInId: s.tradeInId }, idemKey());
    expect(v.status !== 200, 'voucher issued for a device not received');
  });
  await c.report.check(g, 'N-10', 'unauthorised finance actions are refused', async () => {
    expectStatus(await c.api.call('admin.createSettlement', c.T('USR-00004'), { vendorId: 'VND-001', from: '2026-01-01', to: '2026-01-02' }, idemKey()), [403], 'partner settling');
    expectStatus(await c.api.call('admin.settlements', c.T('USR-00003'), {}), [403], 'technician reading settlements');
    expectStatus(await c.api.call('admin.createBatch', c.T('USR-00003'), { vendorId: 'VND-001' }, idemKey()), [403], 'technician collecting');
    if (c.tokens['USR-00006']) expectStatus(await c.api.call('vendor.settlements', c.tokens['USR-00006'], {}), [403], 'branch staff reading settlements');
  });
  await c.report.check(g, 'N-11', 'customer cannot act as staff', async () => {
    expectStatus(await c.api.call('admin.tradeIns', c.T('CUS-00001'), {}), [403, 404], 'customer → admin');
    expectStatus(await c.api.call('tech.queues', c.T('CUS-00001'), {}), [403, 404], 'customer → technician');
  });
}

// ----------------------------------------------------------------- 6. concurrency
async function concurrency(c: Ctx) {
  const g = 'concurrency';
  await c.report.check(g, 'C-01', 'same IMEI × 5 at once → exactly one trade-in', async () => {
    const imei = testImei();
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => c.api.call('customer.submitTradeIn', c.T('CUS-00001'), {
      vendorId: 'VND-001', branchId: 'BR-0001', variantId: 'VAR-000001', imei, conditionAnswers: GOOD_ANSWERS,
    }, idemKey())));
    const wins = rs.filter((r) => r.status === 200 && r.body.ok === true).length;
    expect(wins === 1, `${wins} succeeded`);
    expect(rs.every((r) => r.status < 500), 'a request failed with a server error');
    if (c.db) expect((await c.db.query(`select count(*)::int as n from public.trade_ins where imei = $1`, [imei])).rows[0].n === 1, 'database holds more than one row');
  });
  await c.report.check(g, 'C-02', 'same voucher issue × 5 at once → exactly one live voucher', async () => {
    const s = await received(c);
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => c.api.call('vendor.issueVoucher', issuer(c), { tradeInId: s.tradeInId }, idemKey())));
    const ids = new Set(rs.filter((r) => r.status === 200).map((r) => r.body.voucherId));
    expect(ids.size === 1, `${ids.size} distinct vouchers`);
    expect(rs.every((r) => r.status < 500), 'a request failed with a server error');
    if (c.db) expect((await c.db.query(`select count(*)::int as n from public.vouchers where trade_in_id = $1 and status = 'ISSUED'`, [s.tradeInId])).rows[0].n === 1, 'database holds more than one live voucher');
  });
  await c.report.check(g, 'C-03', 'same collection × 3 at once → each device on one note only', async () => {
    const a = await vouchered(c); const b = await vouchered(c);
    const rs = await Promise.all([1, 2, 3].map(() => c.api.call('admin.createBatch', c.T('USR-00002'), { vendorId: 'VND-001', tradeInIds: [a.tradeInId, b.tradeInId] }, idemKey())));
    const claimed = rs.filter((r) => r.status === 200).reduce((n, r) => n + Number(r.body.deviceCount), 0);
    expect(claimed === 2, `${claimed} device claims for 2 devices`);
    expect(rs.every((r) => r.status < 500), 'a request failed with a server error');
    for (const r of rs.filter((x) => x.status === 200)) {
      ok(await c.api.call('admin.updateBatch', c.T('USR-00002'), { batchId: String(r.body.batchId), action: 'COLLECT' }, idemKey()), 'collect');
    }
  });
  await c.report.check(g, 'C-04', 'same settlement × 3 at once → each device in one settlement only', async () => {
    const today = qatarDate();
    const rs = await Promise.all([1, 2, 3].map(() => c.api.call('admin.createSettlement', c.T('USR-00002'), { vendorId: 'VND-001', from: '2026-01-01', to: today }, idemKey())));
    expect(rs.every((r) => r.status < 500), 'a request failed with a server error');
    const seen = new Set<unknown>();
    for (const r of rs.filter((x) => x.status === 200)) {
      const d = ok(await c.api.call('admin.settlements', c.T('USR-00002'), { settlementId: String(r.body.settlementId) }), 'detail');
      for (const l of (d.lines ?? []) as Json[]) { expect(!seen.has(l.tradeInId), `${String(l.tradeInId)} in two settlements`); seen.add(l.tradeInId); }
    }
    return `${rs.filter((r) => r.status === 200).length} created, ${seen.size} device(s) claimed once each`;
  });
  await c.report.check(g, 'C-05', 'same idempotency key × 5 at once → one effect, same answer', async () => {
    const s = await submit(c, c.T('CUS-00001'));
    await offer(c, s.tradeInId, s.imei);
    const key = idemKey();
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => c.api.call('customer.acceptOffer', c.T('CUS-00001'), { tradeInId: s.tradeInId }, key)));
    expect(rs.every((r) => r.status === 200), `statuses ${rs.map((r) => r.status).join(',')}`);
    // A replay is the stored original answer plus `replayed: true`.
    const strip = (b: Json) => JSON.stringify({ ...b, replayed: undefined });
    expect(new Set(rs.map((r) => strip(r.body))).size === 1, 'different answers for the same key');
    expect(rs.filter((r) => r.body.replayed !== true).length === 1, `${rs.filter((r) => r.body.replayed !== true).length} requests ran (expected 1)`);
    if (c.db) {
      const n = (await auditFor(c, s.tradeInId)).filter((r) => r.action === 'CUSTOMER_ACCEPTED').length;
      expect(n === 1, `${n} CUSTOMER_ACCEPTED audit rows`);
    }
  });
  await c.report.check(g, 'C-06', 'void + reissue: one live voucher, chain linked (replay safe)', async () => {
    const v = await vouchered(c);
    const key = idemKey();
    const r1 = ok(await c.api.call('vendor.voidVoucher', issuer(c), { voucherId: v.voucherId, reason: 'staging verification', reissue: true }, key), 'reissue');
    const r2 = ok(await c.api.call('vendor.voidVoucher', issuer(c), { voucherId: v.voucherId, reason: 'staging verification', reissue: true }, key), 'replay');
    expect(r1.voucherId === r2.voucherId && r1.voucherId !== v.voucherId, 'reissue replay is inconsistent');
    if (c.db) {
      const live = (await c.db.query(`select count(*)::int as n from public.vouchers where trade_in_id = $1 and status = 'ISSUED'`, [v.tradeInId])).rows[0].n;
      expect(live === 1, `${live} live vouchers`);
    }
  });
}

// ----------------------------------------------------------------- 7. RLS (direct Supabase access)
async function rls(c: Ctx) {
  const g = 'rls';
  if (!c.supa) { c.report.skip(g, 'R-*', 'direct Supabase REST checks', 'set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY'); return; }
  const s = c.supa;
  const denied = (r: { status: number; rows: unknown[] | null }) => r.status === 401 || r.status === 403 || r.status === 404 || (r.status === 200 && Array.isArray(r.rows) && r.rows.length === 0);
  await c.report.check(g, 'R-01', 'anon: no trade-ins, customers, users, vouchers, settlements, audit, internal tables', async () => {
    for (const t of ['trade_ins', 'customers', 'app_users', 'vouchers', 'settlements', 'collections', 'audit_logs', 'idempotency_keys', 'otp_send_log', 'otp_verify_attempts', 'id_counters']) {
      const r = await s.rest('GET', `${t}?select=*&limit=5`);
      expect(denied(r), `anon read ${t}: HTTP ${r.status}, ${r.rows?.length ?? 0} row(s)`);
    }
  });
  await c.report.check(g, 'R-02', 'anon: public catalogue readable; partner fee rate is not', async () => {
    const p = await s.rest('GET', 'products?select=id,model&limit=5');
    expect(p.status === 200 && (p.rows?.length ?? 0) > 0, `catalogue: HTTP ${p.status}`);
    const fee = await s.rest('GET', 'vendors?select=default_commission_rate&limit=1');
    expect(fee.status !== 200 || (fee.rows ?? []).length === 0, 'anon can read the partner fee rate');
  });
  await c.report.check(g, 'R-03', 'anon and signed-in users cannot write anything directly', async () => {
    const tries: [string | undefined, string][] = [[undefined, 'anon']];
    for (const id of ['CUS-00001', 'USR-00004', 'USR-00001']) if (c.tokens[id]) tries.push([c.tokens[id], id]);
    for (const [tok, who] of tries) {
      const ins = await s.rest('POST', 'settings', tok, { key: `rls.probe.${Date.now()}`, value: 'x' });
      expect(ins.status >= 400, `${who} inserted into settings (HTTP ${ins.status})`);
      const upd = await s.rest('PATCH', 'trade_ins?id=eq.TI-DEMO-000001', tok, { status: 'CLOSED' });
      expect(upd.status >= 400 || (upd.rows ?? []).length === 0, `${who} updated trade_ins (HTTP ${upd.status})`);
    }
  });
  await c.report.check(g, 'R-04', 'customer sees only their own trade-ins and profile', async () => {
    const r = await s.rest('GET', 'trade_ins?select=id,customer_id&limit=1000', c.T('CUS-00001'));
    expect(r.status === 200, `HTTP ${r.status}`);
    for (const row of (r.rows ?? []) as Json[]) expect(row.customer_id === 'CUS-00001', `sees ${String(row.customer_id)}'s trade-in`);
    const me = await s.rest('GET', 'customers?select=id', c.T('CUS-00001'));
    expect(((me.rows ?? []) as Json[]).every((x) => x.id === 'CUS-00001'), 'sees other customers');
    return `${(r.rows ?? []).length} own row(s)`;
  });
  await c.report.check(g, 'R-05', 'branch staff sees only their branch; never the IMEI', async () => {
    const tok = c.tokens['USR-00006'] ?? c.T('USR-00008');
    const branch = c.tokens['USR-00006'] ? 'BR-0002' : 'BR-0001';
    const r = await s.rest('GET', 'trade_ins?select=id,branch_id,vendor_id&limit=1000', tok);
    expect(r.status === 200, `HTTP ${r.status}`);
    for (const row of (r.rows ?? []) as Json[]) expect(row.branch_id === branch && row.vendor_id === 'VND-001', `sees ${String(row.branch_id)}`);
    const other = await s.rest('GET', `trade_ins?select=id&branch_id=neq.${branch}`, tok);
    expect(denied(other), 'filtering by another branch returned rows');
    const imei = await s.rest('GET', 'trade_ins?select=imei&limit=1', tok);
    expect(imei.status >= 400, 'the IMEI column is readable');
  });
  await c.report.check(g, 'R-06', 'partner-wide admin sees only their partner', async () => {
    const r = await s.rest('GET', 'trade_ins?select=vendor_id&limit=1000', c.T('USR-00004'));
    for (const row of (r.rows ?? []) as Json[]) expect(row.vendor_id === 'VND-001', `sees ${String(row.vendor_id)}`);
    if (c.tokens['USR-00009']) {
      const o = await s.rest('GET', 'trade_ins?select=vendor_id&vendor_id=eq.VND-001', c.tokens['USR-00009']);
      expect(denied(o), 'second partner sees VND-001 rows');
    }
  });
  await c.report.check(g, 'R-07', 'finance access matches business permissions', async () => {
    const qa = await s.rest('GET', 'settlements?select=id&limit=5', c.T('USR-00002'));
    expect(qa.status === 200 && (qa.rows ?? []).length > 0, `QM admin cannot read settlements (HTTP ${qa.status})`);
    const tech = await s.rest('GET', 'settlements?select=id', c.T('USR-00003'));
    expect(denied(tech), 'technician reads settlements');
    if (c.tokens['USR-00008'] || c.tokens['USR-00006']) {
      const staff = await s.rest('GET', 'settlements?select=id', c.tokens['USR-00008'] ?? c.tokens['USR-00006']);
      expect(denied(staff), 'branch staff reads settlements');
    }
    const cust = await s.rest('GET', 'vouchers?select=commission_value&limit=1', c.T('CUS-00001'));
    expect(cust.status >= 400, 'customer can read the partner fee on vouchers');
  });
  await c.report.check(g, 'R-08', 'QM admin and SUPER_ADMIN see across partners (read)', async () => {
    for (const id of ['USR-00002', 'USR-00001']) {
      if (!c.tokens[id]) continue;
      const r = await s.rest('GET', 'trade_ins?select=vendor_id&limit=1000', c.tokens[id]);
      expect(r.status === 200 && (r.rows ?? []).length > 0, `${id}: HTTP ${r.status}`);
    }
  });
  await c.report.check(g, 'R-09', 'internal functions are not callable (counter RPC)', async () => {
    const r = await s.rest('POST', 'rpc/next_counter', c.tokens['USR-00001'], { scope: 'X' });
    expect(r.status === 404 || r.status === 401 || r.status === 403, `HTTP ${r.status}`);
  });
}

// ----------------------------------------------------------------- 8. storage
async function storage(c: Ctx) {
  const g = 'storage';
  let tradeInId = ''; let fileId = ''; let signed = '';
  await c.report.check(g, 'S-01', 'technician uploads an evidence photo; a disguised SVG is refused', async () => {
    const s = await submit(c, c.T('CUS-00001'));
    tradeInId = s.tradeInId;
    ok(await c.api.call('tech.openInspection', c.T('USR-00003'), { tradeInId }), 'open');
    const up = ok(await c.api.call('tech.uploadPhotos', c.T('USR-00003'), { tradeInId, photos: [{ category: 'FRONT', dataUrl: PNG_1x1 }, { category: 'BACK', dataUrl: SVG_AS_PNG }] }), 'upload');
    expect(Number(up.added) === 1, `${String(up.added)} added`);
    expect(((up.problems ?? []) as unknown[]).length === 1, 'the SVG was not refused');
    const ws = ok(await c.api.call('tech.openInspection', c.T('USR-00003'), { tradeInId }), 'workspace');
    fileId = String(((find(ws, 'photoIds') ?? []) as unknown[])[0] ?? '');
    expect(fileId, 'no photo id returned');
  });
  await c.report.check(g, 'S-02', 'private photo: short-lived signed URL works; scope enforced', async () => {
    if (!fileId) skip('no photo');
    const v = ok(await c.api.call('tech.viewPhoto', c.T('USR-00003'), { tradeInId, fileId }), 'view');
    signed = String(v.url);
    expect(/\/storage\/v1\/object\/sign\/inspection-photos\//.test(signed), 'not a signed inspection-photos URL');
    expect(Number(v.expiresInSeconds) > 0 && Number(v.expiresInSeconds) <= 3600, `ttl ${String(v.expiresInSeconds)}`);
    const img = await fetch(signed, { signal: AbortSignal.timeout(20_000) });
    expect(img.status === 200, `signed URL HTTP ${img.status}`);
    expect(String(img.headers.get('content-type')).startsWith('image/png'), `content-type ${String(img.headers.get('content-type'))}`);
    expectStatus(await c.api.call('tech.viewPhoto', c.T('CUS-00001'), { tradeInId, fileId }), [403, 404], 'customer viewing evidence');
    const other = await submit(c, c.T('CUS-00001'));
    expect((await c.api.call('tech.viewPhoto', c.T('USR-00003'), { tradeInId: other.tradeInId, fileId })).status !== 200, 'photo served under another trade-in');
  });
  await c.report.check(g, 'S-03', 'private bucket is not public; not listable or readable directly', async () => {
    if (!signed) skip('no signed URL');
    if (!c.supa) skip('SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY not set');
    const path = decodeURIComponent(signed.split('/object/sign/inspection-photos/')[1]!.split('?')[0]!);
    const pub = await fetch(`${c.supa.url}/storage/v1/object/public/inspection-photos/${path}`, { signal: AbortSignal.timeout(20_000) });
    expect(pub.status !== 200, 'the private object is served by the public URL');
    const anonList = await c.supa.storage('POST', 'object/list/inspection-photos', undefined, { prefix: '', limit: 10 });
    expect(anonList.status >= 400 || anonList.text.trim() === '[]', `anon listed the private bucket (HTTP ${anonList.status})`);
    const userGet = await c.supa.storage('GET', `object/authenticated/inspection-photos/${path}`, c.T('CUS-00001'));
    expect(userGet.status >= 400, `a signed-in customer read the object directly (HTTP ${userGet.status})`);
    if (c.tokens['USR-00003']) {
      const techGet = await c.supa.storage('GET', `object/authenticated/inspection-photos/${path}`, c.tokens['USR-00003']);
      expect(techGet.status >= 400, 'even the technician must go through the API');
    }
  });
  await c.report.check(g, 'S-04', 'public catalogue image is served publicly; uploads only via the API', async () => {
    const r = ok(await c.api.call('admin.uploadMedia', c.T('USR-00002'), { kind: 'PRODUCT', objectId: 'PRD-00002', dataUrl: PNG_1x1 }), 'upload media');
    const url = String(r.imageUrl);
    expect(url.includes('/storage/v1/object/public/catalog-media/'), 'not a public catalog-media URL');
    const got = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    expect(got.status === 200, `public URL HTTP ${got.status}`);
    if (c.supa) {
      const direct = await c.supa.storage('POST', 'object/catalog-media/probe/probe.png', c.tokens['USR-00001'], {});
      expect(direct.status >= 400, `a direct client upload to catalog-media succeeded (HTTP ${direct.status})`);
    }
  });
}

// ----------------------------------------------------------------- 9. database (read-only)
async function dbChecks(c: Ctx) {
  const g = 'db';
  if (!c.db) { c.report.skip(g, 'D-*', 'read-only database consistency checks', 'set STAGING_DATABASE_URL'); return; }
  const db = c.db;
  await c.report.check(g, 'D-01', 'integrity invariants hold (reconciliation checks, read-only)', async () => {
    const issues = (await invariantIssues(db)).filter((i) => i.kind !== 'UNDATED_COLLECTED');
    expect(issues.length === 0, issues.slice(0, 5).map((i) => `${i.kind} ${i.objectId}: ${i.detail}`).join('; '));
  });
  await c.report.check(g, 'D-02', 'financial totals: every settlement header equals its lines; every trade-in total = value + fee', async () => {
    const bad = (await db.query(`select s.id from public.settlements s where s.status <> 'CANCELLED'
      and s.settlement_total <> coalesce((select sum(t.total_settlement) from public.trade_ins t where t.settlement_id = s.id), 0)`)).rows;
    expect(bad.length === 0, `${bad.length} settlement(s) with header ≠ lines`);
    const sums = (await db.query(`select coalesce(sum(total_settlement),0)::text as total, count(*)::int as n from public.trade_ins where settlement_id is not null`)).rows[0];
    return `${sums.n} settled trade-in(s), ${sums.total} QAR in settlements`;
  });
  await c.report.check(g, 'D-03', 'RLS is enabled on every public table; clients have no write grants', async () => {
    const off = (await db.query(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`)).rows;
    expect(off.length === 0, `RLS off on: ${off.map((r) => r.relname).join(', ')}`);
    const writes = (await db.query(`select table_name, grantee, privilege_type from information_schema.role_table_grants
      where table_schema = 'public' and grantee in ('anon','authenticated') and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE')`)).rows;
    expect(writes.length === 0, `client write grants: ${writes.slice(0, 5).map((w) => `${w.grantee}.${w.privilege_type} on ${w.table_name}`).join(', ')}`);
  });
  await c.report.check(g, 'D-04', 'storage buckets: catalogue public, evidence private, limits set', async () => {
    const b = (await db.query(`select id, public, file_size_limit from storage.buckets where id in ('catalog-media','inspection-photos')`)).rows as { id: string; public: boolean; file_size_limit: number }[];
    const m = Object.fromEntries(b.map((x) => [x.id, x]));
    expect(m['catalog-media']?.public === true, 'catalog-media is not public');
    expect(m['inspection-photos']?.public === false, 'inspection-photos is not private');
    expect(Number(m['inspection-photos']?.file_size_limit) > 0, 'no size limit on inspection-photos');
  });
  await c.report.check(g, 'D-05', 'migrations: all applied, checksums recorded', async () => {
    const r = (await db.query(`select version from app.schema_migrations order by version`).catch(() => ({ rows: [] as { version: string }[] }))).rows;
    expect(r.length >= 7, `${r.length} migration(s) recorded in app.schema_migrations (applied with another tool?)`);
    return r.map((x) => x.version).join(', ');
  });
  await c.report.check(g, 'D-06', 'no OTP code or token stored in the OTP log or audit', async () => {
    const cols = (await db.query(`select column_name from information_schema.columns where table_schema='public' and table_name in ('otp_send_log','otp_verify_attempts')`)).rows.map((r) => r.column_name);
    expect(!cols.some((x: string) => /code|otp|token|secret/.test(x)), `suspicious column: ${cols.join(', ')}`);
    const leaked = (await db.query(`select count(*)::int as n from public.audit_logs where coalesce(details::text,'') ~ 'eyJ[A-Za-z0-9_-]{10,}\\.' or coalesce(new_value::text,'') ~ 'eyJ[A-Za-z0-9_-]{10,}\\.'`)).rows[0].n;
    expect(leaked === 0, `${leaked} audit row(s) contain a JWT`);
  });
}

main().catch((e) => {
  if (e instanceof Skip) { console.error(e.message); process.exit(2); }
  console.error(`Verification aborted: ${(e as Error).message}`);
  process.exit(1);
});
