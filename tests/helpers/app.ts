/**
 * A test instance of the API: real Fastify app, real PostgreSQL (a fresh
 * clone per test file), a STUB of Supabase Auth that drives the real Send
 * SMS hook logic, in-memory storage and the test SMS provider.
 *
 * Secrets are generated per run — nothing here is a real credential.
 */
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { FastifyInstance } from 'fastify';
import { createTokenVerifier } from '../../packages/auth/src/jwt.js';
import { createPool } from '../../packages/database/src/db.js';
import { loadConfig } from '../../packages/shared/src/config.js';
import { createLogger } from '../../packages/shared/src/logger.js';
import { buildApp } from '../../apps/api/src/app.js';
import type { Deps } from '../../apps/api/src/context.js';
import type { AuthGateway, AuthSession, AuthUserInfo, GatewayError, MfaEnrollment, MfaFactor } from '../../apps/api/src/lib/gotrue.js';
import { base32Secret, totp } from './totp.js';
import { deliverOtp, mfaEnrolledVia } from '../../apps/api/src/lib/otp.js';
import { TestSmsProvider } from '../../apps/api/src/lib/sms/provider.js';
import { MemoryStorage } from '../../apps/api/src/lib/storage.js';
import { freshDatabase } from './db.js';
import type { Mailer } from '../../apps/api/src/lib/mail/graph.js';

export const JWT_SECRET = randomBytes(36).toString('base64url');
export const HOOK_SECRET = `v1,whsec_${randomBytes(32).toString('base64')}`;

export async function signToken(sub: string, phone: string, opts: { iatOffsetS?: number; expS?: number; role?: string; email?: string; amr?: string | string[]; aal?: string; sessionId?: string } = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000) + (opts.iatOffsetS ?? 0);
  const extra: Record<string, unknown> = {};
  if (opts.email) extra.email = opts.email;
  const methods = Array.isArray(opts.amr) ? opts.amr : [opts.amr ?? 'otp'];
  extra.amr = methods.map((method) => ({ method, timestamp: now }));
  extra.aal = opts.aal ?? (methods.includes('totp') ? 'aal2' : 'aal1');
  if (opts.sessionId) extra.session_id = opts.sessionId;
  return new SignJWT({ phone: phone.replace(/^\+/, ''), role: opts.role ?? 'authenticated', ...extra })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(sub).setAudience('authenticated').setIssuedAt(now).setExpirationTime(now + (opts.expS ?? 3600))
    .sign(new TextEncoder().encode(JWT_SECRET));
}

/**
 * Stub of Supabase Auth. sendOtp generates a code and calls the SAME
 * deliverOtp the real hook route calls; verifyOtp checks it, creates the
 * auth user if needed, and issues a signed token.
 */
export class StubAuth implements AuthGateway {
  codes = new Map<string, string>();
  constructor(private readonly deps: () => Deps, private readonly sms: TestSmsProvider) {}
  async sendOtp(phone: string, createUser: boolean): Promise<{ ok: true } | GatewayError> {
    const d = this.deps();
    const exists = await d.pool.query('select 1 from auth.users where phone = $1', [phone.replace(/^\+/, '')]);
    if (!exists.rowCount && !createUser) return { ok: false, status: 422, code: 'otp_disabled' };
    const code = String(randomInt(100000, 999999));
    const r = await deliverOtp(d.pool, d.config, this.sms, phone, code, mfaEnrolledVia(this));
    if (!r.ok) return { ok: false, status: r.httpCode, code: r.reason.toLowerCase() };
    this.codes.set(phone, code);
    return { ok: true };
  }
  async verifyOtp(phone: string, code: string): Promise<({ ok: true } & AuthSession) | GatewayError> {
    if (this.codes.get(phone) !== code) return { ok: false, status: 403, code: 'otp_expired' };
    this.codes.delete(phone);
    const d = this.deps();
    const p = phone.replace(/^\+/, '');
    const u = (await d.pool.query<{ id: string; email: string | null }>('select id, email from auth.users where phone = $1', [p])).rows[0];
    let id = u?.id;
    if (!id) { id = randomUUID(); await d.pool.query('insert into auth.users (id, phone) values ($1, $2)', [id, p]); }
    // Like GoTrue: the token carries the user's email too when the user has one; the method is "otp".
    return { ok: true, accessToken: await signToken(id, phone, { email: u?.email ?? undefined }), refreshToken: randomBytes(16).toString('hex'), expiresIn: 3600, userId: id };
  }
  async refresh() { return { ok: false as const, status: 400, code: 'invalid_grant' }; }
  async logout() { return { ok: true }; }

