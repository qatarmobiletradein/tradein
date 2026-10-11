/**
 * SMTP sender for the staff password-code e-mail (owner decision 2026-10-11: send from the
 * existing mailbox over SMTP until Microsoft Graph is set up). Same contract as GraphMailer.
 *
 * The SMTP password lives ONLY in Railway (qm-api -> Variables, sealed): never in the repository,
 * a log, or a reply. STARTTLS is required (port 587) or implicit TLS (465); plain text is refused.
 */
import nodemailer, { type Transporter } from 'nodemailer';
import type { Mailer } from './graph.js';

export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;
  constructor(host: string, port: number, user: string, pass: string, private readonly from: string, fromName = 'Qatar Mobile Trade-In') {
    this.transport = nodemailer.createTransport({
      host, port, secure: port === 465, requireTLS: port !== 465,
      auth: { user, pass },
      // Supabase waits 5 s for the hook: stay inside it.
      connectionTimeout: 3500, greetingTimeout: 3000, socketTimeout: 4000,
      tls: { minVersion: 'TLSv1.2', servername: host },
      logger: false, debug: false,
    });
    this.fromHeader = { name: fromName, address: from };
  }
  private readonly fromHeader: { name: string; address: string };

  configured() { return true; }

  async send(to: string, subject: string, html: string, text: string) {
    try {
      const info = await this.transport.sendMail({ from: this.fromHeader, to, subject, html, text });
      return info.accepted?.length ? { ok: true as const } : { ok: false as const, status: 502, code: 'smtp_rejected' };
    } catch (err) {
      // Only the SMTP response class is kept — never the message (it can echo the address or credentials).
      const code = (err as { responseCode?: number; code?: string }).responseCode ?? 0;
      return { ok: false as const, status: code >= 500 ? 502 : 503, code: `smtp_${(err as { code?: string }).code ?? code}` };
    }
  }
}
