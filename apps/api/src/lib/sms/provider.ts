/**
 * SMS delivery behind one interface (04_Auth.gs sendSms_).
 *
 * Providers: 'twilio', 'custom' (an https JSON endpoint), 'test' (in-memory,
 * refused by config in staging/production) and 'none' (fails closed).
 * Credentials come only from environment variables. The message text is
 * built here; callers pass the code and never log it.
 */
import type { AppConfig } from '../../../../../packages/shared/src/config.js';
import { PLATFORM_NAME } from '../../../../../packages/domain/src/constants.js';

export interface SmsResult { ok: boolean; status: string }

export interface SmsProvider {
  readonly name: 'twilio' | 'custom' | 'test' | 'none';
  configured(): boolean;
  send(phoneE164: string, code: string, ttlMinutes: number): Promise<SmsResult>;
}

export const otpMessage = (code: string, ttlMinutes: number): string =>
  `${PLATFORM_NAME}: your code is ${code}. It expires in ${ttlMinutes} minutes.`;

/** Supabase allows an HTTP Auth hook 5 s in total; the provider call gets 4 s of it. */
export const SMS_TIMEOUT_MS = 4_000;

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; redirect: 'manual'; signal?: AbortSignal }) =>
  Promise<{ status: number }>;

async function withRetries(retries: number, attempt: () => Promise<SmsResult>): Promise<SmsResult> {
  let last: SmsResult = { ok: false, status: 'exhausted' };
  for (let i = 0; i <= retries; i++) {
    try {
      last = await attempt();
    } catch {
      last = { ok: false, status: 'network' };
    }
    if (last.ok) return last;
    const retryable = last.status === 'network' || last.status === '429' || /^5\d\d$/.test(last.status);
    if (!retryable) return last;
  }
  return last;
}

/**
 * The SHAPE of the Twilio settings — never the values — for the start-up log, so a wrong paste
 * (an API key "SK…" instead of the Account SID "AC…", a token of the wrong length, stray characters)
 * can be told apart from a wrong-but-well-formed credential without anyone reading a secret.
 */
export function twilioShape(c: AppConfig) {
  const sid = (c.TWILIO_ACCOUNT_SID ?? '').trim();
  const token = (c.TWILIO_AUTH_TOKEN ?? '').trim();
  const from = (c.TWILIO_FROM ?? '').trim();
  return {
    sidPrefix: sid.slice(0, 2), sidLength: sid.length, sidWellFormed: /^AC[0-9a-f]{32}$/.test(sid),
    tokenLength: token.length, tokenWellFormed: /^[0-9a-f]{32}$/.test(token),
    rawHadSpaces: /\s/.test(c.TWILIO_ACCOUNT_SID ?? '') || /\s/.test(c.TWILIO_AUTH_TOKEN ?? ''),
    from: /^MG[0-9a-f]{32}$/.test(from) ? 'messaging-service' : /^\+\d{6,15}$/.test(from) ? 'phone-number' : from ? 'other' : 'missing',
  };
}

