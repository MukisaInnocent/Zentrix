import { Router, type Request } from 'express';
import { z } from 'zod';
import { limiter } from '../../http/rate-limit.js';
import { parse } from '../../http/validate.js';
import { badRequest } from '../../lib/errors.js';
import { MoneyFormatError, toMinor } from '../../lib/money.js';
import type { Services } from '../../services.js';
import { requireActivated, requireAuth } from '../auth/middleware.js';
import { idempotent, moneyTx } from '../ledger/idempotency.js';
import { BALANCE_SOURCES, getWalletSummary, memberInfo } from '../wallet/service.js';
import { exponentOf, flagActive, listChannels, publicChannel } from './common.js';
import { cancelDeposit, listMemberDeposits, submitDeposit } from './deposits.js';
import { addMessage, findIssue, ISSUE_CATEGORIES, ISSUE_SELECT, issueView, messagesOf, openIssue, type IssueRow } from './issues.js';
import { listMemberWithdrawals, memberCancelWithdrawal, quoteWithdrawal, requestWithdrawal } from './withdrawals.js';
import { rows } from '../../db/sql.js';
import { notifyPayment } from '../notifications/notify.js';
import { autoConfirmDeposit, autoPayWithdrawal, ensureTestChannel } from './autopilot.js';

const HOUR = 3_600_000;

// Amounts arrive as decimal strings in major units (D9); numbers are accepted from older pages.
export const AmountInput = z.union([z.string().trim().max(24), z.number().nonnegative()]).transform(String);

export async function amountToMinor(db: Parameters<typeof exponentOf>[0], currency: string, amount: string, field = 'amount'): Promise<bigint> {
  try {
    const minor = toMinor(amount, await exponentOf(db, currency));
    if (minor <= 0n) throw new MoneyFormatError('Enter an amount above zero.');
    return minor;
  } catch (err) {
    if (err instanceof MoneyFormatError) throw badRequest('validation_failed', err.message, { [field]: [err.message] });
    throw err;
  }
}

const Uuid = z.uuid();
const DepositBody = z.strictObject({
  channel: z.string().trim().min(2).max(40),
  senderPhone: z.string().trim().min(4).max(32),
  providerTxnId: z.string().trim().min(4, { error: 'Enter the transaction ID from your payment message.' }).max(60),
  note: z.string().trim().max(300).optional(),
});
const WithdrawBody = z.strictObject({ source: z.enum(BALANCE_SOURCES).default('main'), amount: AmountInput });
const QuoteQuery = z.object({ amount: z.string().trim().max(24) });
const IssueBody = z.strictObject({
  subjectType: z.enum(['deposit', 'withdrawal', 'other']),
  reference: z.string().trim().max(20).optional(),
  category: z.enum(ISSUE_CATEGORIES),
  message: z.string().trim().min(10, { error: 'Describe the problem in a sentence or two.' }).max(2000),
});
const MessageBody = z.strictObject({ body: z.string().trim().min(1).max(2000) });

function publicId(value: unknown): string {
  const id = Uuid.safeParse(value);
  if (!id.success) throw badRequest('validation_failed', 'Unknown record.');
  return id.data;
}

