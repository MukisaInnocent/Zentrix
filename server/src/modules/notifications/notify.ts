import { maybeOne, rows } from '../../db/sql.js';
import { toDecimalString } from '../../lib/money.js';
import type { Services } from '../../services.js';
import { sendTemplated, type TemplateKind } from '../email/templates.js';

// Emails members about their payments, activation, referral rewards and new sign-ins (owner, 2026-10-24 and
// 2026-10-28). Sent after the database change has committed, never inside a money transaction; sendEmail logs a
// failure and never undoes or blocks the change.

export type PaymentEvent =
  | 'deposit_submitted' | 'deposit_confirmed' | 'deposit_rejected'
  | 'withdrawal_requested' | 'withdrawal_approved' | 'withdrawal_paid' | 'withdrawal_failed' | 'withdrawal_cancelled';

// Thousands separators on the decimal string itself: no floating point.
export async function formatAmount(services: Pick<Services, 'pool'>, currency: string, amountMinor: string): Promise<string> {
  const row = await maybeOne<{ exponent: number }>(services.pool, 'SELECT exponent FROM currencies WHERE code = $1', [currency]);
  const [whole = '0', fraction] = toDecimalString(BigInt(amountMinor), row?.exponent ?? 0).split('.');
  return `${currency} ${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction ? `.${fraction}` : ''}`;
}

// Each payment event has its own email kind (wording editable in the staff console). Activation payments and
// deposits into the balance (purpose 'wallet') have separate wording.
const PAYMENT_KIND: Record<PaymentEvent, TemplateKind> = {
  deposit_submitted: 'payment_deposit_submitted', deposit_confirmed: 'payment_deposit_confirmed', deposit_rejected: 'payment_deposit_rejected',
  withdrawal_requested: 'payment_withdrawal_requested', withdrawal_approved: 'payment_withdrawal_approved', withdrawal_paid: 'payment_withdrawal_paid',
  withdrawal_failed: 'payment_withdrawal_failed', withdrawal_cancelled: 'payment_withdrawal_cancelled',
};
const WALLET_KIND: Partial<Record<PaymentEvent, TemplateKind>> = {
  deposit_submitted: 'payment_wallet_deposit_submitted', deposit_confirmed: 'payment_wallet_deposit_confirmed', deposit_rejected: 'payment_wallet_deposit_rejected',
};
const BUTTON_PATH: Partial<Record<TemplateKind, string>> = {
  payment_deposit_confirmed: '/dashboard.html', payment_deposit_rejected: '/activate.html', payment_wallet_deposit_confirmed: '/dashboard.html', payment_withdrawal_paid: '/withdraw.html',
};

// Looks the payment up by reference and emails its owner. Never throws. Callers await it before replying: on AWS
// Lambda the function freezes once the reply is sent, so an email started afterwards may never go out. A confirmed
// activation also tells the people above the member about the referral rewards it paid.
export async function notifyPayment(services: Services, event: PaymentEvent, reference: string, note: string | null = null): Promise<void> {
  try {
    const table = event.startsWith('deposit') ? 'deposits' : 'withdrawals';
    const amountCol = table === 'deposits' ? 'coalesce(p.credited_amount_minor, p.claimed_amount_minor)' : 'p.amount_minor';
    const purposeCol = table === 'deposits' ? 'p.purpose' : `'withdrawal'`;
    const row = await maybeOne<{ user_id: string; email: string | null; username: string; currency_code: string; amount: string; purpose: string }>(
      services.pool,
      `SELECT u.id AS user_id, u.email, u.username, p.currency_code, ${amountCol}::text AS amount, ${purposeCol} AS purpose
       FROM ${table} p JOIN users u ON u.id = p.user_id WHERE p.reference = $1`,
      [reference],
    );
    if (!row) return;
    if (row.email) {
      const kind = (row.purpose === 'wallet' ? WALLET_KIND[event] : undefined) ?? PAYMENT_KIND[event];
      const path = BUTTON_PATH[kind];
      await sendTemplated(services, {
        kind, to: row.email, userId: Number(row.user_id), ref: `${event}:${reference}`,
        values: {
          username: row.username, amount: await formatAmount(services, row.currency_code, row.amount), reference,
          reason: event === 'withdrawal_paid' ? null : note, payout: event === 'withdrawal_paid' ? note : null,
        },
        ...(path ? { buttonUrl: `${services.config.publicOrigin}${path}` } : {}),
      });
    }
    if (event === 'deposit_confirmed') await notifyReferralRewards(services);
  } catch (err) {
    services.logger.error({ err, event, reference }, 'payment email failed');
  }
}

// A staff reply to a member's payment report goes to the member's email, since members have no reports page.
export async function notifyIssueReply(services: Services, userId: number, reply: string): Promise<void> {
  try {
    const user = await maybeOne<{ email: string | null; username: string }>(services.pool, 'SELECT email, username FROM users WHERE id = $1', [userId]);
    if (!user?.email) return;
    await sendTemplated(services, { kind: 'issue_reply', to: user.email, userId, values: { username: user.username, reply } });
  } catch (err) {
    services.logger.error({ err, userId }, 'issue reply email failed');
  }
}