export class TwilioSmsProvider implements SmsProvider {
  readonly name = 'twilio' as const;
  constructor(private readonly c: AppConfig, private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike) {}
  configured(): boolean {
    return !!(this.c.TWILIO_ACCOUNT_SID && this.c.TWILIO_AUTH_TOKEN && this.c.TWILIO_FROM);
  }
  async send(phone: string, code: string, ttl: number): Promise<SmsResult> {
    if (!this.configured()) return { ok: false, status: 'not-configured' };
    // Values pasted into a dashboard often carry a stray space or line break — Twilio then answers 401.
    const sid = this.c.TWILIO_ACCOUNT_SID!.trim();
    const token = this.c.TWILIO_AUTH_TOKEN!.trim();
    const from = this.c.TWILIO_FROM!.trim();
    const auth = Buffer.from(`${sid}:${token}`).toString('base64');
    // A Messaging Service (MG…) is sent as MessagingServiceSid; a number or alphanumeric sender as From.
    const sender: Record<string, string> = /^MG[0-9a-f]{32}$/i.test(from) ? { MessagingServiceSid: from } : { From: from };
    const body = new URLSearchParams({ To: phone, ...sender, Body: otpMessage(code, ttl) }).toString();
    return withRetries(this.c.SMS_MAX_RETRIES, async () => {
      const res = await this.fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
        method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body, redirect: 'manual', signal: AbortSignal.timeout(SMS_TIMEOUT_MS),
      });
      if (res.status >= 200 && res.status < 300) return { ok: true, status: String(res.status) };
      // Twilio's numeric error code (e.g. 20003 authentication, 21606/21212 sender) — never the body text.
      let code = '';
      try { const j = await (res as unknown as { json(): Promise<{ code?: unknown }> }).json(); if (typeof j.code === 'number') code = `/${j.code}`; } catch { /* no body */ }
      return { ok: false, status: `${res.status}${code}` };
    });
  }
}

export class CustomSmsProvider implements SmsProvider {
  readonly name = 'custom' as const;
  constructor(private readonly c: AppConfig, private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike) {}
  configured(): boolean {
    return !!this.c.CUSTOM_SMS_URL && /^https:\/\//i.test(this.c.CUSTOM_SMS_URL);
  }
  async send(phone: string, code: string, ttl: number): Promise<SmsResult> {
    if (!this.configured()) return { ok: false, status: 'not-configured' };
    const payload: Record<string, string> = { to: phone, message: otpMessage(code, ttl) };
    if (this.c.SMS_SENDER_ID) payload.sender = this.c.SMS_SENDER_ID;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.c.CUSTOM_SMS_KEY) headers.Authorization = `Bearer ${this.c.CUSTOM_SMS_KEY}`;
    return withRetries(this.c.SMS_MAX_RETRIES, async () => {
      const res = await this.fetchImpl(this.c.CUSTOM_SMS_URL!, {
        method: 'POST', headers, body: JSON.stringify(payload), redirect: 'manual', signal: AbortSignal.timeout(SMS_TIMEOUT_MS),
      });
      return { ok: res.status >= 200 && res.status < 300, status: String(res.status) };
    });
  }
}

/**
 * TEST ONLY. Keeps messages in memory for automated tests. It is never
 * selected automatically: SMS_PROVIDER=test must be set explicitly, and
 * loadConfig() refuses it in staging and production. It never logs codes.
 */
export class TestSmsProvider implements SmsProvider {
  readonly name = 'test' as const;
  readonly outbox: { to: string; code: string; at: Date }[] = [];
  failNext = false;
  configured(): boolean { return true; }
  async send(phone: string, code: string): Promise<SmsResult> {
    if (this.failNext) { this.failNext = false; return { ok: false, status: '500' }; }
    this.outbox.push({ to: phone, code, at: new Date() });
    if (this.outbox.length > 200) this.outbox.shift();
    return { ok: true, status: '200' };
  }
  lastCodeFor(phone: string): string | null {
    for (let i = this.outbox.length - 1; i >= 0; i--) if (this.outbox[i]!.to === phone) return this.outbox[i]!.code;
    return null;
  }
}

export class NoSmsProvider implements SmsProvider {
  readonly name = 'none' as const;
  configured(): boolean { return false; }
  async send(): Promise<SmsResult> { return { ok: false, status: 'no-provider' }; }
}

export function createSmsProvider(c: AppConfig): SmsProvider {
  switch (c.SMS_PROVIDER) {
    case 'twilio': return new TwilioSmsProvider(c);
    case 'custom': return new CustomSmsProvider(c);
    case 'test':
      if (c.isProduction || c.APP_ENV === 'staging') throw new Error('The test SMS provider is not allowed here.');
      return new TestSmsProvider();
    default: return new NoSmsProvider();
  }
}