  /* ---- email + password, like Supabase Auth (passwords kept in memory only) ---- */
  passwords = new Map<string, string>();
  recoveryCodes = new Map<string, string>();
  /** Every reset code "e-mailed": the test reads them here. */
  mail: { to: string; code: string }[] = [];
  /** Make the next admin call fail with this status (resilience tests). */
  failAdmin: number | null = null;

  private async userByEmail(email: string) {
    return (await this.deps().pool.query<{ id: string; phone: string | null; email: string; email_confirmed_at: Date | null }>(
      'select id, phone, email, email_confirmed_at from auth.users where lower(email) = lower($1)', [email])).rows[0];
  }
  private async session(id: string, phone: string | null, email: string, amr: string) {
    return { ok: true as const, accessToken: await signToken(id, phone ?? '', { email, amr }), refreshToken: randomBytes(16).toString('hex'), expiresIn: 3600, userId: id };
  }
  async passwordLogin(email: string, password: string): Promise<({ ok: true } & AuthSession) | GatewayError> {
    const u = await this.userByEmail(email);
    if (!u || !u.email_confirmed_at || this.passwords.get(u.id) !== password) return { ok: false, status: 400, code: 'invalid_credentials' };
    return this.session(u.id, u.phone, u.email, 'password');
  }
  async sendRecovery(email: string): Promise<{ ok: true } | GatewayError> {
    const u = await this.userByEmail(email);
    if (u) {
      const code = String(randomInt(100000, 999999));
      this.recoveryCodes.set(u.email.toLowerCase(), code);
      this.mail.push({ to: u.email.toLowerCase(), code });
    }
    return { ok: true };
  }
  async verifyRecovery(email: string, code: string): Promise<({ ok: true } & AuthSession) | GatewayError> {
    const u = await this.userByEmail(email);
    if (!u || this.recoveryCodes.get(u.email.toLowerCase()) !== code) return { ok: false, status: 403, code: 'otp_expired' };
    this.recoveryCodes.delete(u.email.toLowerCase());
    return this.session(u.id, u.phone, u.email, 'recovery');
  }
  async setPassword(accessToken: string, password: string): Promise<{ ok: true } | GatewayError> {
    const { payload } = await jwtVerify(accessToken, new TextEncoder().encode(JWT_SECRET));
    const id = String(payload.sub);
    if (this.passwords.get(id) === password) return { ok: false, status: 422, code: 'same_password' };
    this.passwords.set(id, password);
    return { ok: true };
  }
  private adminFailure(): GatewayError | null {
    if (this.failAdmin === null) return null;
    const status = this.failAdmin; this.failAdmin = null;
    return { ok: false, status, code: 'stub_failure' };
  }
  async adminGetUser(id: string): Promise<({ ok: true } & AuthUserInfo) | GatewayError> {
    const f = this.adminFailure(); if (f) return f;
    const u = (await this.deps().pool.query<{ id: string; email: string | null; email_confirmed_at: Date | null; phone: string | null }>(
      'select id, email, email_confirmed_at, phone from auth.users where id = $1', [id])).rows[0];
    return u ? { ok: true, id: u.id, email: u.email, emailConfirmed: !!u.email_confirmed_at, phone: u.phone ?? '',
      mfaVerified: (this.factors.get(u.id) ?? []).some((f) => f.verified) } : { ok: false, status: 404, code: 'user_not_found' };
  }
  async adminCreateUser(email: string, password: string): Promise<({ ok: true } & AuthUserInfo) | GatewayError> {
    const f = this.adminFailure(); if (f) return f;
    if (await this.userByEmail(email)) return { ok: false, status: 422, code: 'email_exists' };
    const id = randomUUID();
    await this.deps().pool.query(`insert into auth.users (id, email, email_confirmed_at, raw_app_meta_data) values ($1, $2, now(), '{"qm_staff": true}')`, [id, email]);
    this.passwords.set(id, password);
    return { ok: true, id, email, emailConfirmed: true };
  }
  async adminUpdateUser(id: string, email: string, password: string): Promise<{ ok: true } | GatewayError> {
    const f = this.adminFailure(); if (f) return f;
    const other = await this.userByEmail(email);
    if (other && other.id !== id) return { ok: false, status: 422, code: 'email_exists' };
    await this.deps().pool.query(`update auth.users set email = $2, email_confirmed_at = now(), raw_app_meta_data = raw_app_meta_data || '{"qm_staff": true}' where id = $1`, [id, email]);
    this.passwords.set(id, password);
    return { ok: true };
  }
  async adminSetPhone(id: string, phone: string): Promise<{ ok: true } | GatewayError> {
    const f = this.adminFailure(); if (f) return f;
    const p = phone.replace(/^\+/, '');
    const other = (await this.deps().pool.query<{ id: string }>('select id from auth.users where phone = $1', [p])).rows[0];
    if (other && other.id !== id) return { ok: false, status: 422, code: 'phone_exists' };
    await this.deps().pool.query('update auth.users set phone = $2 where id = $1', [id, p]);
    return { ok: true };
  }
  async adminDeleteUser(id: string): Promise<{ ok: true } | GatewayError> {
    await this.deps().pool.query('update public.app_users set auth_user_id = null where auth_user_id = $1', [id]);
    await this.deps().pool.query('delete from auth.users where id = $1', [id]);
    this.passwords.delete(id);
    return { ok: true };
  }

