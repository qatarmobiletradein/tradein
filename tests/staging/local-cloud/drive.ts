/**
 * LOCAL EMULATION driver (run by run.sh). Signs every seeded profile in for
 * real through the API and Supabase Auth (GoTrue):
 *   customers: SMS code  (API → GoTrue /otp → Send SMS hook → Twilio emulation → /verify)
 *   staff:     "set or reset password" (API provisions the Auth user with the
 *              secret key → GoTrue /recover → REAL e-mail to the SMTP sink →
 *              /verify recovery → PUT /user) then email + password (/token).
 * Then it runs the unchanged staging verification and the checks that only
 * make sense with the real Auth server in the loop.
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { SignJWT } from 'jose';
import { Report, expect, expectStatus, peekJwt, sleep } from '../../../tools/staging/lib.js';

const E = (k: string) => process.env[k] ?? '';
const API = E('API'); const CTL = E('CTL'); const GW = E('GW'); const ANON = E('ANON_KEY');
const db = new pg.Pool({ connectionString: E('DB_URL'), max: 2, ssl: { ca: readFileSync(E('DB_CA'), 'utf8'), rejectUnauthorized: true } });
const PROFILES = ['USR-00001', 'USR-00002', 'USR-00003', 'USR-00004', 'USR-00005', 'USR-00006', 'USR-00007', 'USR-00008', 'USR-00009', 'CUS-00001', 'CUS-00002'];

async function post(base: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  let json: Record<string, unknown> = {};
  try { json = (await r.json()) as Record<string, unknown>; } catch { /* empty */ }
  return { status: r.status, body: json };
}
async function phoneOf(id: string): Promise<string> {
  const table = id.startsWith('USR-') ? 'app_users' : 'customers';
  return (await db.query(`select phone from public.${table} where id = $1`, [id])).rows[0].phone as string;
}
async function lastMail(to: string): Promise<{ code: string | null; count: number; subject?: string }> {
  const r = await fetch(`${CTL}/mail?to=${encodeURIComponent(to.toLowerCase())}`);
  return (await r.json()) as { code: string | null; count: number; subject?: string };
}
async function emailOf(id: string): Promise<string> {
  return (await db.query(`select email from public.app_users where id = $1`, [id])).rows[0].email as string;
}
/** Real staff set-up: API reset start → GoTrue e-mails a code → API reset finish (sets the password, signs in). */
async function staffSetPassword(email: string, password: string): Promise<{ token: string; refreshToken: string }> {
  const before = (await lastMail(email)).count;
  const s = await post(API, '/v1/auth/staff/reset/start', { email });
  if (s.status !== 200) throw new Error(`reset/start ${s.status} ${String(s.body.message ?? '')}`);
  let m = await lastMail(email);
  for (let i = 0; i < 60 && m.count === before; i++) { await sleep(250); m = await lastMail(email); }
  if (m.count === before || !m.code) throw new Error(`no e-mail with a code reached the SMTP sink for ${email.replace(/^(.).*@/, '$1•••@')}`);
  const f = await post(API, '/v1/auth/staff/reset/finish', { email, code: m.code, password });
  if (f.status !== 200 || typeof f.body.token !== 'string') throw new Error(`reset/finish ${f.status} ${String(f.body.message ?? '')}`);
  return { token: f.body.token, refreshToken: String(f.body.refreshToken ?? '') };
}
async function staffLogin(email: string, password: string) {
  return post(API, '/v1/auth/staff/login', { email, password });
}

