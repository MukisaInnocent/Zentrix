import { maybeOne, rows } from '../../db/sql.js';
import { toDecimalString } from '../../lib/money.js';
import type { Services } from '../../services.js';
import { sendEmail } from '../email/send.js';

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

interface Message {
  subject: string;
  heading: string;
  paragraphs: string[];
  button?: { label: string; path: string };
}

const WELCOME_NEXT = 'Here is what you can do now:\n- Invite people with your username as the referral code; see Referrals for your link.\n- Use Pay For Client or vouchers to help someone else activate.\n- See your balance and history on the dashboard.';

function message(event: PaymentEvent, money: string, ref: string, note: string | null, purpose: string): Message {
  const why = note ? [`Reason: ${note}`] : [];
  if (purpose === 'wallet') {
    if (event === 'deposit_submitted') return { subject: `Deposit ${ref} received`, heading: 'We received your deposit', paragraphs: [`We received your deposit of ${money} (reference ${ref}). Our team will credit your balance as soon as it is found on our statement.`] };
    if (event === 'deposit_confirmed') return { subject: `Deposit ${ref} credited`, heading: 'Deposit credited', paragraphs: [`${money} has been credited to your balance (deposit ${ref}).`], button: { label: 'Open your dashboard', path: '/dashboard.html' } };
    if (event === 'deposit_rejected') return { subject: `Deposit ${ref} not credited`, heading: 'We could not credit your deposit', paragraphs: [`We could not credit your deposit ${ref}.`, ...why, 'Contact support if you think this is a mistake.'] };
  }
  switch (event) {
    case 'deposit_submitted':
      return { subject: `Activation payment ${ref} received`, heading: 'We received your activation payment', paragraphs: [`We received your activation payment of ${money} (reference ${ref}). Our team is checking it against our statement and will activate your account as soon as it is found.`] };
    case 'deposit_confirmed':
      return {
        subject: 'Welcome! Your account is active', heading: 'Welcome to Pexerearn',
        paragraphs: [`Your activation payment of ${money} (reference ${ref}) is confirmed and your account is now active.`, WELCOME_NEXT],
        button: { label: 'Open your dashboard', path: '/dashboard.html' },
      };
    case 'deposit_rejected':
      return { subject: `Activation payment ${ref} not confirmed`, heading: 'We could not confirm your payment', paragraphs: [`We could not confirm your activation payment ${ref}.`, ...why, 'Open the Activate page to submit it again, or contact support if you think this is a mistake.'], button: { label: 'Open the Activate page', path: '/activate.html' } };
    case 'withdrawal_requested':
      return { subject: `Withdrawal ${ref} requested`, heading: 'Withdrawal requested', paragraphs: [`Your withdrawal of ${money} (reference ${ref}) is waiting for approval. The amount and fee are on hold until it is paid.`] };
    case 'withdrawal_approved':
      return { subject: `Withdrawal ${ref} approved`, heading: 'Withdrawal approved', paragraphs: [`Your withdrawal of ${money} (reference ${ref}) is approved and will be sent to your verified phone soon.`] };
    case 'withdrawal_paid':
      return { subject: `Withdrawal ${ref} paid`, heading: 'Withdrawal paid', paragraphs: [`${money} has been sent to your verified phone (withdrawal ${ref}).`, ...(note ? [`Payout transaction: ${note}`] : []), 'If it has not arrived, open the Withdraw page and use Report a problem, or contact support.'], button: { label: 'Open the Withdraw page', path: '/withdraw.html' } };
    case 'withdrawal_failed':
      return { subject: `Withdrawal ${ref} failed`, heading: 'Withdrawal failed', paragraphs: [`We could not send your withdrawal ${ref}. The full amount and fee are back in your balance.`, ...why] };
    case 'withdrawal_cancelled':
      return { subject: `Withdrawal ${ref} cancelled`, heading: 'Withdrawal cancelled', paragraphs: [`Your withdrawal ${ref} was cancelled. The full amount and fee are back in your balance.`, ...why] };
  }
}

// Looks the payment up by reference and emails its owner. Fire and forget: callers do not await it. A confirmed
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
      const m = message(event, await formatAmount(services, row.currency_code, row.amount), reference, note, row.purpose);
      await sendEmail(services, {
        to: row.email, userId: Number(row.user_id), kind: `payment_${event}`, category: 'payment', ref: `${event}:${reference}`,
        subject: `Pexerearn: ${m.subject}`, heading: m.heading, paragraphs: [`Hello @${row.username},`, ...m.paragraphs],
        ...(m.button ? { button: { label: m.button.label, url: `${services.config.publicOrigin}${m.button.path}` } } : {}),
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
    await sendEmail(services, {
      to: user.email, userId, kind: 'issue_reply', category: 'payment', subject: 'Pexerearn: reply to your payment report',
      heading: 'Reply to your payment report',
      paragraphs: [`Hello @${user.username},`, 'Our payments team replied to your report:', reply, 'To answer, use Report a problem again or contact support.'],
    });
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
      await sendEmail(services, {
        to: user.email, userId: Number(user.id), kind: 'activated_by', category: 'account', ref: `activated:${user.id}`,
        subject: 'Pexerearn: Welcome! Your account is active', heading: 'Welcome to Pexerearn',
        paragraphs: [`Hello @${username},`, `Your account was activated with ${how}. You can now use every part of Pexerearn.`, WELCOME_NEXT],
        button: { label: 'Open your dashboard', url: `${services.config.publicOrigin}/dashboard.html` },
      });
    }
    await notifyReferralRewards(services);
  } catch (err) {
    services.logger.error({ err, username }, 'activation email failed');
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
    const converted = r.source_amount_minor && r.source_currency_code && r.source_currency_code !== r.currency_code
      ? [`@${r.member} paid in ${r.source_currency_code}, so the reward of ${await formatAmount(services, r.source_currency_code, r.source_amount_minor)} was converted into your currency at the latest exchange rate.`]
      : [];
    const outcome = await sendEmail(services, {
      to: r.email!, userId: Number(r.referrer_id), kind: 'referral_reward', category: 'referral', ref: `reward:${r.id}`,
      subject: `Pexerearn: you earned ${money}`, heading: 'You earned a referral reward',
      paragraphs: [`Hello @${r.username},`, `@${r.member} activated their account, and ${money} (level ${r.level}) was added to your balance.`, ...converted],
      button: { label: 'See your referrals', url: `${services.config.publicOrigin}/referrals.html?level=${r.level}&view=overview` },
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
    await sendEmail(services, {
      to: seen.email, userId, kind: 'sign_in_alert', category: 'sign_in', subject: 'Pexerearn: new sign-in to your account',
      heading: 'New sign-in to your account',
      paragraphs: [
        `Hello @${seen.username},`,
        `Your account was just signed in from a device or network we have not seen recently.\nTime: ${services.now().toISOString().replace('T', ' ').slice(0, 16)} UTC\nDevice: ${(userAgent ?? 'unknown').slice(0, 120)}`,
        'If this was you, there is nothing to do. If it was not, change your password now (ask the admin to unlock it) and contact support.',
      ],
      button: { label: 'Open your profile', url: `${services.config.publicOrigin}/profile.html` },
    });
  } catch (err) {
    services.logger.error({ err, userId }, 'sign-in alert failed');
  }
}