  /* ---- TOTP factors, like Supabase Auth (secrets in memory) ---- */
  factors = new Map<string, { id: string; secret: string; verified: boolean }[]>();
  private async claimsOf(token: string) {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(JWT_SECRET));
    return payload as { sub: string; email?: string; phone?: string; aal?: string; amr?: { method: string }[] };
  }
  async mfaFactors(token: string): Promise<({ ok: true; factors: MfaFactor[] }) | GatewayError> {
    const c = await this.claimsOf(token);
    return { ok: true, factors: (this.factors.get(c.sub) ?? []).map((f) => ({ id: f.id, type: 'totp', status: f.verified ? 'verified' : 'unverified', friendlyName: 'app' })) };
  }
  async mfaEnroll(token: string): Promise<({ ok: true } & MfaEnrollment) | GatewayError> {
    const c = await this.claimsOf(token);
    const list = this.factors.get(c.sub) ?? [];
    // Supabase: with a verified factor, enrolling another needs an aal2 session.
    if (list.some((f) => f.verified) && c.aal !== 'aal2') return { ok: false, status: 422, code: 'insufficient_aal' };
    const f = { id: randomUUID(), secret: base32Secret(), verified: false };
    this.factors.set(c.sub, [...list, f]);
    return { ok: true, factorId: f.id, qrCode: '<?xml version="1.0" encoding="utf-8"?>\n<!-- Generated by SVGo -->\n<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>', secret: f.secret, uri: `otpauth://totp/QM:${c.email}?secret=${f.secret}` };
  }
  async mfaVerify(token: string, factorId: string, code: string): Promise<({ ok: true } & AuthSession) | GatewayError> {
    const c = await this.claimsOf(token);
    const f = (this.factors.get(c.sub) ?? []).find((x) => x.id === factorId);
    if (!f) return { ok: false, status: 404, code: 'mfa_factor_not_found' };
    if (![totp(f.secret), totp(f.secret, Date.now(), -1)].includes(code)) return { ok: false, status: 422, code: 'mfa_verification_failed' };
    f.verified = true;
    // Like GoTrue: the first factor's method stays in amr next to "totp".
    const first = (c.amr ?? []).map((a) => a.method).filter((m) => m !== 'totp');
    return { ok: true, accessToken: await signToken(c.sub, c.phone ?? '', { email: c.email, amr: ['totp', ...(first.length ? first : ['password'])] }), refreshToken: randomBytes(16).toString('hex'), expiresIn: 3600, userId: c.sub };
  }
}

