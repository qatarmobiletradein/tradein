/**
 * OTP_TEST_NUMBERS (owner decision 2026-10-08, no SMS provider yet): a listed customer / new number gets its
 * real Supabase code back on the sign-in screen instead of by SMS. Never a staff number; refused in production.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HAS_DB } from '../helpers/db.js';
import { HOOK_SECRET, createTestApp, type TestApp } from '../helpers/app.js';
import { loadConfig } from '../../packages/shared/src/config.js';

describe.skipIf(!HAS_DB)('OTP_TEST_NUMBERS', () => {
  let t: TestApp;
  const post = async (url: string, payload: Record<string, unknown>) => {
    const r = await t.app.inject({ method: 'POST', url, payload });
    return { status: r.statusCode, body: r.json() as Record<string, unknown> };
  };
  beforeAll(async () => { t = await createTestApp({ OTP_TEST_NUMBERS: '55000401, +97430000002' }); });
  afterAll(async () => { await t?.close(); });

  it('a listed new number: the code is returned for the screen, not sent; it registers a customer', async () => {
    const before = t.sms.outbox.filter((m) => m.to === "+97455000401").length;
    const s = await post('/v1/auth/register', { phone: '55000401', fullName: 'Shown Code Customer' });
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ ok: true, testMode: true });
    expect(s.body.testCode).toMatch(/^\d{6}$/);
    expect(t.sms.outbox.filter((m) => m.to === "+97455000401").length).toBe(before); // nothing went to the SMS provider
    const r = await post('/v1/auth/register', { phone: '55000401', fullName: 'Shown Code Customer', code: s.body.testCode });
    expect(r.body).toMatchObject({ ok: true, portal: 'customer' });
    // then sign-in works the same way
    await t.deps.pool.query(`update public.otp_send_log set created_at = created_at - interval '2 hours' where phone = '+97455000401'`);
    const st = await post('/v1/auth/start', { phone: '55000401' });
    expect(st.body).toMatchObject({ ok: true, testMode: true });
    const v = await post('/v1/auth/verify', { phone: '55000401', code: st.body.testCode });
    expect(v.body).toMatchObject({ ok: true, portal: 'customer' });
    // the code is never stored or audited
    const dump = JSON.stringify((await t.deps.pool.query('select * from public.audit_logs')).rows) + JSON.stringify((await t.deps.pool.query('select * from public.otp_send_log')).rows);
    expect(dump).not.toContain(String(st.body.testCode));
  });

  it('a staff number on the list is NOT shown (sent normally); an unlisted number is unchanged', async () => {
    const st = await post('/v1/auth/start', { phone: '30000002' });
    expect(st.body.testCode).toBeUndefined();
    expect(t.sms.lastCodeFor('+97430000002')).toMatch(/^\d{6}$/);
    const other = await post('/v1/auth/register', { phone: '55000402', fullName: 'Normal Customer' });
    expect(other.body.testCode).toBeUndefined();
    expect(t.sms.lastCodeFor('+97455000402')).toMatch(/^\d{6}$/);
  });

  it('failed sends (nothing delivered) do not count toward the hourly limit; a test number has no hourly limit', async () => {
    // seven provider failures in the last hour, all older than the 60 s cooldown
    for (let i = 0; i < 7; i++) {
      await t.deps.pool.query(`insert into public.otp_send_log (phone, purpose, channel, outcome, reason, created_at)
        values ('+97455000403', 'REGISTER', 'SMS', 'FAILED', 'provider 401/20003', now() - interval '10 minutes')`);
      await t.deps.pool.query(`insert into public.otp_send_log (phone, purpose, channel, outcome, created_at)
        values ('+97455000401', 'LOGIN', 'TEST', 'SENT', now() - interval '10 minutes')`);
    }
    const r = await post('/v1/auth/register', { phone: '55000403', fullName: 'After Failures' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // (the 60 s cooldown from the first test is moved into the past; the hourly count is not)
    await t.deps.pool.query(`update public.otp_send_log set created_at = now() - interval '5 minutes' where phone = '+97455000401' and created_at > now() - interval '2 minutes'`);
    const st = await post('/v1/auth/start', { phone: '55000401' });
    expect(st.body).toMatchObject({ ok: true, testMode: true });
    // a real number with 7 SENT codes in the hour is still limited
    for (let i = 0; i < 7; i++) {
      await t.deps.pool.query(`insert into public.otp_send_log (phone, purpose, channel, outcome, created_at)
        values ('+97455000404', 'REGISTER', 'SMS', 'SENT', now() - interval '10 minutes')`);
    }
    const lim = await post('/v1/auth/register', { phone: '55000404', fullName: 'Many Codes' });
    expect(lim.status).toBe(429);
  });

  it('production refuses the setting', () => {
    let msg = '';
    try {
      loadConfig({
        APP_ENV: 'production', DATABASE_URL: 'postgresql://u:p@db.example.test:5432/x', DATABASE_SSL: 'require',
        SUPABASE_URL: 'https://x.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x', SUPABASE_SECRET_KEY: 'sb_secret_x',
        CORS_ALLOWED_ORIGINS: 'https://app.example.test', SEND_SMS_HOOK_SECRET: HOOK_SECRET, OTP_TEST_NUMBERS: '55000401',
      });
    } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain('OTP_TEST_NUMBERS is refused in production');
  });
});

/**
 * OTP_TEST_STAFF_NUMBERS (owner decision 2026-10-10): listed staff numbers see their code too — but never a
 * role that needs the authenticator app (SUPER_ADMIN / STAFF_MFA_ROLES), and never in production.
 */
