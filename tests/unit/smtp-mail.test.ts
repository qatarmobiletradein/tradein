/**
 * Staff password-code e-mail over SMTP (2026-10-11), the alternative to Microsoft Graph.
 * The hook (/v1/hooks/send-email) and its protections are unchanged; only the sender differs.
 */
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../packages/shared/src/config.js';
import { SmtpMailer } from '../../apps/api/src/lib/mail/smtp.js';

const base = (over: Record<string, string | undefined> = {}) => {
  const env: Record<string, string> = { APP_ENV: 'test', DATABASE_URL: 'x', SUPABASE_JWT_SECRET: 'x'.repeat(40) };
  for (const [k, v] of Object.entries(over)) if (v !== undefined) env[k] = v;
  return env;
};
const SMTP = { SMTP_HOST: 'smtp.office365.com', SMTP_PORT: '587', SMTP_USER: 'info@qatarmobile.qa', SMTP_PASS: 'not-a-real-password', STAFF_MAIL_FROM: 'info@qatarmobile.qa' };
const HOOK = { SEND_EMAIL_HOOK_SECRET: 'v1,whsec_dGVzdA==' };
const GRAPH = { GRAPH_TENANT_ID: 't', GRAPH_CLIENT_ID: 'c', GRAPH_CLIENT_SECRET: 's' };

describe('staff mail transport selection', () => {
  it('SMTP is used when complete and the hook secret is set; Graph wins when both are complete', () => {
    expect(loadConfig(base({ ...SMTP, ...HOOK })).staffMailTransport).toBe('smtp');
    expect(loadConfig(base({ ...SMTP, ...HOOK })).staffMailConfigured).toBe(true);
    expect(loadConfig(base({ ...SMTP, ...GRAPH, ...HOOK })).staffMailTransport).toBe('graph');
    expect(loadConfig(base({ ...SMTP })).staffMailTransport).toBe('none');          // no hook secret, no e-mail
    expect(loadConfig(base()).staffMailTransport).toBe('none');
  });
  it('a half-configured SMTP or a plain-text port is refused at start-up', () => {
    expect(() => loadConfig(base({ ...SMTP, SMTP_PASS: undefined, ...HOOK }))).toThrow(/SMTP_HOST, SMTP_USER, SMTP_PASS/);
    expect(() => loadConfig(base({ ...SMTP, SMTP_PORT: '25', ...HOOK }))).toThrow(/SMTP_PORT/);
  });
  it('the SMTP password is never part of the start-up error text', () => {
    try { loadConfig(base({ ...SMTP, SMTP_PORT: '25', ...HOOK })); } catch (e) { expect(String(e)).not.toContain('not-a-real-password'); }
  });
});

describe('SmtpMailer', () => {
  it('fails closed, fast, without echoing the server reply, when the server is unusable', async () => {
    // A server that greets and then refuses STARTTLS: requireTLS must stop the send (no plain-text auth).
    const srv = createServer((s) => {
      s.write('220 test ESMTP\r\n');
      s.on('data', (d) => {
        const line = d.toString();
        if (/^EHLO/i.test(line)) s.write('250-test\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (/^QUIT/i.test(line)) { s.write('221 bye\r\n'); s.end(); }
        else s.write('502 not implemented secret-echo\r\n');
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as AddressInfo).port;
    const m = new SmtpMailer('127.0.0.1', port, 'u', 'not-a-real-password', 'info@qatarmobile.qa');
    const t0 = Date.now();
    const r = await m.send('a@example.test', 's', '<p>x</p>', 'x');
    srv.close();
    expect(r.ok).toBe(false);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(JSON.stringify(r)).not.toMatch(/secret-echo|not-a-real-password/);
  });
});
