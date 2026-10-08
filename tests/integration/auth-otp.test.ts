/**
 * Sign-in, registration and the Send SMS hook.
 *
 * Supabase Auth itself is replaced by a stub that calls the SAME
 * deliverOtp policy the hook route runs; the hook route is also called
 * directly with Standard Webhooks signatures. Live Supabase: NOT EXECUTED.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { HAS_DB } from '../helpers/db.js';
import { HOOK_SECRET, createTestApp, signToken, type TestApp } from '../helpers/app.js';
import { signWebhook } from '../../apps/api/src/lib/webhooks.js';
import { ok } from '../helpers/flow.js';

describe.skipIf(!HAS_DB)('authentication and OTP delivery', () => {
  let t: TestApp;
  beforeAll(async () => { t = await createTestApp({ OTP_RESEND_COOLDOWN_S: '30', OTP_MAX_SENDS_PER_HOUR: '3' }); });
  afterAll(async () => { await t?.close(); });

  const hook = async (phone: string, otp: string, opts: { secret?: string; ts?: number; tamper?: boolean } = {}) => {
    const body = JSON.stringify({ user: { id: randomUUID(), phone: phone.replace(/^\+/, '') }, sms: { otp } });
    const id = `msg_${randomUUID()}`;
    const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
    const sig = signWebhook(opts.secret ?? HOOK_SECRET, id, ts, body);
    return t.app.inject({
      method: 'POST', url: '/v1/hooks/send-sms', payload: opts.tamper ? body.replace(otp, '000000') : body,
      headers: { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': sig },
    });
  };

  it('unknown number: start says to register, without revealing anything else', async () => {
    const r = await t.app.inject({ method: 'POST', url: '/v1/auth/start', payload: { phone: '55000099' } });
    expect(r.statusCode).toBe(422);
    expect(r.json()).toMatchObject({ ok: false, needsRegistration: true, message: 'We do not have an account for this number.' });
  });

  it('customer registration: code → verify → active customer with a session', async () => {
    const phone = '+97455000101';
    const s1 = await t.app.inject({ method: 'POST', url: '/v1/auth/register', payload: { phone: '55000101', fullName: 'New Demo Customer' } });
    expect(s1.statusCode).toBe(200);
    const code = t.sms.lastCodeFor(phone);
    expect(code).toMatch(/^\d{6}$/);
    const s2 = await t.app.inject({ method: 'POST', url: '/v1/auth/register', payload: { phone: '55000101', fullName: 'New Demo Customer', code } });
    expect(s2.statusCode).toBe(200);
    const body = s2.json();
    expect(body.portal).toBe('customer');
    expect(typeof body.token).toBe('string');
    const me = await t.call('me.context', body.token);
    expect(me.body.role).toBe('CUSTOMER');
    // The code is never stored or audited.
    const dump = JSON.stringify((await t.deps.pool.query('select * from public.audit_logs')).rows) + JSON.stringify((await t.deps.pool.query('select * from public.otp_send_log')).rows);
    expect(dump).not.toContain(code!);
    expect((await t.deps.pool.query(`select purpose from public.otp_send_log where phone = $1`, [phone])).rows[0].purpose).toBe('REGISTER');
  });

  it('staff registration: PENDING with no role and NO session; sign-in refused until approved', async () => {
    const phone = '+97455000102';
    await t.app.inject({ method: 'POST', url: '/v1/auth/register', payload: { phone: '55000102', fullName: 'Demo Applicant', accountType: 'EMPLOYEE' } });
    const r = await t.app.inject({ method: 'POST', url: '/v1/auth/register', payload: { phone: '55000102', fullName: 'Demo Applicant', accountType: 'EMPLOYEE', code: t.sms.lastCodeFor(phone) } });
    expect(r.json()).toMatchObject({ ok: true, pending: true });
    expect(r.json().token).toBeUndefined();
    const u = (await t.deps.pool.query('select role, status from public.app_users where phone = $1', [phone])).rows[0];
    expect(u).toEqual({ role: null, status: 'PENDING_APPROVAL' });
    const start = await t.app.inject({ method: 'POST', url: '/v1/auth/start', payload: { phone: '55000102' } });
    expect(start.json().message).toBe('Your access request is still waiting for administrator approval.');
  });

  it('login for an imported profile (no auth user yet) links on first verified sign-in', async () => {
    await t.deps.pool.query(`insert into public.customers (id, full_name, phone) values ('CUS-00050', 'Imported Demo Customer', '+97455000150')`);
    const s = await t.app.inject({ method: 'POST', url: '/v1/auth/start', payload: { phone: '+974 5500 0150' } });
    expect(s.statusCode).toBe(200);
    const v = await t.app.inject({ method: 'POST', url: '/v1/auth/verify', payload: { phone: '55000150', code: t.sms.lastCodeFor('+97455000150') } });
    expect(v.statusCode).toBe(200);
    const linked = (await t.deps.pool.query(`select auth_user_id from public.customers where id = 'CUS-00050'`)).rows[0].auth_user_id;
    expect(linked).toBeTruthy();
    expect((await t.deps.pool.query(`select 1 from public.audit_logs where action = 'AUTH_PROFILE_LINKED' and object_id = 'CUS-00050'`)).rowCount).toBe(1);
  });

  it('a wrong code is refused; a disabled account cannot start', async () => {
    await t.deps.pool.query(`insert into public.customers (id, full_name, phone, status) values ('CUS-00051', 'Disabled Demo', '+97455000151', 'DISABLED')`);
    const s = await t.app.inject({ method: 'POST', url: '/v1/auth/start', payload: { phone: '55000151' } });
    expect(s.json().message).toBe('This account has been disabled.');
    await t.deps.pool.query(`insert into public.customers (id, full_name, phone) values ('CUS-00052', 'Wrong Code Demo', '+97455000152')`);
    await t.app.inject({ method: 'POST', url: '/v1/auth/start', payload: { phone: '55000152' } });
    const v = await t.app.inject({ method: 'POST', url: '/v1/auth/verify', payload: { phone: '55000152', code: '000000' } });
    expect(v.statusCode).toBe(422);
  });

  it('wrong-code limit (3.1 MAX_ATTEMPTS = 5): the right code is refused after 5 wrong ones until a new code is sent', async () => {
    await t.deps.pool.query(`insert into public.customers (id, full_name, phone) values ('CUS-00054', 'Guess Demo', '+97455000154')`);
    await t.app.inject({ method: 'POST', url: '/v1/auth/start', payload: { phone: '55000154' } });
    const good = t.sms.lastCodeFor('+97455000154')!;
    const wrong = good === '111111' ? '222222' : '111111';
    const msgs: string[] = [];
    // Concurrent guesses are all counted.
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => t.app.inject({ method: 'POST', url: '/v1/auth/verify', payload: { phone: '55000154', code: wrong } })));
    for (const r of rs) { expect(r.statusCode).toBe(422); msgs.push(r.json().message); }
    expect(msgs).toContain('Too many incorrect attempts. Ask for a new code.');
    expect(msgs).toContain('That code is not right or has expired. 4 attempts left.');
    const locked = await t.app.inject({ method: 'POST', url: '/v1/auth/verify', payload: { phone: '55000154', code: good } });
    expect(locked.json().message).toBe('Too many incorrect attempts. Ask for a new code.');
    const audit = (await t.deps.pool.query(`select action from public.audit_logs where action in ('OTP_FAILED','OTP_LOCKED_OUT') and object_id like '%0154'`)).rows.map((r) => r.action);
    expect(audit.filter((x) => x === 'OTP_FAILED')).toHaveLength(4);
    expect(audit.filter((x) => x === 'OTP_LOCKED_OUT')).toHaveLength(1);
    // A new code resets the count.
    await t.deps.pool.query(`update public.otp_send_log set created_at = created_at - interval '40 seconds' where phone = '+97455000154'`);
    await t.deps.pool.query(`update public.otp_verify_attempts set created_at = created_at - interval '40 seconds' where phone = '+97455000154'`);
    await t.app.inject({ method: 'POST', url: '/v1/auth/start', payload: { phone: '55000154' } });
    const fresh = await t.app.inject({ method: 'POST', url: '/v1/auth/verify', payload: { phone: '55000154', code: t.sms.lastCodeFor('+97455000154') } });
    expect(fresh.statusCode).toBe(200);
    expect(fresh.json().token).toBeTruthy();
  });

  it('OTP limits: cooldown across purposes and per-number hourly ceiling', async () => {
    await t.deps.pool.query(`insert into public.customers (id, full_name, phone) values ('CUS-00053', 'Rate Demo', '+97455000153')`);
    const first = await t.app.inject({ method: 'POST', url: '/v1/auth/start', payload: { phone: '55000153' } });
    expect(first.statusCode).toBe(200);
    const second = await t.app.inject({ method: 'POST', url: '/v1/auth/start', payload: { phone: '55000153' } });
    expect(second.statusCode).toBe(429);
    // Age the log to pass the cooldown, then exhaust the hourly ceiling (3 in this test config).
    for (let i = 0; i < 3; i++) {
      await t.deps.pool.query(`update public.otp_send_log set created_at = created_at - interval '40 seconds' where phone = '+97455000153'`);
      await t.app.inject({ method: 'POST', url: '/v1/auth/start', payload: { phone: '55000153' } });
    }
    await t.deps.pool.query(`update public.otp_send_log set created_at = created_at - interval '40 seconds' where phone = '+97455000153'`);
    const limited = await t.app.inject({ method: 'POST', url: '/v1/auth/start', payload: { phone: '55000153' } });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().message).toBe('Too many code requests. Please try again later.');
    expect((await t.deps.pool.query(`select count(*)::int as n from public.otp_send_log where phone = '+97455000153' and outcome = 'SENT'`)).rows[0].n).toBe(3);
  });

  it('hook: valid signature sends; bad signature, tampered body or stale timestamp are rejected', async () => {
    const good = await hook('+97455000160', '482913');
    expect(good.statusCode).toBe(200);
    expect(t.sms.lastCodeFor('+97455000160')).toBe('482913');
    expect((await hook('+97455000161', '111111', { secret: `v1,whsec_${Buffer.from('wrong-secret-wrong-secret').toString('base64')}` })).statusCode).toBe(401);
    expect((await hook('+97455000162', '222222', { tamper: true })).statusCode).toBe(401);
    expect((await hook('+97455000163', '333333', { ts: Math.floor(Date.now() / 1000) - 3600 })).statusCode).toBe(401);
    expect(t.sms.lastCodeFor('+97455000161')).toBeNull();
  });

  it('fail closed: with no SMS provider the hook refuses and nothing is sent', async () => {
    const t2 = await createTestApp({ SMS_PROVIDER: 'none' });
    try {
      const { NoSmsProvider } = await import('../../apps/api/src/lib/sms/provider.js');
      t2.deps.sms = new NoSmsProvider();
      const body = JSON.stringify({ user: { phone: '97455000170' }, sms: { otp: '123456' } });
      const id = 'msg_1'; const ts = String(Math.floor(Date.now() / 1000));
      const r = await t2.app.inject({ method: 'POST', url: '/v1/hooks/send-sms', payload: body,
        headers: { 'content-type': 'application/json', 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': signWebhook(HOOK_SECRET, id, ts, body) } });
      // Supabase Auth's hook protocol: HTTP 200 carrying the refusal; Auth relays http_code to its caller.
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ error: { http_code: 503, message: expect.any(String) } });
      expect((await t2.deps.pool.query(`select 1 from public.audit_logs where action = 'SMS_UNAVAILABLE_FAIL_CLOSED'`)).rowCount).toBe(1);
    } finally { await t2.close(); }
  });

  it('logout-all revokes every existing token for that person', async () => {
    const tok = await t.tokenFor('CUS-00001');
    expect((await t.call('me.context', tok)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 1100));
    const out = await t.app.inject({ method: 'POST', url: '/v1/auth/logout-all', headers: { authorization: `Bearer ${tok}` } });
    expect(out.statusCode).toBe(200);
    expect((await t.call('me.context', tok)).status).toBe(401);
    // A token issued afterwards works.
    const sub = (await t.deps.pool.query(`select auth_user_id from public.customers where id = 'CUS-00001'`)).rows[0].auth_user_id;
    await new Promise((r) => setTimeout(r, 1100));
    expect((await t.call('me.context', await signToken(sub, '+97430000010'))).status).toBe(200);
  });

  it('public endpoints work without a token and expose no prices or fees', async () => {
    const cat = await t.app.inject({ method: 'GET', url: '/v1/public/catalog' });
    expect(cat.statusCode).toBe(200);
    expect(cat.body).not.toMatch(/base_?price|commission/i);
    const vc = await ok(t.call('public.vendorContext', null));
    expect(JSON.stringify(vc)).not.toMatch(/commission|settlement/i);
    const q = await ok(t.call('customer.questions', null));
    expect(JSON.stringify(q)).not.toMatch(/"rules"|"battery"/);
  });

  it('a provider failure is answered 200 + http_code 422 (never 5xx, which Supabase Auth would retry into the cooldown)', async () => {
    const realSend = t.sms.send.bind(t.sms);
    t.sms.send = async () => ({ ok: false as const, status: 401 }) as never;
    try {
      const r = await hook('+97455990011', '123456');
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ error: { http_code: 422 } });
    } finally { t.sms.send = realSend; }
  });
});
