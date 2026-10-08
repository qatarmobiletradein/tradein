/**
 * Staff email + password sign-in (STAFF_SIGN_IN=password).
 *
 * Supabase Auth is the in-memory stub (tests/helpers/app.ts) that behaves
 * like GoTrue for password grant, recovery codes and the admin user API.
 * The real Auth server is exercised in the local cloud emulation; Supabase
 * Cloud: NOT EXECUTED.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { HAS_DB } from '../helpers/db.js';
import { createTestApp, idemKey, signToken, type TestApp } from '../helpers/app.js';
import { loadConfig } from '../../packages/shared/src/config.js';
import { passwordProblem, settleBackgroundWork } from '../../apps/api/src/services/staff-auth.js';
import { normalizeEmail } from '../../packages/shared/src/text.js';

const GOOD = 'Staging-Demo-2026x';
const NEW_GOOD = 'Another-Demo-2026y';

describe.skipIf(!HAS_DB)('staff sign-in with email and password', () => {
  let t: TestApp;
  let admin = '';

  const post = async (url: string, payload: Record<string, unknown>) => {
    const r = await t.app.inject({ method: 'POST', url, payload });
    return { status: r.statusCode, body: r.json() as Record<string, unknown> };
  };
  const login = (email: string, password: string) => post('/v1/auth/staff/login', { email, password });
  /** The reset e-mail is sent after the reply; wait for it like a person waits for their inbox. */
  const resetStart = async (email: string) => { const r = await post('/v1/auth/staff/reset/start', { email }); await settleBackgroundWork(); return r; };
  const resetFinish = (email: string, code: string, password: string) => post('/v1/auth/staff/reset/finish', { email, code, password });
  const lastMail = (email: string) => [...t.auth.mail].reverse().find((m) => m.to === email.toLowerCase())?.code ?? null;
  /** The 60 s per-address cooldown between reset e-mails, moved into the past. */
  const skipCooldown = (email: string) => t.deps.pool.query(
    `update public.staff_auth_attempts set created_at = created_at - interval '2 hours'
      where email_key = encode(sha256(convert_to(lower($1), 'UTF8')), 'hex') and kind = 'RESET_SEND'`, [email]);
  const setUp = async (email: string, password = GOOD) => {
    await skipCooldown(email);
    expect((await resetStart(email)).status).toBe(200);
    const code = lastMail(email);
    expect(code).toMatch(/^\d{6}$/);
    const r = await resetFinish(email, code!, password);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return String(r.body.token);
  };

  beforeAll(async () => {
    t = await createTestApp({ STAFF_SIGN_IN: 'password', OTP_MAX_ATTEMPTS: '5' });
    for (let i = 1; i <= 6; i++) {
      await t.deps.pool.query(`update public.app_users set email = $2 where id = $1`, [`USR-0000${i}`, `usr-0000${i}@staff.example.test`]);
    }
    admin = await setUp('usr-00001@staff.example.test');
  });
  afterAll(async () => { await t?.close(); });

  it('first password: code by email → password set → signed in; the profile is linked to the Auth user the API created', async () => {
    const me = await t.call('me.context', admin);
    expect(me.status).toBe(200);
    expect(me.body.role).toBe('SUPER_ADMIN');
    const row = (await t.deps.pool.query(`select u.auth_user_id, a.email from public.app_users u join auth.users a on a.id = u.auth_user_id where u.id = 'USR-00001'`)).rows[0];
    expect(row.email).toBe('usr-00001@staff.example.test');
    // Codes and passwords are never stored or audited.
    const dump = JSON.stringify((await t.deps.pool.query('select * from public.audit_logs')).rows) + JSON.stringify((await t.deps.pool.query('select * from public.staff_auth_attempts')).rows);
    expect(dump).not.toContain(GOOD);
    expect(dump).not.toContain('usr-00001@staff.example.test');
    for (const m of t.auth.mail) expect(dump).not.toContain(m.code);
  });

  it('sign-in: right password works; a wrong password and an unknown address get the same answer', async () => {
    const r = await login('USR-00001@Staff.Example.Test', GOOD);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, portal: 'admin' });
    const wrong = await login('usr-00001@staff.example.test', 'Not-the-password-1');
    const unknown = await login('nobody@staff.example.test', 'Not-the-password-1');
    expect(wrong.status).toBe(422);
    expect(wrong.body.message).toBe('The email or password is not right.');
    expect({ s: unknown.status, m: unknown.body.message }).toEqual({ s: wrong.status, m: wrong.body.message });
  });

  it('a staff number cannot sign in with an SMS code: start refuses, and the SMS hook refuses even if Auth is called directly', async () => {
    const r = await post('/v1/auth/start', { phone: '30000002' });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ ok: false, useStaffSignIn: true });
    const direct = await t.auth.sendOtp('+97430000002', true);
    expect(direct.ok).toBe(false);
    expect(t.sms.lastCodeFor('+97430000002')).toBeFalsy();
  });

  it('only a PASSWORD session for the provisioned Auth user and the current address is a staff session', async () => {
    const { auth_user_id: sub } = (await t.deps.pool.query(`select auth_user_id from public.app_users where id = 'USR-00001'`)).rows[0];
    const otp = await signToken(sub, '+97430000001', { email: 'usr-00001@staff.example.test', amr: 'otp' });
    const recovery = await signToken(sub, '', { email: 'usr-00001@staff.example.test', amr: 'recovery' });
    const otherEmail = await signToken(sub, '', { email: 'someone-else@staff.example.test', amr: 'password' });
    const right = await signToken(sub, '', { email: 'usr-00001@staff.example.test', amr: 'password' });
    expect((await t.call('me.context', otp)).status).toBe(401);
    expect((await t.call('me.context', recovery)).status).toBe(401);
    expect((await t.call('me.context', otherEmail)).status).toBe(401);
    expect((await t.call('me.context', right)).status).toBe(200);
    // A phone-code session for a staff number is never linked to the staff profile.
    const fresh = randomUUID();
    await t.deps.pool.query('insert into auth.users (id, phone) values ($1, $2)', [fresh, '97430000003']);
    expect((await t.call('me.context', await signToken(fresh, '+97430000003', { amr: 'otp' }))).status).toBe(401);
    expect((await t.deps.pool.query(`select auth_user_id from public.app_users where id = 'USR-00003'`)).rows[0].auth_user_id).toBeNull();
  });

  it('reset: the reply is the same for unknown and disabled addresses, and nothing is sent', async () => {
    await t.deps.pool.query(`update public.app_users set status = 'DISABLED' where id = 'USR-00006'`);
    const before = t.auth.mail.length;
    const a = await resetStart('ghost@staff.example.test');
    const b = await resetStart('usr-00006@staff.example.test');
    expect(a).toEqual(b);
    expect(a.body.message).toMatch(/If this email belongs to an active staff account/);
    expect(t.auth.mail.length).toBe(before);
    await t.deps.pool.query(`update public.app_users set status = 'ACTIVE' where id = 'USR-00006'`);
  });

  it('reset: one code per minute per address; weak passwords refused before a code attempt is used', async () => {
    const email = 'usr-00003@staff.example.test';
    expect((await resetStart(email)).status).toBe(200);
    const again = await resetStart(email);
    expect(again.status).toBe(429);
    const code = lastMail(email)!;
    const weak = await resetFinish(email, code, 'short1');
    expect(weak.status).toBe(422);
    expect(weak.body.message).toMatch(/at least 12 characters/);
    expect((await resetFinish(email, code, 'usr-00003-Long-Password1')).body.message).toMatch(/email address/);
    const ok = await resetFinish(email, code, GOOD);
    expect(ok.status).toBe(200);
    expect(ok.body.portal).toBe('technician');
  });

  it('wrong reset codes: limited since the last code sent; then even the right code is refused', async () => {
    const email = 'usr-00004@staff.example.test';
    await skipCooldown(email);
    await resetStart(email);
    const code = lastMail(email)!;
    const wrong = code === '000000' ? '111111' : '000000';
    let last = '';
    for (let i = 0; i < 5; i++) last = String((await resetFinish(email, wrong, GOOD)).body.message);
    expect(last).toBe('Too many incorrect codes. Ask for a new code.');
    expect((await resetFinish(email, code, GOOD)).status).toBe(422);
    // A new code starts a new count.
    await skipCooldown(email);
    await resetStart(email);
    expect((await resetFinish(email, lastMail(email)!, GOOD)).status).toBe(200);
  });

  it('wrong passwords pause sign-in for that address (even concurrent ones are all counted); a new password lifts the pause', async () => {
    const email = 'usr-00005@staff.example.test';
    await setUp(email);
    let calls = 0;
    const real = t.auth.passwordLogin.bind(t.auth);
    t.auth.passwordLogin = async (e: string, p: string) => { calls++; return real(e, p); };
    try {
      const rs = await Promise.all(Array.from({ length: 10 }, () => login(email, 'Wrong-password-123')));
      expect(calls).toBe(5);
      expect(rs.filter((r) => r.status === 429).length).toBe(5);
      const right = await login(email, GOOD);
      expect(right.status).toBe(429);
      expect(right.body.message).toMatch(/Too many sign-in attempts/);
      expect(calls).toBe(5);
    } finally { t.auth.passwordLogin = real; }
    const audits = (await t.deps.pool.query(`select count(*)::int as n from public.audit_logs where action = 'STAFF_LOGIN_PAUSED'`)).rows[0].n;
    expect(audits).toBeGreaterThan(0);
    const fresh = await setUp(email, NEW_GOOD);
    expect((await t.call('me.context', fresh)).status).toBe(200);
  });

  it('setting a password ends every earlier session of that person', async () => {
    const email = 'usr-00002@staff.example.test';
    const first = await setUp(email);
    expect((await t.call('me.context', first)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 1100)); // iat has 1 s resolution
    await setUp(email, NEW_GOOD);
    expect((await t.call('me.context', first)).status).toBe(401);
    expect((await login(email, GOOD)).status).toBe(422);
    expect((await login(email, NEW_GOOD)).status).toBe(200);
  });

  it('admin: creating staff needs a valid, unused work email; the reply says how they start', async () => {
    const base = { mode: 'CREATE', phone: '55000301', fullName: 'Demo New Staff', role: 'TECHNICIAN' };
    expect((await t.call('admin.updateStaff', admin, base, idemKey())).body.message).toMatch(/work email/);
    expect((await t.call('admin.updateStaff', admin, { ...base, email: 'not-an-email' }, idemKey())).body.message).toBe('Enter a valid email address.');
    expect((await t.call('admin.updateStaff', admin, { ...base, email: 'USR-00002@staff.example.test' }, idemKey())).body.message).toMatch(/already used/);
    const r = await t.call('admin.updateStaff', admin, { ...base, email: 'new.staff@staff.example.test' }, idemKey());
    expect(r.status).toBe(200);
    expect(r.body.message).toMatch(/Staff sign-in/);
    const tok = await setUp('new.staff@staff.example.test');
    expect((await t.call('me.context', tok)).body.role).toBe('TECHNICIAN');
  });

  it('admin changes the address: the old address stops working, the old password does not carry over, the person sets a new one', async () => {
    const userId = String((await t.deps.pool.query(`select id from public.app_users where email = 'new.staff@staff.example.test'`)).rows[0].id);
    const r = await t.call('admin.updateStaff', admin, { userId, email: 'renamed.staff@staff.example.test' }, idemKey());
    expect(r.status).toBe(200);
    expect((await login('new.staff@staff.example.test', GOOD)).status).toBe(422);
    // Address moved to the Auth user with a fresh, unknown password.
    await resetStart('renamed.staff@staff.example.test');
    expect((await login('renamed.staff@staff.example.test', GOOD)).status).toBe(422);
    const code = lastMail('renamed.staff@staff.example.test')!;
    expect((await resetFinish('renamed.staff@staff.example.test', code, NEW_GOOD)).status).toBe(200);
  });

  it('applicants need a work email; after approval they set a password (phone-era Auth user gets the address)', async () => {
    const no = await post('/v1/auth/register', { phone: '55000302', fullName: 'Demo Applicant', accountType: 'EMPLOYEE' });
    expect(no.body.message).toMatch(/work email/);
    const p = { phone: '55000302', fullName: 'Demo Applicant', accountType: 'EMPLOYEE', email: 'applicant@staff.example.test' };
    expect((await post('/v1/auth/register', p)).status).toBe(200);
    const done = await post('/v1/auth/register', { ...p, code: t.sms.lastCodeFor('+97455000302') });
    expect(done.body).toMatchObject({ ok: true, pending: true });
    const id = String((await t.deps.pool.query(`select id from public.app_users where phone = '+97455000302'`)).rows[0].id);
    const before = (await t.deps.pool.query(`select auth_user_id from public.app_users where id = $1`, [id])).rows[0].auth_user_id;
    expect((await t.call('admin.approveStaff', admin, { userId: id, role: 'TECHNICIAN' }, idemKey())).body.message).toMatch(/Set or reset password/);
    const tok = await setUp('applicant@staff.example.test');
    expect((await t.call('me.context', tok)).body.role).toBe('TECHNICIAN');
    const after = (await t.deps.pool.query(`select u.auth_user_id, a.phone, a.email from public.app_users u join auth.users a on a.id = u.auth_user_id where u.id = $1`, [id])).rows[0];
    expect(after.auth_user_id).toBe(before);
    expect(after.email).toBe('applicant@staff.example.test');
  });

  it('a leftover Auth user holding a staff address is cleared (never confirmed, or one this API managed); anything else is a conflict for an administrator', async () => {
    await t.deps.pool.query(`update public.app_users set email = 'stray@staff.example.test' where id = 'USR-00006'`);
    await t.deps.pool.query(`insert into auth.users (id, email) values ($1, 'stray@staff.example.test')`, [randomUUID()]);
    expect((await setUp('stray@staff.example.test')).length).toBeGreaterThan(20);

    await t.deps.pool.query(`update public.app_users set email = 'ours@staff.example.test', auth_user_id = null where id = 'USR-00006'`);
    await t.deps.pool.query(`insert into auth.users (id, email, email_confirmed_at, raw_app_meta_data) values ($1, 'ours@staff.example.test', now(), '{"qm_staff": true}')`, [randomUUID()]);
    expect((await setUp('ours@staff.example.test')).length).toBeGreaterThan(20);

    await t.deps.pool.query(`update public.app_users set email = 'taken@staff.example.test', auth_user_id = null where id = 'USR-00006'`);
    await t.deps.pool.query(`insert into auth.users (id, email, email_confirmed_at) values ($1, 'taken@staff.example.test', now())`, [randomUUID()]);
    const before = t.auth.mail.length;
    const r = await resetStart('taken@staff.example.test');
    expect(r.status).toBe(200);
    expect(t.auth.mail.length).toBe(before);
    expect((await t.deps.pool.query(`select count(*)::int as n from public.audit_logs where action = 'STAFF_SIGNIN_CONFLICT'`)).rows[0].n).toBe(1);
  });

  it('Supabase Auth admin unavailable: the same reply, nothing sent; the per-address minute still applies, then a retry works', async () => {
    const email = 'usr-00006-x@staff.example.test';
    await t.deps.pool.query(`update public.app_users set email = $1, auth_user_id = null where id = 'USR-00006'`, [email]);
    t.auth.failAdmin = 503;
    const r = await resetStart(email);
    expect(r.status).toBe(200);
    expect(lastMail(email)).toBeNull();
    expect((await resetStart(email)).status).toBe(429);
    await skipCooldown(email);
    const again = await resetStart(email);
    expect(again.status).toBe(200);
    expect(lastMail(email)).toMatch(/^\d{6}$/);
  });

  it('the reply to "set or reset" does not wait for Supabase (same answer, same speed, staff or not)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const real = t.auth.adminGetUser.bind(t.auth);
    t.auth.adminGetUser = async (id: string) => { await gate; return real(id); };
    try {
      await skipCooldown('usr-00002@staff.example.test');
      const started = Date.now();
      const r = await post('/v1/auth/staff/reset/start', { email: 'usr-00002@staff.example.test' });
      expect(r.status).toBe(200);
      expect(Date.now() - started).toBeLessThan(1000); // Supabase is still "blocked" here
    } finally { release(); t.auth.adminGetUser = real; await settleBackgroundWork(); }
  });

  it('all staff together stay under the hourly e-mail limit', async () => {
    const cfg = t.deps.config as { STAFF_RESET_EMAILS_PER_HOUR: number };
    const keep = cfg.STAFF_RESET_EMAILS_PER_HOUR;
    await skipCooldown('usr-00004@staff.example.test');
    cfg.STAFF_RESET_EMAILS_PER_HOUR = (await t.deps.pool.query(
      `select count(*)::int as n from public.staff_auth_attempts where kind = 'RESET_EMAIL' and created_at > now() - interval '1 hour'`)).rows[0].n;
    try {
      const email = 'usr-00004@staff.example.test';
      const before = t.auth.mail.length;
      expect((await resetStart(email)).status).toBe(200);
      expect(t.auth.mail.length).toBe(before);
    } finally { cfg.STAFF_RESET_EMAILS_PER_HOUR = keep; }
  });

  it('after an administrator changes the address, nothing issued for the old Auth user is a staff session any more', async () => {
    const { auth_user_id: oldSub } = (await t.deps.pool.query(`select auth_user_id from public.app_users where id = 'USR-00003'`)).rows[0];
    expect(oldSub).toBeTruthy();
    expect((await t.call('admin.updateStaff', admin, { userId: 'USR-00003', email: 'tech.moved@staff.example.test' }, idemKey())).status).toBe(200);
    // e.g. a token minted later from an old refresh token, even if its address were changed to the new one
    const minted = await signToken(oldSub, '', { email: 'tech.moved@staff.example.test', amr: 'password', iatOffsetS: 5 });
    expect((await t.call('me.context', minted)).status).toBe(401);
    const tok = await setUp('tech.moved@staff.example.test');
    expect((await t.call('me.context', tok)).body.role).toBe('TECHNICIAN');
  });

  it('customers are unchanged: SMS code sign-in still works', async () => {
    const r = await post('/v1/auth/start', { phone: '30000010' });
    expect(r.status).toBe(200);
    const v = await post('/v1/auth/verify', { phone: '30000010', code: t.sms.lastCodeFor('+97430000010') });
    expect(v.status).toBe(200);
    expect(v.body.portal).toBe('customer');
  });
});

