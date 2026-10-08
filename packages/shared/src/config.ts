/**
 * Server configuration, read ONLY from environment variables and
 * validated at start-up. A misconfigured server refuses to start rather
 * than run in a weaker mode (the 3.1 "fail closed" principle,
 * 00b_Security.gs).
 *
 * Browser-safe vs server-secret variables are listed in .env.example.
 * Nothing in this file ever has a default for a secret.
 */
import { z } from 'zod';
import { OTP_DEFAULTS } from '../../domain/src/constants.js';

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase())));

const csv = z
  .string()
  .default('')
  .transform((v) => v.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean));

/** A bounded integer with the 3.1 default (secNumProp_ semantics: clamp, never disable). */
const boundedInt = (fallback: number, min: number, max: number) =>
  z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => {
      const n = v === undefined || v === '' ? fallback : Number(v);
      if (!Number.isFinite(n)) return fallback;
      return Math.min(max, Math.max(min, Math.round(n)));
    });

const EnvSchema = z.object({
  APP_ENV: z.enum(['development', 'test', 'staging', 'production']).default('production'),
  HOST: z.string().default('0.0.0.0'),
  PORT: boundedInt(8080, 1, 65535),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Proxy hops in front of the API whose X-Forwarded-For is trusted (0 = none). Railway: 1 (verify). */
  TRUST_PROXY_HOPS: boundedInt(1, 0, 5),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_POOL_MAX: boundedInt(10, 1, 100),
  DATABASE_SSL: z.enum(['require', 'no-verify', 'disable']).default('require'),
  /** PEM of the database CA (Supabase: Database settings → SSL configuration → download). Literal \\n allowed. */
  DATABASE_SSL_CA: z.string().optional(),
  DATABASE_STATEMENT_TIMEOUT_MS: boundedInt(15000, 1000, 120000),

  SUPABASE_URL: z.string().url().optional(),
  /** Browser-safe. Used server-side only to call Auth endpoints on the user's behalf. */
  SUPABASE_ANON_KEY: z.string().optional(),
  /** New-style name for the same browser-safe key (sb_publishable_...). Either name works. */
  SUPABASE_PUBLISHABLE_KEY: z.string().optional(),
  /** SECRET. Storage signing and admin calls. Never sent to a browser. */
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  /** New-style name for the same server secret (sb_secret_...). Either name works. SECRET. */
  SUPABASE_SECRET_KEY: z.string().optional(),
  /** SECRET. HS256 verification of Supabase access tokens (legacy JWT secret). */
  SUPABASE_JWT_SECRET: z.string().optional(),
  /** Alternative to the secret: asymmetric signing keys published by the project. */
  SUPABASE_JWKS_URL: z.string().url().optional(),
  SUPABASE_JWT_ISSUER: z.string().optional(),
  SUPABASE_JWT_AUDIENCE: z.string().default('authenticated'),
  /** SECRET. Standard Webhooks secret for the Send SMS Auth Hook ("v1,whsec_..."). */
  SEND_SMS_HOOK_SECRET: z.string().optional(),

  CORS_ALLOWED_ORIGINS: csv,
  BODY_LIMIT_BYTES: boundedInt(1_048_576, 16_384, 50 * 1024 * 1024),
  UPLOAD_BODY_LIMIT_BYTES: boundedInt(40 * 1024 * 1024, 1_048_576, 60 * 1024 * 1024),
  RATE_LIMIT_MAX: boundedInt(300, 10, 100_000),
  RATE_LIMIT_WINDOW_MS: boundedInt(60_000, 1000, 3_600_000),
  AUTH_RATE_LIMIT_MAX: boundedInt(20, 1, 10_000),

  IDEMPOTENCY_TTL_DAYS: boundedInt(7, 1, 90),
  SIGNED_URL_TTL_SECONDS: boundedInt(300, 30, 3600),

  SMS_PROVIDER: z.enum(['none', 'twilio', 'custom', 'test']).default('none'),
  SMS_MAX_RETRIES: boundedInt(0, 0, 2),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM: z.string().optional(),
  CUSTOM_SMS_URL: z.string().optional(),
  CUSTOM_SMS_KEY: z.string().optional(),
  SMS_SENDER_ID: z.string().optional(),

  OTP_TTL_MINUTES: boundedInt(OTP_DEFAULTS.TTL_MINUTES, 1, 15),
  OTP_MAX_ATTEMPTS: boundedInt(OTP_DEFAULTS.MAX_ATTEMPTS, 1, 10),
  OTP_RESEND_COOLDOWN_S: boundedInt(OTP_DEFAULTS.RESEND_COOLDOWN_S, 30, 600),
  OTP_MAX_SENDS_PER_HOUR: boundedInt(OTP_DEFAULTS.MAX_SENDS_PER_HOUR, 1, 20),
  OTP_MAX_SENDS_PER_DAY: boundedInt(OTP_DEFAULTS.MAX_SENDS_PER_DAY, 1, 50),
  OTP_GLOBAL_MAX_PER_HOUR: boundedInt(OTP_DEFAULTS.GLOBAL_MAX_PER_HOUR, 1, 100_000),
  OTP_GLOBAL_MAX_PER_DAY: boundedInt(OTP_DEFAULTS.GLOBAL_MAX_PER_DAY, 1, 1_000_000),
  OTP_REGISTER_GLOBAL_MAX_PER_HOUR: boundedInt(OTP_DEFAULTS.REGISTER_GLOBAL_MAX_PER_HOUR, 1, 100_000),
  OTP_REGISTER_GLOBAL_MAX_PER_DAY: boundedInt(OTP_DEFAULTS.REGISTER_GLOBAL_MAX_PER_DAY, 1, 1_000_000),

  /** Keyless requests to idempotent actions: 3.1 allowed them (old cached pages). */
  /** Unset = true in staging/production, false in development/test. false is refused in staging/production. */
  IDEMPOTENCY_KEY_REQUIRED: bool.optional(),

  /**
   * How STAFF sign in. "password": email + password through Supabase Auth (customers keep SMS codes);
   * "phone": the 3.1 SMS code for everyone. Unset = password in staging/production, phone in
   * development/test. "phone" is refused in production (owner decision: staff use email + password).
   */
  STAFF_SIGN_IN: z.enum(['password', 'phone']).optional(),
  STAFF_PASSWORD_MIN_LENGTH: boundedInt(12, 8, 64),
  /** Wrong passwords per staff email in 15 minutes before sign-in is paused for that email. */
  STAFF_LOGIN_MAX_FAILURES: boundedInt(5, 3, 20),
  /** Reset e-mails sent per hour across ALL staff — keep below the project's Supabase e-mail limit. */
  STAFF_RESET_EMAILS_PER_HOUR: boundedInt(25, 1, 10_000),
  /**
   * Send the end user's IP to Supabase Auth (Sb-Forwarded-For) so its per-IP limits apply per person,
   * not to the API's single IP. Needs a NEW-style secret key and "IP address forwarding" switched on in
   * the Supabase project. Not verified on Supabase Cloud yet: verify on staging before relying on it.
   */
  SUPABASE_AUTH_FORWARD_CLIENT_IP: bool.optional(),

  /** Refuse access tokens whose Supabase session was signed out or revoked. Default: on in staging/production. */
  AUTH_SESSION_CHECK: bool.optional(),
  /** Comma list of staff roles that must sign in with password + authenticator app (aal2). Default SUPER_ADMIN in staging/production. */
  STAFF_MFA_ROLES: z.string().max(200).optional(),

  /** Staff reset e-mail: Supabase "Send Email" hook → Microsoft Graph (app-only, Mail.Send restricted to one mailbox). */
  SEND_EMAIL_HOOK_SECRET: z.string().optional(),
  GRAPH_TENANT_ID: z.string().max(100).optional(),
  GRAPH_CLIENT_ID: z.string().max(100).optional(),
  /** SECRET. */
  GRAPH_CLIENT_SECRET: z.string().max(500).optional(),
  STAFF_MAIL_FROM: z.string().max(254).optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export interface AppConfig extends Omit<Env, 'IDEMPOTENCY_KEY_REQUIRED' | 'STAFF_SIGN_IN' | 'SUPABASE_AUTH_FORWARD_CLIENT_IP' | 'AUTH_SESSION_CHECK' | 'STAFF_MFA_ROLES'> {
  AUTH_SESSION_CHECK: boolean;
  STAFF_MFA_ROLES: string[];
  /** Graph credentials + hook secret present: staff reset codes can be e-mailed. */
  staffMailConfigured: boolean;
  SUPABASE_AUTH_FORWARD_CLIENT_IP: boolean;
  IDEMPOTENCY_KEY_REQUIRED: boolean;
  STAFF_SIGN_IN: 'password' | 'phone';
  /** production OR staging: the strict, production-style rules apply. */
  isProductionLike: boolean;
  isProduction: boolean;
  otp: {
    ttlMinutes: number; cooldownS: number; maxAttempts: number;
    perPhoneHour: number; perPhoneDay: number;
    globalHour: number; globalDay: number;
    regGlobalHour: number; regGlobalDay: number;
  };
}

export class ConfigError extends Error {}

/**
 * Parse and cross-check. Throws ConfigError with a list of problems; the
 * problems name variables, never their values.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // An empty variable (KEY= in a copied template) means "not set", never "set to empty".
  const present = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && String(v).trim() !== ''));
  const parsed = EnvSchema.safeParse(present);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new ConfigError(`Invalid configuration:\n  ${issues.join('\n  ')}`);
  }
  const e = parsed.data;
  const problems: string[] = [];
  const isProduction = e.APP_ENV === 'production';
  const isProductionLike = isProduction || e.APP_ENV === 'staging';
  // Either key name works; the new-style names win when both are set.
  e.SUPABASE_ANON_KEY = e.SUPABASE_PUBLISHABLE_KEY || e.SUPABASE_ANON_KEY;
  e.SUPABASE_SERVICE_ROLE_KEY = e.SUPABASE_SECRET_KEY || e.SUPABASE_SERVICE_ROLE_KEY;
  const idempotencyRequired = e.IDEMPOTENCY_KEY_REQUIRED ?? isProductionLike;
  const staffSignIn = e.STAFF_SIGN_IN ?? (isProductionLike ? 'password' : 'phone');
  const sessionCheck = e.AUTH_SESSION_CHECK ?? isProductionLike;
  const mfaRoles = (e.STAFF_MFA_ROLES ?? (isProductionLike ? 'SUPER_ADMIN' : '')).split(',').map((r) => r.trim().toUpperCase()).filter(Boolean);
  const graphParts = [e.GRAPH_TENANT_ID, e.GRAPH_CLIENT_ID, e.GRAPH_CLIENT_SECRET, e.STAFF_MAIL_FROM];
  const staffMailConfigured = graphParts.every(Boolean) && !!e.SEND_EMAIL_HOOK_SECRET;
  if (graphParts.some(Boolean) && !graphParts.every(Boolean)) {
    problems.push('Staff e-mail needs all of GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET and STAFF_MAIL_FROM (or none of them).');
  }
  if (e.STAFF_MAIL_FROM && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e.STAFF_MAIL_FROM)) problems.push('STAFF_MAIL_FROM must be an e-mail address.');

  // ---- the test SMS provider can never run in production ---------------
  if (e.SMS_PROVIDER === 'test' && isProductionLike) {
    problems.push('SMS_PROVIDER=test is refused when APP_ENV is production or staging.');
  }
  if (e.SMS_PROVIDER === 'twilio') {
    for (const k of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM'] as const) {
      if (!e[k]) problems.push(`${k} is required when SMS_PROVIDER=twilio.`);
    }
  }
  if (e.SMS_PROVIDER === 'custom') {
    if (!e.CUSTOM_SMS_URL || !/^https:\/\//i.test(e.CUSTOM_SMS_URL)) {
      problems.push('CUSTOM_SMS_URL must be an https URL when SMS_PROVIDER=custom.');
    }
  }

  // ---- token verification must be configured -------------------------
  if (!e.SUPABASE_JWT_SECRET && !e.SUPABASE_JWKS_URL) {
    problems.push('Set SUPABASE_JWT_SECRET or SUPABASE_JWKS_URL so access tokens can be verified.');
  }
  if (e.SUPABASE_JWT_SECRET && e.SUPABASE_JWT_SECRET.length < 32) {
    problems.push('SUPABASE_JWT_SECRET is too short to be a real secret.');
  }

  if (e.SUPABASE_AUTH_FORWARD_CLIENT_IP && !String(e.SUPABASE_SECRET_KEY || e.SUPABASE_SERVICE_ROLE_KEY || '').startsWith('sb_secret_')) {
    problems.push('SUPABASE_AUTH_FORWARD_CLIENT_IP needs a new-style secret key (sb_secret_...); Supabase does not accept forwarding with legacy keys.');
  }
  if (e.DATABASE_SSL_CA) {
    const pem = e.DATABASE_SSL_CA.replace(/\\n/g, '\n');
    const decoded = pem.includes('-----BEGIN') ? pem : (() => { try { return Buffer.from(pem, 'base64').toString('utf8'); } catch { return ''; } })();
    if (!decoded.includes('-----BEGIN CERTIFICATE-----')) problems.push('DATABASE_SSL_CA is not a PEM certificate (paste the certificate text or its base64, not a file path).');
  }
  if (isProductionLike) {
    if (!e.SUPABASE_URL) problems.push('SUPABASE_URL is required outside development.');
    if (!e.SUPABASE_ANON_KEY) problems.push('SUPABASE_ANON_KEY is required outside development.');
    if (!e.SUPABASE_SERVICE_ROLE_KEY) problems.push('SUPABASE_SERVICE_ROLE_KEY is required outside development.');
    // Staging may run before an SMS provider is chosen (customer sign-in then fails closed); production may not.
    if (!e.SEND_SMS_HOOK_SECRET && (isProduction || e.SMS_PROVIDER !== 'none')) problems.push('SEND_SMS_HOOK_SECRET is required outside development.');
    if (!e.SUPABASE_JWT_ISSUER) problems.push('SUPABASE_JWT_ISSUER is required outside development.');
    if (e.CORS_ALLOWED_ORIGINS.length === 0) problems.push('CORS_ALLOWED_ORIGINS must list the frontend origin(s).');
    if (e.CORS_ALLOWED_ORIGINS.some((o) => o === '*' || !/^https:\/\//.test(o))) {
      problems.push('CORS_ALLOWED_ORIGINS must be explicit https origins (no "*").');
    }
    if (e.DATABASE_SSL === 'disable') problems.push('DATABASE_SSL=disable is refused outside development.');
    // Production-style configuration: money/custody writes need an idempotency key, and a real SMS provider.
    if (e.IDEMPOTENCY_KEY_REQUIRED === false) problems.push('IDEMPOTENCY_KEY_REQUIRED=false is refused when APP_ENV is staging or production.');
    // SMS: production needs a real provider. Staging may use 'none' (no provider chosen yet): every customer
    // code request is then refused ("temporarily unavailable") — never a test/fixed code. 'test' is refused above.
    if (e.SMS_PROVIDER !== 'twilio' && e.SMS_PROVIDER !== 'custom' && !(e.APP_ENV === 'staging' && e.SMS_PROVIDER === 'none')) {
      problems.push('SMS_PROVIDER must be twilio or custom when APP_ENV is production (staging: twilio, custom or none).');
    }
    if (e.SUPABASE_JWKS_URL && !/^https:\/\//.test(e.SUPABASE_JWKS_URL)) problems.push('SUPABASE_JWKS_URL must be https.');
    if (e.SUPABASE_URL && !/^https:\/\//.test(e.SUPABASE_URL)) problems.push('SUPABASE_URL must be https.');
  }
  if (isProduction) {
    if (e.DATABASE_SSL !== 'require') problems.push('DATABASE_SSL must be require (certificate verified) in production.');
    if (e.LOG_LEVEL === 'debug' || e.LOG_LEVEL === 'trace') problems.push('LOG_LEVEL debug/trace is refused in production.');
    if (staffSignIn !== 'password') problems.push('STAFF_SIGN_IN=phone is refused in production (staff sign in with email and password).');
    if (!mfaRoles.includes('SUPER_ADMIN')) problems.push('STAFF_MFA_ROLES must include SUPER_ADMIN in production.');
    if (!sessionCheck) problems.push('AUTH_SESSION_CHECK=false is refused in production.');
    if (!staffMailConfigured) problems.push('Staff reset e-mail must be configured in production (GRAPH_* + STAFF_MAIL_FROM + SEND_EMAIL_HOOK_SECRET).');
  }

  if (problems.length) throw new ConfigError(`Refusing to start:\n  ${problems.join('\n  ')}`);

  return {
    ...e,
    IDEMPOTENCY_KEY_REQUIRED: idempotencyRequired,
    STAFF_SIGN_IN: staffSignIn,
    SUPABASE_AUTH_FORWARD_CLIENT_IP: e.SUPABASE_AUTH_FORWARD_CLIENT_IP ?? false,
    AUTH_SESSION_CHECK: sessionCheck,
    STAFF_MFA_ROLES: mfaRoles,
    staffMailConfigured,
    isProductionLike,
    isProduction,
    otp: {
      ttlMinutes: e.OTP_TTL_MINUTES,
      cooldownS: e.OTP_RESEND_COOLDOWN_S,
      maxAttempts: e.OTP_MAX_ATTEMPTS,
      perPhoneHour: e.OTP_MAX_SENDS_PER_HOUR,
      perPhoneDay: e.OTP_MAX_SENDS_PER_DAY,
      globalHour: e.OTP_GLOBAL_MAX_PER_HOUR,
      globalDay: e.OTP_GLOBAL_MAX_PER_DAY,
      regGlobalHour: e.OTP_REGISTER_GLOBAL_MAX_PER_HOUR,
      regGlobalDay: e.OTP_REGISTER_GLOBAL_MAX_PER_DAY,
    },
  };
}
