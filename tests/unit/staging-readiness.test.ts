/**
 * Staging/production readiness rules (no database needed).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey } from 'jose';
import { loadConfig } from '../../packages/shared/src/config.js';
import { scrub } from '../../packages/shared/src/logger.js';
import { assertTargetAllowed, describeTarget, isProtected, sslFromEnv, supabaseRefOf } from '../../packages/database/src/target.js';
import { createPool, normalizePem, withoutSslParams, isBrokenConnection } from '../../packages/database/src/db.js';
import { parseTesters } from '../../packages/database/src/seed-staging-cli.js';
import { createTokenVerifier } from '../../packages/auth/src/jwt.js';
import { GoTrueGateway, isLegacyJwtKey } from '../../apps/api/src/lib/gotrue.js';
import { SupabaseStorage } from '../../apps/api/src/lib/storage.js';

const SECRET = 'x'.repeat(40);
const staging = (over: Record<string, string> = {}) => ({
  APP_ENV: 'staging', DATABASE_URL: 'postgres://u:p@h:5432/postgres', SUPABASE_URL: 'https://abcdefghijklmnopqrst.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', SUPABASE_SECRET_KEY: 'sb_secret_test', SUPABASE_JWT_SECRET: SECRET,
  SUPABASE_JWT_ISSUER: 'https://abcdefghijklmnopqrst.supabase.co/auth/v1', SEND_SMS_HOOK_SECRET: 'v1,whsec_dGVzdA==',
  CORS_ALLOWED_ORIGINS: 'https://staging.example.test', SMS_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_FROM: '+1',
  ...over,
});

describe('configuration for staging and production', () => {
  it('idempotency keys are required by default in staging/production and false is refused there', () => {
    expect(loadConfig(staging()).IDEMPOTENCY_KEY_REQUIRED).toBe(true);
    expect(loadConfig(staging({ APP_ENV: 'production' })).IDEMPOTENCY_KEY_REQUIRED).toBe(true);
    expect(() => loadConfig(staging({ IDEMPOTENCY_KEY_REQUIRED: 'false' }))).toThrow(/IDEMPOTENCY_KEY_REQUIRED=false is refused/);
    expect(loadConfig({ APP_ENV: 'test', DATABASE_URL: 'x', SUPABASE_JWT_SECRET: SECRET }).IDEMPOTENCY_KEY_REQUIRED).toBe(false);
  });
  it('production needs a real SMS provider; staging may run with none (fails closed); test is refused in both', () => {
    expect(() => loadConfig(staging({ APP_ENV: 'production', SMS_PROVIDER: 'none' }))).toThrow(/SMS_PROVIDER must be twilio or custom/);
    expect(() => loadConfig(staging({ APP_ENV: 'production', SMS_PROVIDER: 'none', SEND_SMS_HOOK_SECRET: '' }))).toThrow(/SEND_SMS_HOOK_SECRET is required/);
    expect(loadConfig(staging({ SMS_PROVIDER: 'none', SEND_SMS_HOOK_SECRET: '' })).SMS_PROVIDER).toBe('none');
    expect(() => loadConfig(staging({ SEND_SMS_HOOK_SECRET: '' }))).toThrow(/SEND_SMS_HOOK_SECRET is required/);
    expect(() => loadConfig(staging({ SMS_PROVIDER: 'test' }))).toThrow(/SMS_PROVIDER=test is refused/);
  });
  it('production requires a verified database certificate and no debug logging; staging may use no-verify', () => {
    expect(() => loadConfig(staging({ APP_ENV: 'production', DATABASE_SSL: 'no-verify' }))).toThrow(/DATABASE_SSL must be require/);
    expect(() => loadConfig(staging({ APP_ENV: 'production', LOG_LEVEL: 'debug' }))).toThrow(/LOG_LEVEL debug/);
    expect(loadConfig(staging({ DATABASE_SSL: 'no-verify' })).DATABASE_SSL).toBe('no-verify');
  });
  it('new-style Supabase key names are accepted and take precedence', () => {
    const c = loadConfig(staging({ SUPABASE_ANON_KEY: 'old', SUPABASE_SERVICE_ROLE_KEY: 'old' }));
    expect(c.SUPABASE_ANON_KEY).toBe('sb_publishable_test');
    expect(c.SUPABASE_SERVICE_ROLE_KEY).toBe('sb_secret_test');
  });
  it('Supabase and JWKS URLs must be https', () => {
    expect(() => loadConfig(staging({ SUPABASE_JWKS_URL: 'http://x/jwks.json' }))).toThrow(/SUPABASE_JWKS_URL must be https/);
  });
});

describe('database targets (operator commands)', () => {
  it('describes Supabase direct, session and transaction pooler targets without the password', () => {
    const d = describeTarget('postgresql://postgres:SECRETPW@db.abcdefghijklmnopqrst.supabase.co:5432/postgres');
    expect(d).toMatchObject({ projectRef: 'abcdefghijklmnopqrst', mode: 'supabase-direct' });
    expect(d.label).not.toContain('SECRETPW');
    expect(describeTarget('postgresql://postgres.abcdefghijklmnopqrst:pw@aws-0-eu-central-1.pooler.supabase.com:5432/postgres').mode).toBe('supabase-session-pooler');
    expect(describeTarget('postgresql://postgres.abcdefghijklmnopqrst:pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres').mode).toBe('supabase-transaction-pooler');
    expect(describeTarget('postgres://postgres@127.0.0.1:54329/x').mode).toBe('local');
  });
  it('requires confirmation by project ref, refuses protected targets and the transaction pooler for sessions', () => {
    const url = 'postgresql://postgres.abcdefghijklmnopqrst:pw@aws-0-x.pooler.supabase.com:5432/postgres';
    expect(() => assertTargetAllowed(url, { purpose: 'test', env: {} })).toThrow(/MIGRATION_TARGET_CONFIRM=abcdefghijklmnopqrst/);
    expect(assertTargetAllowed(url, { purpose: 'test', env: { MIGRATION_TARGET_CONFIRM: 'abcdefghijklmnopqrst' } }).projectRef).toBe('abcdefghijklmnopqrst');
    expect(() => assertTargetAllowed(url, { purpose: 'test', env: { MIGRATION_TARGET_CONFIRM: 'abcdefghijklmnopqrst', QM_PROTECTED_TARGETS: 'zzz,abcdefghijklmnopqrst' } })).toThrow(/QM_PROTECTED_TARGETS/);
    expect(() => assertTargetAllowed(url.replace(':5432', ':6543'), { purpose: 'test', needsSession: true, env: { MIGRATION_TARGET_CONFIRM: 'abcdefghijklmnopqrst' } })).toThrow(/TRANSACTION pooler/);
    expect(assertTargetAllowed('postgres://postgres@127.0.0.1:1/x', { purpose: 'test', env: {} }).mode).toBe('local');
  });
  it('ssl parameters in the URL cannot override the configured TLS mode; a CA can be pasted on one line or as base64', () => {
    expect(withoutSslParams('postgres://u:p@h:5432/db?sslmode=disable&application_name=x')).toBe('postgres://u:p@h:5432/db?application_name=x');
    const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';
    expect(normalizePem(pem.replace(/\n/g, '\\n'))).toBe(pem);
    expect(normalizePem(Buffer.from(pem).toString('base64'))).toBe(pem);
    expect(normalizePem('not a cert')).toBeUndefined();
  });
  it('a dead connection is recognised so it is not reused', () => {
    expect(isBrokenConnection(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isBrokenConnection(Object.assign(new Error('x'), { code: '57P01' }))).toBe(true);
    expect(isBrokenConnection(new Error('Connection terminated unexpectedly'))).toBe(true);
    expect(isBrokenConnection(Object.assign(new Error('x'), { code: '23505' }))).toBe(false);
  });
});

describe('staging tester mapping', () => {
  it('accepts seeded profiles with valid Qatar numbers, one profile per number', () => {
    expect(parseTesters(JSON.stringify({ _comment: 'x', 'USR-00001': '30001234', 'CUS-00002': '+97450001234' }))).toEqual([
      { id: 'USR-00001', phone: '+97430001234' }, { id: 'CUS-00002', phone: '+97450001234' }]);
    expect(() => parseTesters(JSON.stringify({ 'USR-00001': '30001234', 'USR-00002': '30001234' }))).toThrow(/more than one profile/);
    expect(() => parseTesters(JSON.stringify({ 'USR-12345': '30001234' }))).toThrow(/not a seeded profile/);
    expect(() => parseTesters(JSON.stringify({ 'USR-00001': '+974XXXXXXXX' }))).toThrow(/not a valid Qatar mobile/);
  });
  it('staff may be mapped to a work email (or both); customers need a phone; one address per profile', () => {
    expect(parseTesters(JSON.stringify({ 'USR-00001': 'Ops.Lead@Example.test', 'USR-00002': { phone: '30001235', email: 'fin@example.test' } }))).toEqual([
      { id: 'USR-00001', email: 'ops.lead@example.test' }, { id: 'USR-00002', phone: '+97430001235', email: 'fin@example.test' }]);
    expect(() => parseTesters(JSON.stringify({ 'CUS-00001': 'c@example.test' }))).toThrow(/customers sign in with their mobile/);
    expect(() => parseTesters(JSON.stringify({ 'USR-00001': 'a@example.test', 'USR-00002': 'A@example.test' }))).toThrow(/more than one profile/);
    expect(() => parseTesters(JSON.stringify({ 'USR-00001': { email: 'not-an-email' } }))).toThrow(/not a valid email/);
  });
});

describe('Supabase keys and log scrubbing', () => {
  it('new keys go only in apikey; legacy JWT keys may also be the bearer', async () => {
    expect(isLegacyJwtKey('sb_publishable_abc')).toBe(false);
    expect(isLegacyJwtKey('eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.c2ln')).toBe(true);
    const seen: Record<string, string>[] = [];
    const f = (async (_u: string, init: { headers: Record<string, string> }) => { seen.push(init.headers); return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
    await new GoTrueGateway('https://x.supabase.co', 'sb_publishable_abc', f).sendOtp('+97430000001', false);
    expect(seen[0]!.apikey).toBe('sb_publishable_abc');
    expect(seen[0]!.Authorization).toBeUndefined();
    await new SupabaseStorage('https://x.supabase.co', 'sb_secret_abc', f).remove('catalog-media', 'a/b.png');
    expect(seen[1]!.apikey).toBe('sb_secret_abc');
    expect(seen[1]!.Authorization).toBeUndefined();
    await new GoTrueGateway('https://x.supabase.co', 'sb_publishable_abc', f).logout('user.token.value', 'global');
    expect(seen[2]!.Authorization).toBe('Bearer user.token.value');
  });
  it('client IP forwarding (opt-in): new secret key + Sb-Forwarded-For on public Auth calls only; never with a user token, legacy key or a non-IP value', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const f = (async (url: string, init: { headers: Record<string, string> }) => {
      seen.push({ url, headers: init.headers });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const on = new GoTrueGateway('https://x.supabase.co', 'sb_publishable_abc', f, 'sb_secret_xyz', true);
    await on.sendOtp('+97430000001', false, '203.0.113.7');
    expect(seen[0]!.headers.apikey).toBe('sb_secret_xyz');
    expect(seen[0]!.headers['Sb-Forwarded-For']).toBe('203.0.113.7');
    expect(seen[0]!.headers.Authorization).toBeUndefined();
    await on.setPassword('user.token.value', 'Whatever-2026x');
    expect(seen[1]!.headers.apikey).toBe('sb_publishable_abc');
    expect(seen[1]!.headers['Sb-Forwarded-For']).toBeUndefined();
    await on.sendOtp('+97430000001', false, '1.2.3.4\r\nX-Evil: 1');
    expect(seen[2]!.headers['Sb-Forwarded-For']).toBeUndefined();
    expect(seen[2]!.headers.apikey).toBe('sb_publishable_abc');
    const legacy = new GoTrueGateway('https://x.supabase.co', 'sb_publishable_abc', f, 'eyJa.eyJb.c', true);
    await legacy.sendOtp('+97430000001', false, '203.0.113.7');
    expect(seen[3]!.headers['Sb-Forwarded-For']).toBeUndefined();
    const off = new GoTrueGateway('https://x.supabase.co', 'sb_publishable_abc', f, 'sb_secret_xyz');
    await off.sendOtp('+97430000001', false, '203.0.113.7');
    expect(seen[4]!.headers['Sb-Forwarded-For']).toBeUndefined();
    expect(seen[4]!.headers.apikey).toBe('sb_publishable_abc');
  });

  it('a 200 from Supabase Auth that is not a session is "unavailable", never "wrong password"', async () => {
    const f = (async () => new Response('not json', { status: 200 })) as unknown as typeof fetch;
    const r = await new GoTrueGateway('https://x.supabase.co', 'sb_publishable_abc', f).passwordLogin('a@b.qa', 'x');
    expect(r).toMatchObject({ ok: false, status: 502 });
  });
  it('scrubs new-style keys and passwords in connection strings', () => {
    const s = scrub('key sb_secret_AbC123 and postgres://postgres.ref:hunter2@aws-0.pooler.supabase.com:5432/postgres');
    expect(s).not.toContain('sb_secret_AbC123');
    expect(s).not.toContain('hunter2');
  });
});

describe('token verification during a Supabase signing-key rotation', () => {
  let server: Server; let jwksUrl = ''; let priv: CryptoKey;
  beforeAll(async () => {
    const kp = await generateKeyPair('ES256');
    priv = kp.privateKey;
    const jwk = { ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
    server = createServer((_q, r) => { r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify({ keys: [jwk] })); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    jwksUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/auth/v1/.well-known/jwks.json`;
  });
  afterAll(() => { server.close(); });

  const claims = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ role: 'authenticated', ...extra });
  const es = (c = claims()) => new SignJWT(c).setProtectedHeader({ alg: 'ES256', kid: 'k1' }).setSubject('u1').setAudience('authenticated').setIssuer('iss').setIssuedAt().setExpirationTime('5m').sign(priv);
  const hs = (c = claims()) => new SignJWT(c).setProtectedHeader({ alg: 'HS256' }).setSubject('u1').setAudience('authenticated').setIssuer('iss').setIssuedAt().setExpirationTime('5m').sign(new TextEncoder().encode(SECRET));

  it('accepts asymmetric (JWKS) and legacy (HS256) tokens when both are configured', async () => {
    const v = createTokenVerifier({ jwksUrl, secret: SECRET, issuer: 'iss', audience: 'authenticated' });
    expect((await v(await es()))?.sub).toBe('u1');
    expect((await v(await hs()))?.sub).toBe('u1');
  });
  it('JWKS only: an HS256 token is refused (no algorithm confusion); alg none refused', async () => {
    const v = createTokenVerifier({ jwksUrl, issuer: 'iss', audience: 'authenticated' });
    expect(await v(await hs())).toBeNull();
    const t = await es();
    const none = `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${t.split('.')[1]}.`;
    expect(await v(none)).toBeNull();
  });
  it('wrong issuer, service_role, anon, missing role and anonymous sign-ins are refused', async () => {
    const v = createTokenVerifier({ jwksUrl, secret: SECRET, issuer: 'iss', audience: 'authenticated' });
    const other = await new SignJWT(claims()).setProtectedHeader({ alg: 'ES256', kid: 'k1' }).setSubject('u1').setAudience('authenticated').setIssuer('other').setIssuedAt().setExpirationTime('5m').sign(priv);
    expect(await v(other)).toBeNull();
    expect(await v(await es({ role: 'service_role' }))).toBeNull();
    expect(await v(await es({ role: 'anon' }))).toBeNull();
    expect(await v(await es({ role: undefined }))).toBeNull();
    expect(await v(await es(claims({ is_anonymous: true })))).toBeNull();
  });
});

describe('copied templates', () => {
  it('an empty variable means "not set" (KEY= cannot silently switch a protection off)', () => {
    const c = loadConfig(staging({ IDEMPOTENCY_KEY_REQUIRED: '', SUPABASE_JWKS_URL: '', LOG_LEVEL: '' }));
    expect(c.IDEMPOTENCY_KEY_REQUIRED).toBe(true);
    expect(c.LOG_LEVEL).toBe('info');
  });
});

describe('target guard bypass attempts (independent review findings)', () => {
  const ref = 'abcdefghijklmnopqrst';
  it('URL parameters that would redirect the connection are refused', () => {
    expect(() => describeTarget(`postgres://u:p@localhost/postgres?host=db.${ref}.supabase.co`)).toThrow(/"host" is not allowed/);
    expect(() => describeTarget('postgres://u:p@localhost/postgres?options=-c%20default_transaction_read_only%3Doff')).toThrow(/"options" is not allowed/);
    expect(() => describeTarget('postgres://u:p@localhost/postgres?port=6543')).toThrow(/"port" is not allowed/);
    expect(describeTarget('postgres://u:p@localhost/postgres?sslmode=require&application_name=x').mode).toBe('local');
  });
  it('a URL without a host is refused; an empty confirmation never matches', () => {
    expect(() => describeTarget('postgres:///postgres')).toThrow(/name its host/);
    expect(() => assertTargetAllowed(`postgresql://postgres.${ref}:pw@aws-0-x.pooler.supabase.com:5432/postgres`, { purpose: 't', env: { MIGRATION_TARGET_CONFIRM: '  ' } })).toThrow(/MIGRATION_TARGET_CONFIRM/);
  });
  it('lookalike hosts are not local; PG* environment overrides are refused', () => {
    expect(describeTarget('postgres://u:p@127.0.0.1.evil.example:5432/x').mode).toBe('other');
    expect(() => assertTargetAllowed('postgres://u@127.0.0.1:5432/x', { purpose: 't', env: { PGHOST: 'db.x.supabase.co' } })).toThrow(/unset PGHOST/);
  });
  it('protection matches by project ref or host, case-insensitively; Supabase URLs map to refs', () => {
    expect(isProtected({ projectRef: ref, host: 'h' }, { QM_PROTECTED_TARGETS: ` ${ref.toUpperCase()} , other` })).toBe(true);
    expect(isProtected({ projectRef: null, host: 'db.example.com' }, { QM_PROTECTED_TARGETS: 'db.example.com' })).toBe(true);
    expect(supabaseRefOf(`https://${ref}.supabase.co`)).toBe(ref);
    expect(supabaseRefOf('https://example.com')).toBeNull();
  });
  it('operator TLS: verified by default for remote targets; disable refused remotely; local defaults to no TLS', () => {
    expect(sslFromEnv({}, `postgresql://postgres.${ref}:pw@aws-0-x.pooler.supabase.com:5432/postgres`).ssl).toBe('require');
    expect(() => sslFromEnv({ DATABASE_SSL: 'disable' }, `postgresql://postgres.${ref}:pw@aws-0-x.pooler.supabase.com:5432/postgres`)).toThrow(/refused for a non-local/);
    expect(sslFromEnv({}, 'postgres://u@127.0.0.1:5432/x').ssl).toBe('disable');
  });
  it('an invalid DATABASE_SSL_CA is named, not silently ignored', () => {
    expect(() => loadConfig(staging({ DATABASE_SSL_CA: '/home/me/ca.crt' }))).toThrow(/DATABASE_SSL_CA is not a PEM certificate/);
    expect(() => createPool({ connectionString: 'postgres://u@127.0.0.1:1/x', sslCa: '/home/me/ca.crt' })).toThrow(/DATABASE_SSL_CA is set but is not a PEM/);
  });
});
