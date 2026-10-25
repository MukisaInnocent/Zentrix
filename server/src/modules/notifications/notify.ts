import { maybeOne } from '../../db/sql.js';
import { toDecimalString } from '../../lib/money.js';
import type { Services } from '../../services.js';

// Emails members about their deposits and withdrawals (owner, 2026-10-24). Sent after the database change has
// committed, never inside a money transaction; a failed email is logged and never undoes or blocks the change.

interface Payment {
  reference: string;
  currency: string;
  amountMinor: string;
}

export type PaymentEvent =
  | 'deposit_submitted' | 'deposit_confirmed' | 'deposit_rejected'
  | 'withdrawal_requested' | 'withdrawal_approved' | 'withdrawal_paid' | 'withdrawal_failed' | 'withdrawal_cancelled';

async function amount(services: Services, p: Payment): Promise<string> {
  const row = await maybeOne<{ exponent: number }>(services.pool, 'SELECT exponent FROM currencies WHERE code = $1', [p.currency]);
  // Thousands separators on the decimal string itself: no floating point.
  const [whole = '0', fraction] = toDecimalString(BigInt(p.amountMinor), row?.exponent ?? 0).split('.');
  return `${p.currency} ${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction ? `.${fraction}` : ''}`;
}

function message(event: PaymentEvent, money: string, ref: string, note: string | null, purpose: string): { subject: string; text: string } {
  const why = note ? `\n\nReason: ${note}` : '';
  if (purpose === 'wallet') {
    if (event === 'deposit_submitted') return { subject: `Deposit ${ref} received`, text: `We received your deposit of ${money} (reference ${ref}). Our team will credit your balance as soon as it is found on our statement.` };
    if (event === 'deposit_confirmed') return { subject: `Deposit ${ref} credited`, text: `${money} has been credited to your balance (deposit ${ref}).` };
    if (event === 'deposit_rejected') return { subject: `Deposit ${ref} not credited`, text: `We could not credit your deposit ${ref}.${why}\n\nContact support if you think this is a mistake.` };
  }
  switch (event) {
    case 'deposit_submitted':
      return { subject: `Activation payment ${ref} received`, text: `We received your activation payment of ${money} (reference ${ref}). Our team is checking it against our statement and will activate your account as soon as it is found.` };
    case 'deposit_confirmed':
      return { subject: `Account activated`, text: `Your activation payment of ${money} (reference ${ref}) is confirmed and your account is now active. You can use every part of Zentrix.` };
    case 'deposit_rejected':
      return { subject: `Activation payment ${ref} not confirmed`, text: `We could not confirm your activation payment ${ref}.${why}\n\nOpen the Activate page to submit it again, or contact support if you think this is a mistake.` };
    case 'withdrawal_requested':
      return { subject: `Withdrawal ${ref} requested`, text: `Your withdrawal of ${money} (reference ${ref}) is waiting for approval. The amount and fee are on hold until it is paid.` };
    case 'withdrawal_approved':
      return { subject: `Withdrawal ${ref} approved`, text: `Your withdrawal of ${money} (reference ${ref}) is approved and will be sent to your verified phone soon.` };
    case 'withdrawal_paid':
      return { subject: `Withdrawal ${ref} paid`, text: `${money} has been sent to your verified phone (withdrawal ${ref}).${note ? `\n\nPayout transaction: ${note}` : ''}\n\nIf it has not arrived, open the Withdraw page and use Report a problem, or contact support.` };
    case 'withdrawal_failed':
      return { subject: `Withdrawal ${ref} failed`, text: `We could not send your withdrawal ${ref}. The full amount and fee are back in your balance.${why}` };
    case 'withdrawal_cancelled':
      return { subject: `Withdrawal ${ref} cancelled`, text: `Your withdrawal ${ref} was cancelled. The full amount and fee are back in your balance.${why}` };
  }
}

// Looks the payment up by reference and emails its owner. Fire and forget: callers do not await it.
export async function notifyPayment(services: Services, event: PaymentEvent, reference: string, note: string | null = null): Promise<void> {
  try {
    const table = event.startsWith('deposit') ? 'deposits' : 'withdrawals';
    const amountCol = table === 'deposits' ? 'coalesce(p.credited_amount_minor, p.claimed_amount_minor)' : 'p.amount_minor';
    const purposeCol = table === 'deposits' ? 'p.purpose' : `'withdrawal'`;
    const row = await maybeOne<{ email: string | null; username: string; currency_code: string; amount: string; purpose: string }>(
      services.pool,
      `SELECT u.email, u.username, p.currency_code, ${amountCol}::text AS amount, ${purposeCol} AS purpose FROM ${table} p JOIN users u ON u.id = p.user_id WHERE p.reference = $1`,
      [reference],
    );
    if (!row?.email) return;
    const money = await amount(services, { reference, currency: row.currency_code, amountMinor: row.amount });
    const { subject, text } = message(event, money, reference, note, row.purpose);
    await services.mailer.send({ to: row.email, subject: `Zentrix: ${subject}`, text: `Hello @${row.username},

${text}

Zentrix` });
  } catch (err) {
    services.logger.error({ err, event, reference }, 'payment email failed');
  }
}

// A staff reply to a member's payment report goes to the member's email, since members have no reports page.
export async function notifyIssueReply(services: Services, userId: number, reply: string): Promise<void> {
  try {
    const user = await maybeOne<{ email: string | null; username: string }>(services.pool, 'SELECT email, username FROM users WHERE id = $1', [userId]);
    if (!user?.email) return;
    await services.mailer.send({
      to: user.email,
      subject: 'Zentrix: reply to your payment report',
      text: `Hello @${user.username},\n\nOur payments team replied to your report:\n\n${reply}\n\nTo answer, use Report a problem again or contact support.\n\nZentrix`,
    });
  } catch (err) {
    services.logger.error({ err, userId }, 'issue reply email failed');
  }
}