async function lastCode(phone: string): Promise<string | null> {
  const r = await fetch(`${CTL}/sms?phone=${encodeURIComponent(phone.replace(/^\+/, ''))}`);
  return ((await r.json()) as { code: string | null }).code;
}
/** Real sign-in: API → GoTrue /otp → hook → API → Twilio emulation; then API → GoTrue /verify. */
async function signIn(phone: string): Promise<{ token: string; refreshToken: string }> {
  const before = await lastCode(phone);
  const s = await post(API, '/v1/auth/start', { phone });
  if (s.status !== 200 || s.body.ok !== true) throw new Error(`auth/start ${s.status} ${String(s.body.message ?? '')}`);
  let code: string | null = null;
  for (let i = 0; i < 40 && (!code || code === before); i++) { await sleep(250); code = await lastCode(phone); }
  if (!code || code === before) throw new Error('no SMS reached the Twilio emulation');
  const v = await post(API, '/v1/auth/verify', { phone, code });
  if (v.status !== 200 || typeof v.body.token !== 'string') throw new Error(`auth/verify ${v.status} ${String(v.body.message ?? '')}`);
  return { token: v.body.token, refreshToken: String(v.body.refreshToken ?? '') };
}

async function main(): Promise<void> {
  const report = new Report({ kind: 'LOCAL EMULATION (GoTrue + PostgREST images, emulated gateway/Storage/Twilio) — NOT Supabase Cloud', api: API });
  const tokens: Record<string, string> = {}; const refresh: Record<string, string> = {};
  const signedAt: Record<string, number> = {}; const passwords: Record<string, string> = {};
  const resetAt: Record<string, number> = {};
  const newPassword = () => `Emul-${Math.random().toString(36).slice(2, 10)}-${Date.now() % 100000}`;

  await report.check('emulation', 'E-01', `real sign-in for ${PROFILES.length} seeded profiles: customers by SMS code, staff by e-mailed code + password`, async () => {
    for (const id of PROFILES) {
      if (id.startsWith('USR-')) {
        passwords[id] = newPassword();
        const r = await staffSetPassword(await emailOf(id), passwords[id]!);
        tokens[id] = r.token; refresh[id] = r.refreshToken; resetAt[id] = Date.now();
      } else {
        const r = await signIn(await phoneOf(id));
        tokens[id] = r.token; refresh[id] = r.refreshToken; signedAt[id] = Date.now();
      }
    }
    return `${Object.keys(tokens).length} signed in`;
  });
  await report.check('emulation', 'E-11', 'staff sign in again with email + password through the real Auth server; the token is a password session', async () => {
    const r = await staffLogin(await emailOf('USR-00002'), passwords['USR-00002']!);
    expectStatus(r, [200], 'password sign-in');
    const claims = JSON.parse(Buffer.from(String(r.body.token).split('.')[1]!, 'base64url').toString('utf8')) as { amr?: { method: string }[]; email?: string };
    expect(claims.amr?.some((a) => a.method === 'password'), `amr ${JSON.stringify(claims.amr)}`);
    expect(claims.email === await emailOf('USR-00002'), 'email claim is not the profile address');
    tokens['USR-00002'] = String(r.body.token);
    return `amr=${claims.amr?.map((a) => a.method).join(',')}`;
  });
  await report.check('emulation', 'E-02', 'GoTrue-issued token: HS256, issuer and audience as configured, role authenticated', async () => {
    const j = peekJwt(tokens['CUS-00001']!);
    expect(j.alg === 'HS256', `alg ${j.alg}`);
    expect(j.iss === `${GW}/auth/v1`, `iss ${j.iss}`);
    expect(j.aud === 'authenticated' || (Array.isArray(j.aud) && j.aud.includes('authenticated')), `aud ${JSON.stringify(j.aud)}`);
    expect(j.role === 'authenticated', `role ${j.role}`);
  });
  await report.check('emulation', 'E-03', 'profiles were linked to their Supabase Auth users on first verified sign-in', async () => {
    const staff = PROFILES.filter((p) => p.startsWith('USR-'));
    const n = (await db.query(`select count(*)::int as n from public.app_users u join auth.users a on a.id = u.auth_user_id
      where u.id = any($1::text[]) and lower(a.email) = lower(u.email) and a.email_confirmed_at is not null`, [staff])).rows[0].n;
    expect(n === staff.length, `${n} of ${staff.length} staff profiles linked to an Auth user with their address`);
    const c = (await db.query(`select count(*)::int as n from public.customers u join auth.users a on a.id = u.auth_user_id
      where u.id in ('CUS-00001','CUS-00002') and a.phone = substr(u.phone, 2)`)).rows[0].n;
    expect(c === 2, `${c} customers linked by phone`);
  });
  await report.check('emulation', 'E-10', 'the resend cooldown reaches the person as a 429 sentence, quickly (hook → Auth → API)', async () => {
    const t0 = Date.now();
    const r = await post(API, '/v1/auth/start', { phone: await phoneOf('CUS-00002') });
    const ms = Date.now() - t0;
    expectStatus(r, [429], 'second code within the cooldown');
    expect(r.body.message === 'Too many code requests. Please try again later.', `message: ${String(r.body.message)}`);
    expect(ms < 3000, `took ${ms} ms (Supabase Auth retrying the hook?)`);
    return `${ms} ms`;
  });
  await report.check('emulation', 'E-04', 'refresh through the real Auth server issues a working token (staff: still a password session)', async () => {
    const r = await post(API, '/v1/auth/refresh', { refreshToken: refresh['USR-00003'] });
    expectStatus(r, [200], 'refresh');
    const me = await post(API, '/v1/actions/me.context', { params: {} }, { authorization: `Bearer ${String(r.body.token)}` });
    expectStatus(me, [200], 'me with refreshed token');
    tokens['USR-00003'] = String(r.body.token);
  });
  await report.check('emulation', 'E-12', 'staff number: Supabase Auth called DIRECTLY for an SMS code is refused by the hook; nothing is sent', async () => {
    const phone = (await phoneOf('USR-00004')).replace(/^\+/, '');
    const r = await post(GW, '/auth/v1/otp', { phone, create_user: false }, { apikey: ANON });
    expect(r.status !== 200, `Supabase Auth accepted (HTTP ${r.status})`);
    await sleep(500);
    expect((await lastCode(phone)) === null, 'an SMS reached a staff number');
    return `GoTrue answered ${r.status}`;
  });

  const dir = E('WORK');
  const tokensFile = join(dir, 'tokens.json');
  writeFileSync(tokensFile, JSON.stringify(tokens), { mode: 0o600 });
  const sub = (await db.query(`select auth_user_id from public.customers where id = 'CUS-00001'`)).rows[0].auth_user_id as string;
  const expired = await new SignJWT({ role: 'authenticated', aud: 'authenticated' }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(sub).setIssuer(`${GW}/auth/v1`).setIssuedAt(Math.floor(Date.now() / 1000) - 7200).setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
    .sign(new TextEncoder().encode(E('JWT_SECRET')));

  const verifyExit = await new Promise<number>((done) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'tools/staging/verify-staging.ts', '--api', API, '--allow-http', '--tokens', tokensFile, '--out', E('OUT')], {
      stdio: 'inherit',
      env: {
        ...process.env, SUPABASE_URL: GW, SUPABASE_PUBLISHABLE_KEY: ANON, STAGING_DATABASE_URL: E('DB_URL'),
        DATABASE_SSL: 'require', DATABASE_SSL_CA: readFileSync(E('DB_CA'), 'utf8'), QM_EXPIRED_TOKEN: expired,
      },
    });
    child.on('exit', (c) => done(c ?? 1));
  });

  await report.check('emulation', 'E-13', 'a password-RECOVERY session (code verified directly with Supabase Auth) is not a staff session', async () => {
    const email = await emailOf('USR-00007');
    const before = (await lastMail(email)).count;
    const wait = 61_000 - (Date.now() - (resetAt['USR-00007'] ?? 0));
    if (wait > 0) await sleep(wait);
    expectStatus(await post(API, '/v1/auth/staff/reset/start', { email }), [200], 'reset start');
    let m = await lastMail(email);
    for (let i = 0; i < 60 && m.count === before; i++) { await sleep(250); m = await lastMail(email); }
    expect(m.code, 'no code e-mailed');
    const v = await post(GW, '/auth/v1/verify', { type: 'recovery', email, token: m.code }, { apikey: ANON });
    expectStatus(v, [200], 'direct recovery verify');
    const me = await post(API, '/v1/actions/me.context', { params: {} }, { authorization: `Bearer ${String(v.body.access_token)}` });
    expectStatus(me, [401], 'API with a recovery session');
    resetAt['USR-00007'] = Date.now();
  });
  await report.check('emulation', 'E-14', 'someone signs up DIRECTLY with a staff address first: the unconfirmed stray user is cleared, the owner sets up normally, the stray password never works', async () => {
    await db.query(`insert into public.app_users (id, full_name, phone, email, role, status, approved_by, approved_at)
      values ('USR-00020', 'Emulation Stray Test', '+97430000020', 'stray.target@staff.example.test', 'TECHNICIAN', 'ACTIVE', 'seed', now()) on conflict (id) do nothing`);
    const squat = await post(GW, '/auth/v1/signup', { email: 'stray.target@staff.example.test', password: 'Squatter-Pass-2026' }, { apikey: ANON });
    expect(squat.status === 200, `direct signup answered ${squat.status}`);
    const r = await staffSetPassword('stray.target@staff.example.test', 'Owner-Pass-2026-x');
    const me = await post(API, '/v1/actions/me.context', { params: {} }, { authorization: `Bearer ${r.token}` });
    expectStatus(me, [200], 'owner signed in');
    expectStatus(await staffLogin('stray.target@staff.example.test', 'Squatter-Pass-2026'), [422], 'stray password');
    const users = (await db.query(`select count(*)::int as n from auth.users where lower(email) = 'stray.target@staff.example.test'`)).rows[0].n;
    expect(users === 1, `${users} Auth users hold the address`);
  });
  await report.check('emulation', 'E-15', 'administrator changes a staff address: old address refused, old password does not carry over, new address set up', async () => {
    const oldEmail = await emailOf('USR-00008');
    const upd = await post(API, '/v1/actions/admin.updateStaff', { params: { userId: 'USR-00008', email: 'renamed.usr-00008@staff.example.test' } },
      { authorization: `Bearer ${tokens['USR-00001']}`, 'idempotency-key': `emul-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` });
    expectStatus(upd, [200], 'admin.updateStaff');
    expectStatus(await staffLogin(oldEmail, passwords['USR-00008']!), [422], 'old address');
    const fresh = 'Renamed-Pass-2026-z';
    const r = await staffSetPassword('renamed.usr-00008@staff.example.test', fresh);
    expectStatus(await post(API, '/v1/actions/me.context', { params: {} }, { authorization: `Bearer ${r.token}` }), [200], 'new address');
    expectStatus(await staffLogin('renamed.usr-00008@staff.example.test', passwords['USR-00008']!), [422], 'old password on the new address');
  });
  await report.check('emulation', 'E-16', 'wrong passwords pause sign-in for that address even with the real Auth server; the right password is then refused too', async () => {
    const email = await emailOf('USR-00006');
    let last = 0;
    for (let i = 0; i < 5; i++) last = (await staffLogin(email, `Wrong-pass-${i}-2026`)).status;
    expect(last === 422, `5th wrong password answered ${last}`);
    const right = await staffLogin(email, passwords['USR-00006']!);
    expect(right.status === 429 && /for this email/.test(String(right.body.message)), `right password after the pause: ${right.status} ${String(right.body.message)}`);
  });
  await report.check('emulation', 'E-05', 'Railway pre-checks cannot be bypassed by calling Supabase Auth directly (disabled account)', async () => {
    await db.query(`insert into public.customers (id, full_name, phone, status) values ('CUS-00090', 'Disabled Emulation Demo', '+97430000090', 'DISABLED') on conflict (id) do nothing`);
    const r = await post(GW, '/auth/v1/otp', { phone: '97430000090', create_user: true }, { apikey: ANON });
    expect(r.status !== 200, `Supabase Auth sent a code to a disabled account (HTTP ${r.status})`);
    expect((await lastCode('+97430000090')) === null, 'an SMS reached the disabled account');
    return `GoTrue answered ${r.status}: ${String(r.body.msg ?? r.body.message ?? r.body.error_description ?? '')}`.slice(0, 160);
  });
  await report.check('emulation', 'E-06', 'a Supabase session for a number with no profile is useless to the API and to direct REST', async () => {
    const phone = '97455009911';
    const s = await post(GW, '/auth/v1/otp', { phone, create_user: true }, { apikey: ANON });
    expectStatus(s, [200], 'direct otp for an unknown number (registration path)');
    let code: string | null = null;
    for (let i = 0; i < 40 && !code; i++) { await sleep(250); code = await lastCode(phone); }
    expect(code, 'no code delivered');
    const v = await post(GW, '/auth/v1/verify', { type: 'sms', phone, token: code }, { apikey: ANON });
    expectStatus(v, [200], 'direct verify');
    const tok = String(v.body.access_token);
    expectStatus(await post(API, '/v1/actions/me.context', { params: {} }, { authorization: `Bearer ${tok}` }), [401], 'API with a profile-less session');
    const rest = await fetch(`${GW}/rest/v1/trade_ins?select=id`, { headers: { apikey: ANON, authorization: `Bearer ${tok}` } });
    const rows = (await rest.json()) as unknown[];
    expect(rest.status !== 200 || (Array.isArray(rows) && rows.length === 0), 'profile-less session reads trade-ins over REST');
  });
  await report.check('emulation', 'E-07', 'wrong-code limit with the real Auth server: right code refused after 5 wrong ones', async () => {
    const id = 'CUS-00002';
    const wait = 61_000 - (Date.now() - (signedAt[id] ?? 0));
    if (wait > 0) await sleep(wait); // the 3.1 resend cooldown is 60 s
    const phone = await phoneOf(id);
    const before = await lastCode(phone);
    expectStatus(await post(API, '/v1/auth/start', { phone }), [200], 'start');
    let code: string | null = null;
    for (let i = 0; i < 40 && (!code || code === before); i++) { await sleep(250); code = await lastCode(phone); }
    expect(code && code !== before, 'no new code');
    const wrong = code === '000000' ? '111111' : '000000';
    let last = '';
    for (let i = 0; i < 5; i++) last = String((await post(API, '/v1/auth/verify', { phone, code: wrong })).body.message ?? '');
    expect(/Too many incorrect attempts/.test(last), `5th wrong code said: ${last}`);
    const right = await post(API, '/v1/auth/verify', { phone, code });
    expect(right.status !== 200, 'the right code was accepted after the limit');
  });
  await report.check('emulation', 'E-08', 'logout-all: old access token refused; refresh token revoked by the Auth server', async () => {
    const id = 'CUS-00001';
    const out = await post(API, '/v1/auth/logout-all', {}, { authorization: `Bearer ${tokens[id]}` });
    expectStatus(out, [200], 'logout-all');
    await sleep(1100); // iat has 1 s resolution
    expectStatus(await post(API, '/v1/actions/me.context', { params: {} }, { authorization: `Bearer ${tokens[id]}` }), [401], 'old token');
    const r = await post(API, '/v1/auth/refresh', { refreshToken: refresh[id] });
    expect(r.status === 401, `refresh after logout-all returned ${r.status}`);
  });
  await report.check('emulation', 'E-09', 'the Send SMS hook rejects unsigned calls coming through the public gateway', async () => {
    const r = await post(GW, '/hooks/send-sms', { user: { phone: '97430000001' }, sms: { otp: '123456' } }, { 'webhook-id': 'x', 'webhook-timestamp': String(Math.floor(Date.now() / 1000)), 'webhook-signature': 'v1,AAAA' });
    expectStatus(r, [401], 'unsigned hook');
  });

  const files = report.write(E('OUT'));
  const c = report.counts();
  console.log(`\nEMULATION-ONLY CHECKS: PASS ${c.PASS} · FAIL ${c.FAIL} · SKIPPED ${c.SKIPPED} → ${files.md}`);
  await db.end();
  process.exitCode = verifyExit || (c.FAIL ? 1 : 0);
}

main().catch((e) => { console.error(`drive failed: ${(e as Error).message}`); process.exit(1); });