describe.skipIf(!HAS_DB)('OTP_TEST_STAFF_NUMBERS', () => {
  let t: TestApp;
  const post = async (url: string, payload: Record<string, unknown>) => {
    const r = await t.app.inject({ method: 'POST', url, payload });
    return { status: r.statusCode, body: r.json() as Record<string, unknown> };
  };
  beforeAll(async () => {
    t = await createTestApp({ STAFF_SIGN_IN: 'both', STAFF_MFA_ROLES: 'SUPER_ADMIN', OTP_TEST_STAFF_NUMBERS: '30000004, 30000001' });
  });
  afterAll(async () => { await t?.close(); });

  it('a listed partner admin gets the code on screen (nothing sent) and signs in to the partner portal', async () => {
    const before = t.sms.outbox.filter((m) => m.to === '+97430000004').length;
    const st = await post('/v1/auth/start', { phone: '30000004' });
    expect(st.status, JSON.stringify(st.body)).toBe(200);
    expect(st.body).toMatchObject({ ok: true, testMode: true });
    expect(t.sms.outbox.filter((m) => m.to === '+97430000004').length).toBe(before);
    const v = await post('/v1/auth/verify', { phone: '30000004', code: st.body.testCode });
    expect(v.body, JSON.stringify(v.body)).toMatchObject({ ok: true });
    expect(v.body.portal).not.toBe('customer');
  });

  it('a listed SUPER_ADMIN is never shown a code; an unlisted staff number is unchanged', async () => {
    const sa = await post('/v1/auth/start', { phone: '30000001' });
    expect(sa.body.testCode).toBeUndefined();
    expect(t.sms.lastCodeFor('+97430000001')).toMatch(/^\d{6}$/);
    const tech = await post('/v1/auth/start', { phone: '30000003' });
    expect(tech.body.testCode).toBeUndefined();
    expect(t.sms.lastCodeFor('+97430000003')).toMatch(/^\d{6}$/);
  });

  it('production refuses the setting', () => {
    let msg = '';
    try {
      loadConfig({
        APP_ENV: 'production', DATABASE_URL: 'postgresql://u:p@db.example.test:5432/x', DATABASE_SSL: 'require',
        SUPABASE_URL: 'https://x.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x', SUPABASE_SECRET_KEY: 'sb_secret_x',
        CORS_ALLOWED_ORIGINS: 'https://app.example.test', SEND_SMS_HOOK_SECRET: HOOK_SECRET, OTP_TEST_STAFF_NUMBERS: '30000004',
      });
    } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain('OTP_TEST_STAFF_NUMBERS is refused in production');
  });
});

