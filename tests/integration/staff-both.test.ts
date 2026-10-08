/**
 * STAFF_SIGN_IN=both (owner decision 2026-10-08): staff may sign in with their
 * mobile number + SMS code OR with work email + password — ONE Supabase Auth
 * user per staff profile. SUPER_ADMIN still needs the authenticator app after
 * either method; other roles do not.
 *
 * Supabase Auth is the stub in tests/helpers/app.ts. Live Supabase: covered by
 * the manual cloud checks once Twilio delivers.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HAS_DB } from '../helpers/db.js';
import { HOOK_SECRET, createTestApp, type TestApp } from '../helpers/app.js';
import { settleBackgroundWork } from '../../apps/api/src/services/staff-auth.js';
import { totp } from '../helpers/totp.js';
import { loadConfig } from '../../packages/shared/src/config.js';
import { normalizeEmail } from '../../packages/shared/src/text.js';

const GOOD = 'Staging-Demo-2026x';

describe.skipIf(!HAS_DB)('staff sign-in by phone OR email+password (STAFF_SIGN_IN=both)', () => {
  let t: TestApp;
  const post = async (url: string, payload: Record<string, unknown>, token?: string) => {
    const r = await t.app.inject({ method: 'POST', url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.statusCode, body: r.json() as Record<string, unknown> };
  };
  /** The 3.1 phone flow: start → the code the test SMS provider received → verify. */
  const phoneSignIn = async (local: string) => {
    await t.deps.pool.query(`update public.otp_send_log set created_at = created_at - interval '2 hours' where phone = $1`, [`+974${local}`]);
    const s = await post('/v1/auth/start', { phone: local });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    const code = t.sms.lastCodeFor(`+974${local}`);
    expect(code).toMatch(/^\d{6}$/);
    return post('/v1/auth/verify', { phone: local, code });
  };
  const setPassword = async (email: string) => {
    await t.deps.pool.query(`update public.staff_auth_attempts set created_at = created_at - interval '2 hours'
      where email_key = encode(sha256(convert_to(lower($1), 'UTF8')), 'hex')`, [email]);
    await post('/v1/auth/staff/reset/start', { email }); await settleBackgroundWork();
    const code = [...t.auth.mail].reverse().find((m) => m.to === email)!.code;
    return post('/v1/auth/staff/reset/finish', { email, code, password: GOOD });
  };
  const authUserOf = async (id: string) =>
    (await t.deps.pool.query<{ auth_user_id: string | null }>('select auth_user_id from public.app_users where id = $1', [id])).rows[0]!.auth_user_id;

  beforeAll(async () => {
    t = await createTestApp({ STAFF_SIGN_IN: 'both', STAFF_MFA_ROLES: 'SUPER_ADMIN', SEND_EMAIL_HOOK_SECRET: HOOK_SECRET, OTP_RESEND_COOLDOWN_S: '30' });
    await t.deps.pool.query(`update public.app_users set email = 'usr-0000' || right(id, 1) || '@staff.example.test' where id in ('USR-00001','USR-00002')`);
  });
  afterAll(async () => { await t?.close(); });

  it('BOTH-01 a staff member with no Auth user signs in by phone: linked on first sign-in, full session (no MFA for this role)', async () => {
    const r = await phoneSignIn('30000002');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ ok: true, portal: 'admin' });
    expect(r.body.mfaRequired).toBeUndefined();
    const me = await t.call('me.context', String(r.body.token));
    expect(me.body.role).toBe('QM_ADMIN');
    expect(await authUserOf('USR-00002')).toBeTruthy();
  });

  it('BOTH-02 the same person then sets a password: the SAME Auth user gets the email, and both methods work', async () => {
    const before = await authUserOf('USR-00002');
    const r = await setPassword('usr-00002@staff.example.test');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ ok: true, portal: 'admin' });
    expect(await authUserOf('USR-00002')).toBe(before);
    const pw = await post('/v1/auth/staff/login', { email: 'usr-00002@staff.example.test', password: GOOD });
    expect(pw.status).toBe(200);
    // set password ends earlier sessions; a fresh phone sign-in still works
    const again = await phoneSignIn('30000002');
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(await authUserOf('USR-00002')).toBe(before);
  });

  it('BOTH-03 SUPER_ADMIN with an email Auth user: a phone code reaches the SAME user and still needs the authenticator app', async () => {
    const first = await setPassword('usr-00001@staff.example.test');
    expect(first.body).toMatchObject({ ok: true, mfaRequired: true });
    const id = await authUserOf('USR-00001');
    // The API put the profile's number on that Auth user before sending the code.
    const r = await phoneSignIn('30000001');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ ok: true, mfaRequired: true, mfaEnrolled: false });
    expect(r.body.portal).toBeUndefined();
    expect(await authUserOf('USR-00001')).toBe(id);
    expect((await t.deps.pool.query('select phone from auth.users where id = $1', [id])).rows[0].phone).toBe('97430000001');
    const pending = String(r.body.token);
    expect((await t.call('me.context', pending)).body).toMatchObject({ ok: false, code: 'MFA_REQUIRED' });
    const e = await post('/v1/auth/mfa/enroll', {}, pending);
    expect(e.status).toBe(200);
    const v = await post('/v1/auth/mfa/verify', { factorId: e.body.factorId, code: totp(String(e.body.secret)) }, pending);
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    expect(v.body).toMatchObject({ ok: true, portal: 'admin' });
    expect((await t.call('me.context', String(v.body.token))).body.role).toBe('SUPER_ADMIN');
    // and by password: the same authenticator app is asked for (enrolled now)
    const pw = await post('/v1/auth/staff/login', { email: 'usr-00001@staff.example.test', password: GOOD });
    expect(pw.body).toMatchObject({ ok: true, mfaRequired: true, mfaEnrolled: true });
  });

  it('BOTH-04 an old number left on the Auth user is not a way in, and cannot become a customer account', async () => {
    const r = await phoneSignIn('30000002');
    expect(r.status).toBe(200);
    // An administrator changes the person's number; the Auth user still holds the old one.
    await t.deps.pool.query(`update public.app_users set phone = '+97430000092' where id = 'USR-00002'`);
    await t.deps.pool.query(`update public.otp_send_log set created_at = created_at - interval '2 hours' where phone = '+97430000002'`);
    const reg = await post('/v1/auth/register', { phone: '30000002', fullName: 'Someone Else' });
    expect(reg.status).toBe(200); // a code is sent to the old number (unknown to any profile now)
    const code = t.sms.lastCodeFor('+97430000002');
    const fin = await post('/v1/auth/register', { phone: '30000002', fullName: 'Someone Else', code });
    expect(fin.status).toBe(422);
    expect(fin.body.message).toBe('An account already exists for this number.');
    expect((await t.deps.pool.query(`select count(*)::int as n from public.customers where phone = '+97430000002'`)).rows[0].n).toBe(0);
    // The new number signs in to the same person.
    const id = await authUserOf('USR-00002');
    const n = await phoneSignIn('30000092');
    expect(n.status, JSON.stringify(n.body)).toBe(200);
    expect(await authUserOf('USR-00002')).toBe(id);
  });

  it('BOTH-05 a number already held by another Auth user (e.g. an old customer sign-up) is refused, not merged', async () => {
    await t.deps.pool.query(`insert into auth.users (id, phone) values (gen_random_uuid(), '97430000003')`);
    // USR-00003 gets an Auth user through a password set-up, then tries the phone.
    await t.deps.pool.query(`update public.app_users set email = 'usr-00003@staff.example.test' where id = 'USR-00003'`);
    expect((await setPassword('usr-00003@staff.example.test')).status).toBe(200);
    const s = await post('/v1/auth/start', { phone: '30000003' });
    expect(s.status).toBe(422);
    expect(s.body.message).toBe('This account cannot be signed in to. Please contact support.');
    const audit = await t.deps.pool.query(`select 1 from public.audit_logs where action = 'STAFF_SIGNIN_CONFLICT' and object_id = 'USR-00003'`);
    expect(audit.rowCount).toBe(1);
  });

  it('BOTH-06 customers are unchanged', async () => {
    const s1 = await post('/v1/auth/register', { phone: '55000301', fullName: 'Demo Customer Both' });
    expect(s1.status).toBe(200);
    const s2 = await post('/v1/auth/register', { phone: '55000301', fullName: 'Demo Customer Both', code: t.sms.lastCodeFor('+97455000301') });
    expect(s2.body).toMatchObject({ ok: true, portal: 'customer' });
  });

  it('BOTH-07 config: production accepts password or both, refuses phone; "mailto:" is not part of an address', () => {
    const base = {
      APP_ENV: 'production', DATABASE_URL: 'postgresql://u:p@db.example.test:5432/x', DATABASE_SSL: 'require',
      SUPABASE_URL: 'https://x.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x', SUPABASE_SECRET_KEY: 'sb_secret_x',
      SUPABASE_JWKS_URL: 'https://x.supabase.co/auth/v1/.well-known/jwks.json', SUPABASE_JWT_ISSUER: 'https://x.supabase.co/auth/v1',
      CORS_ALLOWED_ORIGINS: 'https://app.example.test', SEND_SMS_HOOK_SECRET: HOOK_SECRET, SEND_EMAIL_HOOK_SECRET: HOOK_SECRET,
      SMS_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'AC' + '0'.repeat(32), TWILIO_AUTH_TOKEN: '0'.repeat(32), TWILIO_FROM: '+15550000000',
      GRAPH_TENANT_ID: 't', GRAPH_CLIENT_ID: 'c', GRAPH_CLIENT_SECRET: 's', STAFF_MAIL_FROM: 'info@example.test',
    };
    const problems = (env: Record<string, string>) => { try { loadConfig(env); return ''; } catch (e) { return String((e as Error).message); } };
    expect(problems({ ...base, STAFF_SIGN_IN: 'both' })).not.toContain('STAFF_SIGN_IN');
    expect(problems({ ...base, STAFF_SIGN_IN: 'phone' })).toContain('STAFF_SIGN_IN=phone is refused');
    expect(normalizeEmail('mailto:Info@QatarMobile.qa')).toBe('info@qatarmobile.qa');
    expect(normalizeEmail(' MAILTO: a@b.qa')).toBe('a@b.qa');
  });
});
