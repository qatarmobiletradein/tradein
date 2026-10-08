/**
 * Structured JSON logging with secret redaction.
 *
 * Request and response BODIES are never logged: they can carry phone
 * numbers, IMEIs and, on the auth routes, one-time codes. Headers that
 * carry credentials are redacted by path. A last-resort scrubber removes
 * anything that looks like a bearer token or a JWT from free-text
 * messages, so a careless `log.info(err.message)` cannot leak one.
 */
import { pino, type Logger, type LoggerOptions } from 'pino';

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers.apikey',
  'req.headers["webhook-signature"]',
  'req.headers["idempotency-key"]',
  'res.headers["set-cookie"]',
  '*.password', '*.otp', '*.code', '*.token', '*.access_token', '*.refresh_token',
  '*.secret', '*.apiKey', '*.authorization', '*.serviceRoleKey', '*.phone', '*.imei',
  'otp', 'code', 'token', 'password', 'secret',
];

const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const BEARER_RE = /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const WHSEC_RE = /whsec_[A-Za-z0-9+/=]+/g;
const SB_KEY_RE = /sb_(secret|publishable)_[A-Za-z0-9_-]+/g;
const URL_PASSWORD_RE = /(postgres(?:ql)?:\/\/[^:\s/@]+:)[^@\s]+@/gi;

export function scrub(s: string): string {
  return s.replace(JWT_RE, '[jwt]').replace(BEARER_RE, 'Bearer [redacted]').replace(WHSEC_RE, '[whsec]')
    .replace(SB_KEY_RE, '[sb_key]').replace(URL_PASSWORD_RE, '$1[redacted]@');
}

export function createLogger(level: string, extra: LoggerOptions = {}): Logger {
  return pino({
    level,
    base: { service: 'qm-api' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    formatters: { level: (label) => ({ level: label }) },
    hooks: {
      logMethod(args, method) {
        const scrubbed = args.map((a) => (typeof a === 'string' ? scrub(a) : a)) as Parameters<typeof method>;
        method.apply(this, scrubbed);
      },
    },
    serializers: {
      err: (e: Error & { code?: string }) => ({
        type: e?.name, message: scrub(String(e?.message ?? '')), code: e?.code,
        stack: e?.stack ? scrub(e.stack) : undefined,
      }),
    },
    ...extra,
  });
}

export type { Logger };
