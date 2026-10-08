/** Shared helpers: money, text, time, config, logging, webhooks, errors. */
import { describe, expect, it } from 'vitest';
import { applyFraction4, centsToDecimal, formatMoney, parseScaled, roundRatio, toCents, variance } from '../../packages/shared/src/money.js';
import { canonicalJson, csvSafeCell, isValidImei, maskImei, maskPhone, normalizePhone, phoneKey, safeEquals, storageOrder } from '../../packages/shared/src/text.js';
import { businessDate, businessDateCompact, inDateRange, parseDayEnd, parseDayStart } from '../../packages/shared/src/time.js';
import { ConfigError, loadConfig } from '../../packages/shared/src/config.js';
import { scrub } from '../../packages/shared/src/logger.js';
import { fromPgError } from '../../packages/shared/src/errors.js';
import { signWebhook, verifyWebhook } from '../../apps/api/src/lib/webhooks.js';
import { sniffImageMime, validateImage } from '../../apps/api/src/lib/storage.js';
import { sanitizeAuditValue } from '../../apps/api/src/lib/audit.js';
import { randomBytes } from 'node:crypto';

describe('money', () => {
  it('parses decimals exactly and rounds halves up', () => {
    expect(toCents('1400.00')).toBe(140000);
    expect(toCents(1.005)).toBe(101);
    expect(toCents('0.125')).toBe(13);
    expect(toCents(-1.005)).toBe(-100);       // Math.round semantics: half toward +∞
    expect(toCents('1,234.5')).toBe(123450);
    expect(parseScaled('abc', 2)).toBeNull();
    expect(() => toCents('NaN')).toThrow();
  });
  it('formats and converts', () => {
    expect(centsToDecimal(-5)).toBe('-0.05');
    expect(formatMoney(123456789)).toBe('1,234,567.89');
    expect(applyFraction4(200000, 7000)).toBe(140000);
    expect(roundRatio(-5n, 2n)).toBe(-2n);
  });
  it('variance as 3.1 stored it', () => {
    expect(variance(140000, 100000)).toEqual({ amount: -40000, percent: '-28.57' });
    expect(variance(0, 100)).toEqual({ amount: 100, percent: null });
  });
});

describe('text', () => {
  it('Qatar phone numbers', () => {
    expect(normalizePhone('5512 3456')).toBe('+97455123456');
    expect(normalizePhone('0097455123456')).toBe('+97455123456');
    expect(normalizePhone('12345678')).toBe('');
    expect(normalizePhone('5512345')).toBe('');
    expect(phoneKey('+974 5512-3456')).toBe('55123456');
    expect(maskPhone('+97455123456')).toBe('••••3456');
  });
  it('IMEI Luhn and masking', () => {
    expect(isValidImei('490154203237518')).toBe(true);
    expect(isValidImei('490154203237519')).toBe(false);
    expect(maskImei('490154203237518')).toBe('490154*****7518');
  });
  it('CSV cells are formula-neutralised; numbers stay numbers', () => {
    expect(csvSafeCell('=1+1')).toBe('"\'=1+1"');
    expect(csvSafeCell('-5')).toBe('"-5"');
    expect(csvSafeCell('  @SUM(A1)')).toBe('"\'  @SUM(A1)"');
    expect(csvSafeCell(`a"b`)).toBe('"a""b"');
    expect(csvSafeCell(String.fromCharCode(0x2028) + '=x')).toBe(`"'${String.fromCharCode(0x2028)}=x"`);
  });
  it('misc', () => {
    expect(safeEquals('abc', 'abc')).toBe(true);
    expect(safeEquals('abc', 'abd')).toBe(false);
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
    expect(['64GB', '128GB', '1TB', 'weird'].map(storageOrder)).toEqual([5, 9, 65, 99]);
  });
});

describe('Qatar business days', () => {
  it('a day starts at 21:00 UTC the previous evening', () => {
    expect(parseDayStart('2026-10-08')!.toISOString()).toBe('2026-10-07T21:00:00.000Z');
    expect(parseDayEnd('2026-10-08')!.toISOString()).toBe('2026-10-08T20:59:59.999Z');
    expect(businessDate(new Date('2026-10-07T21:30:00Z'))).toBe('2026-10-08');
    expect(businessDateCompact(new Date('2026-10-07T20:59:00Z'))).toBe('20261007');
  });
  it('ranges are inclusive at both ends, whole days', () => {
    expect(inDateRange(new Date('2026-10-08T20:59:59Z'), '2026-10-08', '2026-10-08')).toBe(true);
    expect(inDateRange(new Date('2026-10-08T21:00:00Z'), '2026-10-08', '2026-10-08')).toBe(false);
    expect(inDateRange(null, '2026-10-08', null)).toBe(false);
    expect(parseDayStart('2026-02-30')).toBeNull();
  });
});

