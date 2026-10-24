import { createTransport, type Transporter } from 'nodemailer';
import type { Config } from '../config/env.js';
import type { Pool } from '../db/pool.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;
  constructor(url: string, private readonly from: string) {
    this.transport = createTransport(url);
  }
  async send(message: MailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.from, to: message.to, subject: message.subject, text: message.text });
  }
}

// Resend email API (HTTPS, so it works on hosts that block SMTP ports). Without a verified domain, Resend
// sends only from onboarding@resend.dev and only to the address the Resend account was created with.
export class ResendMailer implements Mailer {
  constructor(private readonly apiKey: string, private readonly from: string) {}
  async send(message: MailMessage): Promise<void> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: this.from, to: [message.to], subject: message.subject, text: message.text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Resend rejected the email: HTTP ${res.status}`);
  }
}

// Test mode only (decision D18): messages are stored for the admin "Dev outbox" page instead of sent.
export class OutboxMailer implements Mailer {
  constructor(private readonly pool: Pool) {}
  async send(message: MailMessage): Promise<void> {
    await this.pool.query(`INSERT INTO dev_outbox (channel, recipient, subject, body) VALUES ('email', $1, $2, $3)`, [
      message.to,
      message.subject,
      message.text,
    ]);
  }
}

export function createMailer(config: Config, pool: Pool): Mailer {
  if (config.resendApiKey) return new ResendMailer(config.resendApiKey, config.mailFrom);
  if (config.smtpUrl) return new SmtpMailer(config.smtpUrl, config.mailFrom);
  if (config.appMode === 'test') return new OutboxMailer(pool);
  throw new Error('SMTP_URL or RESEND_API_KEY is required outside test mode.');
}