// Tells a member that another member activated their account (`how`: "voucher ZX-..." or "a payment from @..."),
// and the people above them about the referral rewards it paid.
export async function notifyActivatedBy(services: Services, username: string, how: string): Promise<void> {
  try {
    const user = await maybeOne<{ id: string; email: string | null }>(services.pool, 'SELECT id, email FROM users WHERE username = $1', [username]);
    if (user?.email) {
      await sendTemplated(services, {
        kind: 'activated_by', to: user.email, userId: Number(user.id), ref: `activated:${user.id}`, values: { username, how },
        buttonUrl: `${services.config.publicOrigin}/dashboard.html`,
      });
    }
    await notifyReferralRewards(services);
  } catch (err) {
    services.logger.error({ err, username }, 'activation email failed');
  }
}

// Tells the direct inviter, right away, that someone signed up with their link (owner, 2026-10-28). The reward
// itself comes with the activation and has its own email.
export async function notifyReferralSignup(services: Services, userId: number): Promise<void> {
  try {
    const r = await maybeOne<{ id: string; email: string | null; username: string; member: string; country: string }>(
      services.pool,
      `SELECT i.id, i.email, i.username, m.username AS member, c.name AS country
       FROM users m JOIN users i ON i.id = m.referred_by_user_id JOIN countries c ON c.code = m.country_code WHERE m.id = $1`,
      [userId],
    );
    if (!r?.email) return;
    await sendTemplated(services, {
      kind: 'referral_signup', to: r.email, userId: Number(r.id), ref: `signup:${userId}`,
      values: { username: r.username, member: r.member, country: r.country },
      buttonUrl: `${services.config.publicOrigin}/referrals.html?level=1&view=inactive`,
    });
  } catch (err) {
    services.logger.error({ err, userId }, 'referral sign-up email failed');
  }
}

// Emails each referrer about referral rewards credited in the last 14 days that have no email yet: after an
// activation, and after the exchange-rate job pays rewards that waited for a rate. Each reward is emailed once
// (email_messages kind + ref); members can turn these off.
export async function notifyReferralRewards(services: Services): Promise<number> {
  const due = await rows<{
    id: string; referrer_id: string; email: string | null; username: string; member: string; level: number;
    amount_minor: string; currency_code: string; source_amount_minor: string | null; source_currency_code: string | null;
  }>(
    services.pool,
    `SELECT r.id, r.referrer_user_id AS referrer_id, u.email, u.username, m.username AS member, r.level, r.amount_minor::text,
            r.currency_code, r.source_amount_minor::text, r.source_currency_code
     FROM referral_rewards r JOIN users u ON u.id = r.referrer_user_id JOIN users m ON m.id = r.referred_user_id
     WHERE r.status = 'credited' AND r.created_at > now() - interval '14 days' AND u.email IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM email_messages e WHERE e.kind = 'referral_reward' AND e.ref = 'reward:' || r.id)
     ORDER BY r.id LIMIT 200`,
    [],
  );
  let sent = 0;
  for (const r of due) {
    const money = await formatAmount(services, r.currency_code, r.amount_minor);
    const conversion = r.source_amount_minor && r.source_currency_code && r.source_currency_code !== r.currency_code
      ? `@${r.member} paid in ${r.source_currency_code}, so the reward of ${await formatAmount(services, r.source_currency_code, r.source_amount_minor)} was converted into your currency at the latest exchange rate.`
      : null;
    const outcome = await sendTemplated(services, {
      kind: 'referral_reward', to: r.email!, userId: Number(r.referrer_id), ref: `reward:${r.id}`,
      values: { username: r.username, member: r.member, amount: money, level: String(r.level), conversion },
      buttonUrl: `${services.config.publicOrigin}/referrals.html?level=${r.level}&view=overview`,
    });
    if (outcome === 'queued' || outcome === 'sent') sent++;
  }
  return sent;
}

// Warns a member when their account is signed in from a device or network not seen in the last 90 days. The
// very first sign-in sends nothing. Members can turn these off.
export async function notifySignIn(services: Services, userId: number, ip: string | undefined, userAgent: string | undefined): Promise<void> {
  try {
    const seen = await maybeOne<{ same: string; total: string; email: string | null; username: string }>(
      services.pool,
      `SELECT count(*) FILTER (WHERE a.ip IS NOT DISTINCT FROM $2::inet AND a.user_agent IS NOT DISTINCT FROM $3) AS same, count(*) AS total, u.email, u.username
       FROM users u LEFT JOIN auth_events a ON a.user_id = u.id AND a.kind IN ('login', 'signup') AND a.created_at > now() - interval '90 days'
       WHERE u.id = $1 GROUP BY u.id`,
      [userId, ip ?? null, userAgent?.slice(0, 300) ?? null],
    );
    // The sign-in that just happened is already counted.
    if (!seen?.email || Number(seen.total) <= 1 || Number(seen.same) > 1) return;
    await sendTemplated(services, {
      kind: 'sign_in_alert', to: seen.email, userId,
      values: { username: seen.username, time: services.now().toISOString().replace('T', ' ').slice(0, 16), device: (userAgent ?? 'unknown').slice(0, 120) },
      buttonUrl: `${services.config.publicOrigin}/profile.html`,
    });
  } catch (err) {
    services.logger.error({ err, userId }, 'sign-in alert failed');
  }
}