describe('configuration refuses unsafe settings', () => {
  const base = { DATABASE_URL: 'postgres://x', SUPABASE_JWT_SECRET: randomBytes(40).toString('hex') };
  const prod = {
    ...base, APP_ENV: 'production', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'srv',
    SEND_SMS_HOOK_SECRET: 'v1,whsec_x', SUPABASE_JWT_ISSUER: 'https://x.supabase.co/auth/v1', CORS_ALLOWED_ORIGINS: 'https://app.example',
    SMS_PROVIDER: 'custom', CUSTOM_SMS_URL: 'https://sms.example/send',
  };
  it('the test SMS provider can never be enabled in production or staging', () => {
    expect(() => loadConfig({ ...prod, SMS_PROVIDER: 'test' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...prod, APP_ENV: 'staging', SMS_PROVIDER: 'test' })).toThrow(/SMS_PROVIDER=test/);
    expect(loadConfig({ ...base, APP_ENV: 'test', SMS_PROVIDER: 'test' }).SMS_PROVIDER).toBe('test');
  });
  it('APP_ENV defaults to production (fail closed)', () => {
    expect(() => loadConfig({ ...base, SMS_PROVIDER: 'test' })).toThrow(ConfigError);
  });
  it('wildcard CORS, missing secrets, plain-text DB and short JWT secrets are refused', () => {
    expect(() => loadConfig({ ...prod, CORS_ALLOWED_ORIGINS: '*' })).toThrow(/CORS/);
    expect(() => loadConfig({ ...prod, SEND_SMS_HOOK_SECRET: '' })).toThrow(/SEND_SMS_HOOK_SECRET/);
    expect(() => loadConfig({ ...prod, DATABASE_SSL: 'disable' })).toThrow(/DATABASE_SSL/);
    expect(() => loadConfig({ ...prod, SUPABASE_JWT_SECRET: 'short' })).toThrow(/too short/);
    expect(loadConfig(prod).isProduction).toBe(true);
  });
  it('error messages name variables, never values', () => {
    try { loadConfig({ ...prod, SUPABASE_JWT_SECRET: 'short-secret-value' }); } catch (e) { expect(String(e)).not.toContain('short-secret-value'); }
  });
  it('OTP limits are clamped to the 3.1 bounds (a typo cannot disable a limit)', () => {
    const c = loadConfig({ ...base, APP_ENV: 'test', OTP_MAX_SENDS_PER_HOUR: '100000', OTP_RESEND_COOLDOWN_S: '1' });
    expect(c.otp.perPhoneHour).toBe(20);
    expect(c.otp.cooldownS).toBe(30);
  });
});

describe('logging, audit sanitising, errors', () => {
  it('scrubs JWTs, bearer tokens and webhook secrets from free text', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlc2lnbmF0dXJl';
    expect(scrub(`token=${jwt}`)).not.toContain(jwt);
    expect(scrub('Authorization: Bearer abc.def.ghi')).toContain('[redacted]');
    expect(scrub('secret whsec_abcdef==')).toBe('secret [whsec]');
  });
  it('audit values never carry codes, tokens or IMEIs', () => {
    expect(sanitizeAuditValue({ otp: '123456', nested: { token: 't', imei: '490154203237518', ok: 1 } }))
      .toEqual({ otp: '[redacted]', nested: { token: '[redacted]', imei: '[redacted]', ok: 1 } });
  });
  it('database constraint errors become sentences', () => {
    expect(fromPgError({ code: '23505', constraint: 'trade_ins_open_imei_key' })!.message).toBe('There is already an open trade-in for this device.');
    expect(fromPgError({ code: 'P0001', hint: 'QM_LAST_SUPER_ADMIN' })!.message).toContain('last active super administrator');
    expect(fromPgError({ code: '40001' })!.code).toBe('UNAVAILABLE');
    expect(fromPgError(new Error('x'))).toBeNull();
  });
});

describe('webhook signatures and upload sniffing', () => {
  const secret = `v1,whsec_${randomBytes(24).toString('base64')}`;
  it('verifies Standard Webhooks signatures with a timestamp window', () => {
    const now = 1_800_000_000;
    const sig = signWebhook(secret, 'msg_1', String(now), '{"a":1}');
    const h = { 'webhook-id': 'msg_1', 'webhook-timestamp': String(now), 'webhook-signature': `v1,AAAA ${sig}` };
    expect(verifyWebhook(secret, h, '{"a":1}', now)).toBe(true);
    expect(verifyWebhook(secret, h, '{"a":2}', now)).toBe(false);
    expect(verifyWebhook(secret, h, '{"a":1}', now + 600)).toBe(false);
    expect(verifyWebhook(secret, { ...h, 'webhook-signature': '' }, '{"a":1}', now)).toBe(false);
  });
  it('images are identified by their bytes', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    expect(sniffImageMime(png)).toBe('image/png');
    expect(sniffImageMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(() => validateImage(`data:image/jpeg;base64,${png.toString('base64')}`, 1000)).toThrow(/does not match/);
    expect(() => validateImage(`data:image/png;base64,${Buffer.alloc(2000, 1).toString('base64')}`, 1000)).toThrow(/larger/);
    expect(validateImage(`data:image/png;base64,${png.toString('base64')}`, 1000).mime).toBe('image/png');
  });
});