/** "*" (owner decision 2026-10-10): every customer / new number and every non-MFA staff number, normal limits kept. */
describe.skipIf(!HAS_DB)('OTP test codes for every number ("*")', () => {
  let t: TestApp;
  const post = async (url: string, payload: Record<string, unknown>) => {
    const r = await t.app.inject({ method: 'POST', url, payload });
    return { status: r.statusCode, body: r.json() as Record<string, unknown> };
  };
  beforeAll(async () => { t = await createTestApp({ STAFF_SIGN_IN: 'both', STAFF_MFA_ROLES: 'SUPER_ADMIN', OTP_TEST_NUMBERS: '*', OTP_TEST_STAFF_NUMBERS: '*' }); });
  afterAll(async () => { await t?.close(); });

  it('any new number registers with the code on screen; any non-MFA staff number too; SUPER_ADMIN never', async () => {
    const reg = await post('/v1/auth/register', { phone: '55739279', fullName: 'Any New Customer' });
    expect(reg.body).toMatchObject({ ok: true, testMode: true });
    const done = await post('/v1/auth/register', { phone: '55739279', fullName: 'Any New Customer', code: reg.body.testCode });
    expect(done.body).toMatchObject({ ok: true, portal: 'customer' });
    const tech = await post('/v1/auth/start', { phone: '30000003' });
    expect(tech.body).toMatchObject({ ok: true, testMode: true });
    const sa = await post('/v1/auth/start', { phone: '30000001' });
    expect(sa.body.testCode).toBeUndefined();
  });

  it('a SUPER_ADMIN who already has a verified authenticator app gets the code on screen; the app is still required', async () => {
    // first sign-in the normal way (code delivered by the test SMS provider): links the Auth user
    await t.deps.pool.query(`update public.otp_send_log set created_at = created_at - interval '2 hours' where phone = '+97430000001'`);
    await post('/v1/auth/start', { phone: '30000001' });
    const first = await post('/v1/auth/verify', { phone: '30000001', code: t.sms.lastCodeFor('+97430000001') });
    expect(first.body).toMatchObject({ ok: true, mfaRequired: true, mfaEnrolled: false });
    const id = (await t.deps.pool.query(`select auth_user_id from public.app_users where id = 'USR-00001'`)).rows[0].auth_user_id as string;
    t.auth.factors.set(id, [{ id: 'f-1', secret: 'JBSWY3DPEHPK3PXP', verified: true }]);
    await t.deps.pool.query(`update public.otp_send_log set created_at = created_at - interval '2 hours' where phone = '+97430000001'`);
    const st = await post('/v1/auth/start', { phone: '30000001' });
    expect(st.body).toMatchObject({ ok: true, testMode: true });
    const v = await post('/v1/auth/verify', { phone: '30000001', code: st.body.testCode });
    expect(v.body).toMatchObject({ ok: true, mfaRequired: true, mfaEnrolled: true });
    expect(v.body.portal).toBeUndefined();
  });

  it('the normal hourly limit still applies to "*" numbers', async () => {
    for (let i = 0; i < 7; i++) {
      await t.deps.pool.query(`insert into public.otp_send_log (phone, purpose, channel, outcome, created_at)
        values ('+97455000499', 'REGISTER', 'TEST', 'SENT', now() - interval '10 minutes')`);
    }
    const lim = await post('/v1/auth/register', { phone: '55000499', fullName: 'Many Codes' });
    expect(lim.status).toBe(429);
  });
});