describe('staff sign-in configuration and password rules', () => {
  const base = {
    DATABASE_URL: 'postgres://u:p@db.example.test:5432/postgres', SUPABASE_JWT_SECRET: 'x'.repeat(40), SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
    SUPABASE_ANON_KEY: 'sb_publishable_x', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_x', SEND_SMS_HOOK_SECRET: 'v1,whsec_x', SUPABASE_JWT_ISSUER: 'https://abcdefghijklmnopqrst.supabase.co/auth/v1',
    CORS_ALLOWED_ORIGINS: 'https://staging.example.test', SMS_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'ACx', TWILIO_AUTH_TOKEN: 'x', TWILIO_FROM: '+15005550006',
    GRAPH_TENANT_ID: 't', GRAPH_CLIENT_ID: 'c', GRAPH_CLIENT_SECRET: 's', STAFF_MAIL_FROM: 'info@qatarmobile.qa', SEND_EMAIL_HOOK_SECRET: 'v1,whsec_dGVzdA==',
  };
  it('defaults: password in staging and production, phone in development/test; production refuses phone', () => {
    expect(loadConfig({ ...base, APP_ENV: 'staging' }).STAFF_SIGN_IN).toBe('password');
    expect(loadConfig({ ...base, APP_ENV: 'production' }).STAFF_SIGN_IN).toBe('password');
    expect(loadConfig({ ...base, APP_ENV: 'development' }).STAFF_SIGN_IN).toBe('phone');
    expect(loadConfig({ ...base, APP_ENV: 'staging', STAFF_SIGN_IN: 'phone' }).STAFF_SIGN_IN).toBe('phone');
    expect(() => loadConfig({ ...base, APP_ENV: 'production', STAFF_SIGN_IN: 'phone' })).toThrow(/STAFF_SIGN_IN=phone is refused in production/);
  });
  it('password rules', () => {
    expect(passwordProblem('Staging-Demo-2026x', 'a@b.qa', 12)).toBeNull();
    expect(passwordProblem('short1A', 'a@b.qa', 12)).toMatch(/at least 12/);
    expect(passwordProblem('onlyletterslong', 'a@b.qa', 12)).toMatch(/number/);
    expect(passwordProblem('ali.hassan-2026-x', 'ali.hassan@qm.qa', 12)).toMatch(/email address/);
    expect(passwordProblem(`a${'é'.repeat(40)}1`, 'a@b.qa', 12)).toMatch(/at most 72/);
  });
  it('sign-in addresses are ASCII only (no case-folding tricks), one @, a dotted domain', () => {
    expect(normalizeEmail(' Ali.Hassan@QM.qa ')).toBe('ali.hassan@qm.qa');
    expect(normalizeEmail('adm\u0130n@qm.qa')).toBe('');
    expect(normalizeEmail('a@b@qm.qa')).toBe('');
    expect(normalizeEmail('a b@qm.qa')).toBe('');
    expect(normalizeEmail('ali@localhost')).toBe('');
  });
});
