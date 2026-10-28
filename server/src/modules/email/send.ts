import { maybeOne } from '../../db/sql.js';
import { isReservedAddress, OutboxMailer, ResendMailer, S3HandoffMailer } from '../../providers/mail.js';
import type { Services } from '../../services.js';
import { renderEmail, type EmailContent } from './template.js';

// Every email the site sends goes through sendEmail (owner, 2026-10-28). It records the email in email_messages,
// skips test addresses and suppressed ones (permanent bounce or spam report), leaves out optional emails a member
// turned off, sends each (kind, ref) only once, and never throws: a failed email is logged and recorded, and never
// undoes or blocks the change it reports. Call it after the database change has committed.

export type EmailCategory = 'security' | 'payment' | 'account' | 'referral' | 'sign_in';
export type Preference = 'referral_rewards' | 'sign_in_alerts';

// Security, payment and account emails always go; these are the ones a member can turn off.
export const OPTIONAL: Partial<Record<EmailCategory, Preference>> = { referral: 'referral_rewards', sign_in: 'sign_in_alerts' };

export interface OutgoingEmail extends EmailContent {
  to: string;
  userId?: number | null;
  kind: string;
  category: EmailCategory;
  subject: string;
  // Set to send this email only once (for example 'reward:42').
  ref?: string;
}

export type SendOutcome = 'queued' | 'sent' | 'skipped' | 'suppressed' | 'opted_out' | 'duplicate' | 'failed';

export async function emailPreferences(services: Pick<Services, 'pool'>, userId: number): Promise<Record<Preference, boolean>> {
  const row = await maybeOne<{ referral_rewards: boolean; sign_in_alerts: boolean }>(
    services.pool, 'SELECT referral_rewards, sign_in_alerts FROM email_preferences WHERE user_id = $1', [userId],
  );
  return { referral_rewards: row?.referral_rewards ?? true, sign_in_alerts: row?.sign_in_alerts ?? true };
}

export async function sendEmail(services: Services, email: OutgoingEmail): Promise<SendOutcome> {
  const { pool, config, logger } = services;
  const to = email.to.trim();
  let id: string | null = null;
  try {
    const preference = OPTIONAL[email.category];
    if (preference && email.userId && !(await emailPreferences(services, email.userId))[preference]) return 'opted_out';

    let status: 'queued' | 'skipped' | 'suppressed' = 'queued';
    let detail: string | null = null;
    // The test-mode outbox only stores messages, so it keeps those of test accounts too.
    if (isReservedAddress(to) && !(services.mailer instanceof OutboxMailer)) {
      status = 'skipped';
      detail = 'A test address that cannot receive mail.';
    } else {
      const blocked = await maybeOne<{ reason: string }>(pool, 'SELECT reason FROM email_suppressions WHERE email = lower($1)', [to]);
      if (blocked) {
        status = 'suppressed';
        detail = blocked.reason === 'complained' ? 'The address reported an earlier email as spam.' : 'The address bounced permanently before.';
      }
    }
    const row = await maybeOne<{ id: string }>(
      pool,
      `INSERT INTO email_messages (user_id, recipient, kind, category, subject, ref, status, detail) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (kind, ref) WHERE ref IS NOT NULL DO NOTHING RETURNING id`,
      [email.userId ?? null, to, email.kind, email.category, email.subject.slice(0, 200), email.ref ?? null, status, detail],
    );
    if (!row) return 'duplicate';
    if (status !== 'queued') return status;
    id = row.id;

    const footer = email.footer ?? (preference
      ? 'You get this email because it is turned on in your Pexerearn profile. Open Profile > Emails to change it.'
      : undefined);
    const rendered = renderEmail({ ...email, footer }, { origin: config.publicOrigin, testMode: config.appMode === 'test' });
    await services.mailer.send({ to, subject: email.subject, text: rendered.text, html: rendered.html, id });
    // Only Resend reports delivery back (webhooks); with SMTP or the test outbox, handing it over is the end.
    const tracked = services.mailer instanceof ResendMailer || services.mailer instanceof S3HandoffMailer;
    if (!tracked) await pool.query(`UPDATE email_messages SET status = 'sent', updated_at = now() WHERE id = $1`, [id]);
    return tracked ? 'queued' : 'sent';
  } catch (err) {
    logger.error({ err, kind: email.kind }, 'email not sent');
    if (id) {
      await pool.query(`UPDATE email_messages SET status = 'failed', detail = $2, updated_at = now() WHERE id = $1`, [
        id, (err instanceof Error ? err.message : String(err)).slice(0, 500),
      ]).catch(() => undefined);
    }
    return 'failed';
  }
}