export function paymentsRouter(services: Services): Router {
  const { pool } = services;
  const router = Router();
  router.use(requireAuth);
  const byUser = (req: Request) => `u${req.auth!.userId}`;
  // Withdrawals open only after the activation fee is confirmed; the activation payment itself must not wait.
  router.use('/withdrawals', requireActivated(services));

  // The activation payment page: the fee, the payment methods for the member's country (USSD and merchant
  // codes), and whether the account is already active.
  router.get('/channels', async (req, res) => {
    const member = await memberInfo(pool, req.auth!.userId);
    await ensureTestChannel(services, member);
    const [channels, deposits, withdrawals, summary] = await Promise.all([
      listChannels(pool, { currency: member.currency, country: member.countryCode }),
      flagActive(pool, 'deposits_paused', member.currency),
      flagActive(pool, 'withdrawals_paused', member.currency),
      getWalletSummary(pool, req.auth!.userId),
    ]);
    res.json({
      currency: member.currency,
      country: member.countryCode,
      phone: member.phone,
      payoutPhone: member.phoneVerified ? member.phone : null,
      depositsPaused: deposits.active,
      withdrawalsPaused: withdrawals.active,
      // Test mode with TEST_AUTO_APPROVE: payments pass by themselves, and the page says so.
      autoApprove: services.config.appMode === 'test' && services.config.testAutoApprove,
      activation: { active: summary.membershipActive, activatedAt: summary.membershipActivatedAt, feeMinor: summary.membershipFeeMinor },
      channels: channels.filter(c => c.depositsEnabled || c.payoutsEnabled).map(publicChannel),
    });
  });

  router.get('/deposits', async (req, res) => {
    res.json({ deposits: await listMemberDeposits(pool, req.auth!.userId) });
  });

  router.post('/deposits', limiter(pool, { name: 'deposit-claim', windowMs: HOUR, limit: 20, key: byUser }), async (req, res) => {
    const input = parse(DepositBody, req.body);
    const result = await idempotent(pool, req, 'deposit.submit', async db => {
      const deposit = await submitDeposit(db, req.auth!.userId, { channelCode: input.channel, senderPhone: input.senderPhone, providerTxnId: input.providerTxnId, note: input.note });
      return { status: 201, body: { deposit } };
    });
    if (!result.replayed) {
      const deposit = result.body.deposit as { id: string; reference: string };
      void notifyPayment(services, 'deposit_submitted', deposit.reference);
      if (await autoConfirmDeposit(services, deposit.id)) void notifyPayment(services, 'deposit_confirmed', deposit.reference);
    }
    res.status(result.status).json(result.body);
  });

  router.post('/deposits/:id/cancel', async (req, res) => {
    const id = publicId(req.params.id);
    const deposit = await moneyTx(pool, db => cancelDeposit(db, req.auth!.userId, id));
    res.json({ deposit });
  });

  router.get('/withdrawals', async (req, res) => {
    res.json({ withdrawals: await listMemberWithdrawals(pool, req.auth!.userId) });
  });

  // Fee and limits previewed by the server (the browser never calculates money).
  router.get('/withdrawals/quote', async (req, res) => {
    const { amount } = parse(QuoteQuery, req.query);
    const member = await memberInfo(pool, req.auth!.userId);
    res.json({ quote: await quoteWithdrawal(pool, req.auth!.userId, await amountToMinor(pool, member.currency, amount)) });
  });

  router.post('/withdrawals', limiter(pool, { name: 'withdrawal', windowMs: HOUR, limit: 20, key: byUser }), async (req, res) => {
    const input = parse(WithdrawBody, req.body);
    const result = await idempotent(pool, req, 'withdrawal.request', async db => {
      const member = await memberInfo(db, req.auth!.userId);
      const amountMinor = await amountToMinor(db, member.currency, input.amount);
      const { withdrawal, quote } = await requestWithdrawal(db, req.auth!.userId, { source: input.source, amountMinor });
      return { status: 201, body: { withdrawal, quote } };
    });
    if (!result.replayed) {
      const withdrawal = result.body.withdrawal as { id: string; reference: string; currency: string };
      void notifyPayment(services, 'withdrawal_requested', withdrawal.reference);
      if (await autoPayWithdrawal(services, withdrawal.id, withdrawal.currency)) void notifyPayment(services, 'withdrawal_paid', withdrawal.reference, 'test mode');
    }
    res.status(result.status).json(result.body);
  });

  router.post('/withdrawals/:id/cancel', async (req, res) => {
    const id = publicId(req.params.id);
    const result = await idempotent(pool, req, `withdrawal.cancel.${id}`, async db => ({ status: 200, body: { withdrawal: await memberCancelWithdrawal(db, req.auth!.userId, id) } }));
    if (!result.replayed) void notifyPayment(services, 'withdrawal_cancelled', (result.body.withdrawal as { reference: string }).reference, 'Cancelled at your request.');
    res.status(result.status).json(result.body);
  });

  router.get('/issues', async (req, res) => {
    const list = await rows<IssueRow>(pool, `${ISSUE_SELECT} WHERE i.user_id = $1 ORDER BY i.id DESC LIMIT 50`, [req.auth!.userId]);
    res.json({ issues: list.map(issueView).map(({ assignedTo: _a, member: _m, ...rest }) => rest) });
  });

  router.post('/issues', limiter(pool, { name: 'issue-open', windowMs: HOUR, limit: 10, key: byUser }), async (req, res) => {
    const input = parse(IssueBody, req.body);
    const issue = await moneyTx(pool, db => openIssue(db, req.auth!.userId, input));
    res.status(201).json({ issue });
  });

  router.get('/issues/:id', async (req, res) => {
    const issue = await findIssue(pool, publicId(req.params.id), req.auth!.userId);
    const messages = (await messagesOf(pool, issue.id)).map(m => ({ ...m, author: m.fromStaff ? 'Zentrix support' : m.author }));
    const { assignedTo: _a, member: _m, ...view } = issueView(issue);
    res.json({ issue: view, messages });
  });

  router.post('/issues/:id/messages', limiter(pool, { name: 'issue-message', windowMs: HOUR, limit: 30, key: byUser }), async (req, res) => {
    const { body } = parse(MessageBody, req.body);
    const id = publicId(req.params.id);
    await moneyTx(pool, async db => {
      const issue = await findIssue(db, id, req.auth!.userId);
      await addMessage(db, issue, req.auth!.userId, false, body);
    });
    res.status(201).json({ ok: true });
  });

  return router;
}
