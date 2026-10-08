/**
 * Production blockers closed in 1200:
 *   - SUPER_ADMIN must pass an authenticator-app (TOTP) step (aal2);
 *   - a token whose Supabase session was revoked/ended is refused at once;
 *   - staff reset codes are e-mailed only through the Send Email hook, only
 *     for a request the API made, and no other e-mail type is sent.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HAS_DB } from '../helpers/db.js';
import { HOOK_SECRET, createTestApp, signToken, type TestApp } from '../helpers/app.js';
import { settleBackgroundWork } from '../../apps/api/src/services/staff-auth.js';
import { totp } from '../helpers/totp.js';
import { signWebhook } from '../../apps/api/src/lib/webhooks.js';
import type { Mailer } from '../../apps/api/src/lib/mail/graph.js';
import { loadConfig } from '../../packages/shared/src/config.js';

const GOOD = 'Staging-Demo-2026x';

class FakeMailer implements Mailer {
  sent: { to: string; subject: string; html: string }[] = [];
  fail = false;
  configured() { return true; }
  async send(to: string, subject: string, html: string) {
    if (this.fail) return { ok: false as const, status: 503, code: 'x' };
    this.sent.push({ to, subject, html }); return { ok: true as const };
  }
}

describe.skipIf(!HAS_DB)('SUPER_ADMIN authenticator app, session revocation, reset e-mail hook', () => {
  let t: TestApp;
  const mailer = new FakeMailer();
  const post = async (url: string, payload: Record<string, unknown>, token?: string) => {
    const r = await t.app.inject({ method: 'POST', url, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: r.statusCode, body: r.json() as Record<string, unknown> };
  };
  const login = (email: string, password = GOOD) => post('/v1/auth/staff/login', { email, password });
  const setPassword = async (id: string, email: string) => {
    await t.deps.pool.query('update public.app_users set email = $2 where id = $1', [id, email]);
    await post('/v1/auth/staff/reset/start', { email }); await settleBackgroundWork();
    const code = [...t.auth.mail].reverse().find((m) => m.to === email)!.code;
    return post('/v1/auth/staff/reset/finish', { email, code, password: GOOD });
  };

  beforeAll(async () => {
    t = await createTestApp({ STAFF_SIGN_IN: 'password', STAFF_MFA_ROLES: 'SUPER_ADMIN', SEND_EMAIL_HOOK_SECRET: HOOK_SECRET }, { mailer });
  });
  afterAll(async () => { await t?.close(); });

  let factorId = '';
  let secret = '';

  it('MFA-01 password alone gives SUPER_ADMIN only an "app step required" session that every other endpoint refuses', async () => {
    const r = await setPassword('USR-00001', 'usr-00001@staff.example.test');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ ok: true, mfaRequired: true, mfaEnrolled: false });
    expect(r.body.portal).toBeUndefined();
    const pending = String(r.body.token);
    const me = await t.call('me.context', pending);
    expect(me.status).toBe(403);
    expect(me.body).toMatchObject({ ok: false, code: 'MFA_REQUIRED' });
    expect((await t.call('admin.settlements', pending, {})).status).toBe(403);
    const st = await post('/v1/auth/mfa/status', {}, pending);
    expect(st.body).toMatchObject({ ok: true, required: true, enrolled: false, aal: 'aal1' });
  });

  it('MFA-02 enroll + one correct code → aal2 session with full access; wrong/garbled codes refused', async () => {
    const l = await login('usr-00001@staff.example.test');
    const pending = String(l.body.token);
    const e = await post('/v1/auth/mfa/enroll', {}, pending);
    expect(e.status, JSON.stringify(e.body)).toBe(200);
    factorId = String(e.body.factorId); secret = String(e.body.secret);
    expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
    expect((await post('/v1/auth/mfa/verify', { factorId, code: '12345' }, pending)).status).toBe(422);
    const wrong = totp(secret) === '000000' ? '111111' : '000000';
    expect((await post('/v1/auth/mfa/verify', { factorId, code: wrong }, pending)).status).toBe(422);
    const v = await post('/v1/auth/mfa/verify', { factorId, code: totp(secret) }, pending);
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    expect(v.body).toMatchObject({ ok: true, portal: 'admin' });
    const full = String(v.body.token);
    expect((await t.call('me.context', full)).status).toBe(200);
    // The secret is never stored or audited by the API.
    const dump = JSON.stringify((await t.deps.pool.query('select * from public.audit_logs')).rows);
    expect(dump).not.toContain(secret);
  });

  it('MFA-03 next sign-in: app already set up → code required; a password-only session cannot register another app', async () => {
    const l = await login('usr-00001@staff.example.test');
    expect(l.body).toMatchObject({ mfaRequired: true, mfaEnrolled: true, factorId });
    const pending = String(l.body.token);
    const again = await post('/v1/auth/mfa/enroll', {}, pending);
    expect(again.status).toBe(422);
    const v = await post('/v1/auth/mfa/verify', { factorId, code: totp(secret) }, pending);
    expect(v.status).toBe(200);
  });

  it('MFA-04 five wrong codes pause the app step for that account (429)', async () => {
    const pending = String((await login('usr-00001@staff.example.test')).body.token);
    const good = totp(secret);
    const bad = good === '999999' ? '999998' : '999999';
    for (let i = 0; i < 5; i++) expect((await post('/v1/auth/mfa/verify', { factorId, code: bad }, pending)).status).toBe(422);
    expect((await post('/v1/auth/mfa/verify', { factorId, code: good }, pending)).status).toBe(429);
    await t.deps.pool.query(`update public.mfa_attempts set created_at = created_at - interval '1 hour'`);
  });

  it('MFA-05 other roles are not asked for the app step', async () => {
    const r = await setPassword('USR-00002', 'usr-00002@staff.example.test');
    expect(r.status).toBe(200);
    expect(r.body.mfaRequired).toBeUndefined();
    expect((await t.call('me.context', String(r.body.token))).status).toBe(200);
  });

  it('MFA-06 a forged aal claim does not help: the token signature covers it (aal1 SUPER_ADMIN token → 403)', async () => {
    const id = (await t.deps.pool.query(`select auth_user_id from public.app_users where id = 'USR-00001'`)).rows[0].auth_user_id;
    const aal1 = await signToken(id, '', { email: 'usr-00001@staff.example.test', amr: 'password', aal: 'aal1' });
    expect((await t.call('me.context', aal1)).status).toBe(403);
  });

  it('MAIL-01 hook: unsigned refused; non-recovery e-mails never sent; recovery sent only for a pending API request, once', async () => {
    const email = 'usr-00003@staff.example.test';
    await t.deps.pool.query('update public.app_users set email = $2 where id = $1', ['USR-00003', email]);
    await post('/v1/auth/staff/reset/start', { email }); await settleBackgroundWork(); // provisions the Auth user + reserves RESET_EMAIL
    const uid = (await t.deps.pool.query(`select auth_user_id from public.app_users where id = 'USR-00003'`)).rows[0].auth_user_id;
    const call = async (type: string, code = '123456', secret = HOOK_SECRET) => {
      const body = JSON.stringify({ user: { id: uid, email }, email_data: { token: code, email_action_type: type } });
      const id = `msg_${randomUUID()}`; const ts = String(Math.floor(Date.now() / 1000));
      const r = await t.app.inject({ method: 'POST', url: '/v1/hooks/send-email', payload: body,
        headers: { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': signWebhook(secret, id, ts, body) } });
      return { status: r.statusCode, body: r.json() as Record<string, unknown> };
    };
    expect((await call('recovery', '123456', `v1,whsec_${Buffer.from('wrong-secret-wrong-secret-123').toString('base64')}`)).status).toBe(401);
    for (const type of ['signup', 'magiclink', 'email_change', 'invite']) {
      const r = await call(type);
      expect(r.body).toMatchObject({ error: { http_code: 403 } });
    }
    const ok = await call('recovery', '654321');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({});
    expect(mailer.sent.at(-1)).toMatchObject({ to: email });
    expect(mailer.sent.at(-1)!.html).toContain('654321');
    const replay = await call('recovery', '777777');
    expect(replay.body).toMatchObject({ error: { http_code: 429 } });
    expect(mailer.sent.filter((m) => m.html.includes('777777'))).toHaveLength(0);
    // The code is never stored or audited.
    const dump = JSON.stringify((await t.deps.pool.query('select * from public.audit_logs')).rows);
    expect(dump).not.toContain('654321');
  });
});

describe.skipIf(!HAS_DB)('session revocation (AUTH_SESSION_CHECK)', () => {
  let t: TestApp;
  beforeAll(async () => { t = await createTestApp({ AUTH_SESSION_CHECK: 'true' }); });
  afterAll(async () => { await t?.close(); });

  it('SES-01 live session → accepted; revoked refresh family, ended session, missing session_id → 401', async () => {
    const authId = randomUUID();
    await t.deps.pool.query(`insert into auth.users (id, phone) values ($1, '97430000010')`, [authId]);
    await t.deps.pool.query(`update public.customers set auth_user_id = $1 where id = 'CUS-00001'`, [authId]);
    const sid = randomUUID();
    await t.deps.pool.query('insert into auth.sessions (id, user_id) values ($1, $2)', [sid, authId]);
    await t.deps.pool.query('insert into auth.refresh_tokens (token, user_id, session_id, revoked) values ($1, $2, $3, false)', ['rt1', authId, sid]);
    const tok = await signToken(authId, '+97430000010', { sessionId: sid });
    expect((await t.call('me.context', tok)).status).toBe(200);
    // Supabase revokes the whole family when a used refresh token is replayed.
    await t.deps.pool.query('update auth.refresh_tokens set revoked = true where session_id = $1', [sid]);
    expect((await t.call('me.context', tok)).status).toBe(401);
    await t.deps.pool.query('update auth.refresh_tokens set revoked = false where session_id = $1', [sid]);
    expect((await t.call('me.context', tok)).status).toBe(200);
    // Sign-out deletes the session.
    await t.deps.pool.query('delete from auth.sessions where id = $1', [sid]);
    expect((await t.call('me.context', tok)).status).toBe(401);
    // No session claim at all.
    expect((await t.call('me.context', await signToken(authId, '+97430000010'))).status).toBe(401);
    // A session id that belongs to someone else.
    const other = randomUUID();
    await t.deps.pool.query('insert into auth.sessions (id, user_id) values ($1, $2)', [other, randomUUID()]);
    expect((await t.call('me.context', await signToken(authId, '+97430000010', { sessionId: other }))).status).toBe(401);
  });
});

describe('production config refuses to start without the new protections', () => {
  const base = {
    APP_ENV: 'production', DATABASE_URL: 'postgres://u:p@db.example.com:5432/x', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x',
    SUPABASE_SECRET_KEY: 'sb_secret_x', SUPABASE_JWKS_URL: 'https://x.supabase.co/auth/v1/.well-known/jwks.json', SUPABASE_JWT_ISSUER: 'https://x.supabase.co/auth/v1', SMS_PROVIDER: 'twilio',
    TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_FROM: 'MG1', SEND_SMS_HOOK_SECRET: HOOK_SECRET, CORS_ALLOWED_ORIGINS: 'https://tradein.qatarmobile.qa',
    GRAPH_TENANT_ID: 't', GRAPH_CLIENT_ID: 'c', GRAPH_CLIENT_SECRET: 's', STAFF_MAIL_FROM: 'info@qatarmobile.qa', SEND_EMAIL_HOOK_SECRET: HOOK_SECRET,
  };
  it('CFG-01 defaults: SUPER_ADMIN MFA + session check on; mail configured', () => {
    const c = loadConfig(base);
    expect(c.STAFF_MFA_ROLES).toEqual(['SUPER_ADMIN']);
    expect(c.AUTH_SESSION_CHECK).toBe(true);
    expect(c.staffMailConfigured).toBe(true);
  });
  it('CFG-02 refused: MFA roles without SUPER_ADMIN, session check off, no staff mail, half a Graph config', () => {
    expect(() => loadConfig({ ...base, STAFF_MFA_ROLES: 'QM_ADMIN' })).toThrow(/STAFF_MFA_ROLES/);
    expect(() => loadConfig({ ...base, AUTH_SESSION_CHECK: 'false' })).toThrow(/AUTH_SESSION_CHECK/);
    expect(() => loadConfig({ ...base, SEND_EMAIL_HOOK_SECRET: undefined })).toThrow(/Staff reset e-mail/);
    expect(() => loadConfig({ ...base, GRAPH_CLIENT_SECRET: undefined })).toThrow(/GRAPH_/);
  });
});