export interface TestApp {
  app: FastifyInstance;
  deps: Deps;
  sms: TestSmsProvider;
  storage: MemoryStorage;
  auth: StubAuth;
  close: () => Promise<void>;
  /** Link a seeded profile to a fresh auth user and return a bearer token. */
  tokenFor: (profileId: string) => Promise<string>;
  /** POST /v1/actions/:action with a token and optional idempotency key. */
  call: (action: string, token: string | null, params?: Record<string, unknown>, key?: string) => Promise<{ status: number; body: Record<string, unknown> }>;
}

export async function createTestApp(envOverrides: Record<string, string> = {}, opts: { storage?: MemoryStorage; mailer?: Mailer } = {}): Promise<TestApp> {
  const db = await freshDatabase();
  const config = loadConfig({
    APP_ENV: 'test', DATABASE_URL: db.url, DATABASE_SSL: 'disable', DATABASE_POOL_MAX: '20', LOG_LEVEL: 'silent',
    SUPABASE_JWT_SECRET: JWT_SECRET, SEND_SMS_HOOK_SECRET: HOOK_SECRET, SMS_PROVIDER: 'test',
    CORS_ALLOWED_ORIGINS: 'https://app.example.test', RATE_LIMIT_MAX: '100000', AUTH_RATE_LIMIT_MAX: '10000', ...envOverrides,
  });
  const pool = createPool({ connectionString: db.url, max: 20, ssl: 'disable', applicationName: 'qm-test' });
  const sms = new TestSmsProvider();
  const storage = opts.storage ?? new MemoryStorage();
  let deps!: Deps;
  const auth = new StubAuth(() => deps, sms);
  deps = {
    config, pool, log: createLogger('silent'), sms, storage, authGateway: auth,
    verifyToken: createTokenVerifier({ secret: JWT_SECRET, audience: 'authenticated' }),
    mailer: opts.mailer,
  };
  const app = await buildApp(deps);

  const tokenFor = async (profileId: string) => {
    const table = profileId.startsWith('USR-') ? 'app_users' : 'customers';
    const row = (await pool.query<{ phone: string; auth_user_id: string | null }>(`select phone, auth_user_id from public.${table} where id = $1`, [profileId])).rows[0];
    if (!row) throw new Error(`no profile ${profileId}`);
    let sub = row.auth_user_id;
    if (!sub) {
      sub = randomUUID();
      await pool.query('insert into auth.users (id, phone) values ($1, $2)', [sub, row.phone.replace(/^\+/, '')]);
      await pool.query(`update public.${table} set auth_user_id = $1 where id = $2`, [sub, profileId]);
    }
    return signToken(sub, row.phone);
  };

  const call = async (action: string, token: string | null, params: Record<string, unknown> = {}, key?: string) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    if (key) headers['idempotency-key'] = key;
    const res = await app.inject({ method: 'POST', url: `/v1/actions/${action}`, headers, payload: JSON.stringify({ params }) });
    return { status: res.statusCode, body: res.json() as Record<string, unknown> };
  };

  return {
    app, deps, sms, storage, auth, tokenFor, call,
    close: async () => { await app.close(); await pool.end(); await db.drop(); },
  };
}

/** A fresh, valid idempotency key. */
export const idemKey = (): string => randomBytes(18).toString('base64url');

/** Fifteen digits with a valid Luhn check digit. */
export function makeImei(prefix = '35'): string {
  let body = prefix;
  while (body.length < 14) body += String(randomInt(0, 10));
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    let d = Number(body[i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return body + String((10 - (sum % 10)) % 10);
}

export const GOOD_ANSWERS = {
  POWER: 'ON', SCREEN: 'PERFECT', BODY: 'EXCELLENT', CAMERA: 'OK', CHARGING: 'OK', BIOMETRIC: 'OK', BATTERY: 'GOOD', ACTIVATION_LOCK: 'YES',
};
