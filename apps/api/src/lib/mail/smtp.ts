/**
 * SMTP sender for the staff password-code e-mail (owner decision 2026-10-11: send from the
 * existing mailbox over SMTP until Microsoft Graph is set up). Same contract as GraphMailer.
 *
 * The SMTP password lives ONLY in Railway (qm-api -> Variables, sealed): never in the repository,
 * a log, or a reply. STARTTLS is required (port 587) or implicit TLS (465); plain text is refused.
 *
 * IPv6 first: on Railway, outbound SMTP over IPv4 was dropped (network-flow QDISC_DROP on every
 * smtp.office365.com A record, 2026-10-11) while the same server answered over IPv6. The host name
 * is still used for TLS (certificate check), only the address is chosen here.
 */
import { promises as dns } from 'node:dns';
import nodemailer from 'nodemailer';
import type { Mailer } from './graph.js';

type Resolver = (host: string) => Promise<string[]>;

export class SmtpMailer implements Mailer {
  private readonly fromHeader: { name: string; address: string };
  constructor(
    private readonly host: string, private readonly port: number, private readonly user: string, private readonly pass: string,
    from: string, fromName = 'Qatar Mobile Trade-In', private readonly resolve6: Resolver = (h) => dns.resolve6(h),
  ) {
    this.fromHeader = { name: fromName, address: from };
  }

  configured() { return true; }

  private async address(): Promise<string> {
    if (/^[\d.]+$/.test(this.host) || this.host.includes(':')) return this.host;
    try {
      const v6 = await this.resolve6(this.host);
      if (v6.length) return v6[0]!;
    } catch { /* no AAAA record: let the system pick */ }
    return this.host;
  }

  async send(to: string, subject: string, html: string, text: string) {
    try {
      const transport = nodemailer.createTransport({
        host: await this.address(), port: this.port, secure: this.port === 465, requireTLS: this.port !== 465,
        auth: { user: this.user, pass: this.pass },
        connectionTimeout: 10_000, greetingTimeout: 8_000, socketTimeout: 15_000,
        tls: { minVersion: 'TLSv1.2', servername: this.host },
        name: 'api.qmtradein.com', logger: false, debug: false,
      });
      const info = await transport.sendMail({ from: this.fromHeader, to, subject, html, text });
      transport.close();
      return info.accepted?.length ? { ok: true as const } : { ok: false as const, status: 502, code: 'smtp_rejected' };
    } catch (err) {
      // Only the SMTP response class is kept — never the message (it can echo the address or credentials).
      const e = err as { responseCode?: number; code?: string };
      const code = e.responseCode ?? 0;
      return { ok: false as const, status: code >= 500 ? 502 : 503, code: `smtp_${e.code ?? code}` };
    }
  }
}
