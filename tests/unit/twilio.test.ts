import { describe, expect, it } from 'vitest';
import { TwilioSmsProvider } from '../../apps/api/src/lib/sms/provider.js';
import type { AppConfig } from '../../packages/shared/src/config.js';

const make = (over: Partial<AppConfig>, reply: { status: number; body?: unknown }) => {
  const calls: { url: string; auth: string; body: string }[] = [];
  const fetchImpl = async (url: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({ url, auth: init.headers.Authorization!, body: init.body });
    return { status: reply.status, json: async () => reply.body ?? {} };
  };
  const c = { TWILIO_ACCOUNT_SID: 'AC0123', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM: 'QATARMOBILE', SMS_MAX_RETRIES: 0, ...over } as AppConfig;
  return { p: new TwilioSmsProvider(c, fetchImpl as never), calls };
};

describe('Twilio sender', () => {
  it('trims pasted values (a stray newline would make Twilio answer 401)', async () => {
    const { p, calls } = make({ TWILIO_ACCOUNT_SID: ' AC0123\n', TWILIO_AUTH_TOKEN: 'tok \n' }, { status: 201 });
    expect((await p.send('+97433000000', '123456', 5)).ok).toBe(true);
    expect(calls[0]!.url).toContain('/Accounts/AC0123/Messages.json');
    expect(Buffer.from(calls[0]!.auth.replace('Basic ', ''), 'base64').toString()).toBe('AC0123:tok');
  });
  it('a Messaging Service SID is sent as MessagingServiceSid; a sender name as From', async () => {
    const mg = `MG${'a'.repeat(32)}`;
    const a = make({ TWILIO_FROM: mg }, { status: 201 }); await a.p.send('+97433000000', '123456', 5);
    expect(new URLSearchParams(a.calls[0]!.body).get('MessagingServiceSid')).toBe(mg);
    const b = make({}, { status: 201 }); await b.p.send('+97433000000', '123456', 5);
    expect(new URLSearchParams(b.calls[0]!.body).get('From')).toBe('QATARMOBILE');
  });
  it("a failure records Twilio's numeric error code, never its text", async () => {
    const { p } = make({}, { status: 401, body: { code: 20003, message: 'Authenticate' } });
    expect(await p.send('+97433000000', '123456', 5)).toEqual({ ok: false, status: '401/20003' });
  });
});
