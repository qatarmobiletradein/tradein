/**
 * Microsoft Graph sender (app-only, client credentials). The app registration
 * holds only Mail.Send, restricted by Exchange to the one mailbox in
 * STAFF_MAIL_FROM. No mailbox password exists anywhere in this system.
 */
export interface Mailer {
  configured(): boolean;
  send(to: string, subject: string, html: string, text: string): Promise<{ ok: true } | { ok: false; status: number; code: string }>;
}

export class GraphMailer implements Mailer {
  private token: { value: string; until: number } | null = null;
  constructor(
    private readonly tenantId: string, private readonly clientId: string, private readonly clientSecret: string,
    private readonly from: string, private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  configured() { return true; }

  private async accessToken(deadline: number): Promise<string | null> {
    if (this.token && this.token.until > Date.now()) return this.token.value;
    const body = new URLSearchParams({
      client_id: this.clientId, client_secret: this.clientSecret, grant_type: 'client_credentials', scope: 'https://graph.microsoft.com/.default',
    });
    const r = await this.fetchImpl(`https://login.microsoftonline.com/${encodeURIComponent(this.tenantId)}/oauth2/v2.0/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(Math.max(500, deadline - Date.now())),
    });
    if (!r.ok) return null;
    const j = (await r.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
    if (!j.access_token) return null;
    this.token = { value: j.access_token, until: Date.now() + Math.max(60, (j.expires_in ?? 3600) - 120) * 1000 };
    return j.access_token;
  }

  async send(to: string, subject: string, html: string, text: string) {
    // Supabase waits 5 s for a hook; stay inside 4 s.
    const deadline = Date.now() + 4000;
    try {
      const t = await this.accessToken(deadline);
      if (!t) return { ok: false as const, status: 503, code: 'graph_token' };
      const r = await this.fetchImpl(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(this.from)}/sendMail`, {
        method: 'POST',
        headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          message: {
            subject,
            body: { contentType: 'HTML', content: html },
            toRecipients: [{ emailAddress: { address: to } }],
            // A plain-text part is not supported by sendMail; the HTML is kept minimal and readable as text.
          },
          saveToSentItems: false,
        }),
        signal: AbortSignal.timeout(Math.max(500, deadline - Date.now())),
      });
      if (r.status === 401) this.token = null;
      void text;
      return r.status === 202 || r.status === 200 ? { ok: true as const } : { ok: false as const, status: r.status, code: 'graph_send' };
    } catch {
      return { ok: false as const, status: 503, code: 'graph_unreachable' };
    }
  }
}

export class NoMailer implements Mailer {
  configured() { return false; }
  async send() { return { ok: false as const, status: 503, code: 'mail_unconfigured' }; }
}

/** Staff password code e-mail. The code appears only here, never in a log. */
export function resetCodeEmail(code: string, minutes: number) {
  const subject = 'Your Qatar Mobile Trade-In password code';
  const text = `Your code to set or reset your Qatar Mobile Trade-In password is ${code}. It expires in ${minutes} minutes. If you did not ask for it, ignore this e-mail.`;
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#111">
<p>Your code to set or reset your <b>Qatar Mobile Trade-In</b> password:</p>
<p style="font-size:28px;letter-spacing:6px;font-weight:bold">${code}</p>
<p>It expires in ${minutes} minutes. If you did not ask for it, ignore this e-mail — your password has not changed.</p>
<p dir="rtl">رمز إعادة تعيين كلمة المرور: <b>${code}</b> — صالح لمدة ${minutes} دقيقة. إذا لم تطلبه، تجاهل هذه الرسالة.</p>
</div>`;
  return { subject, html, text };
}
