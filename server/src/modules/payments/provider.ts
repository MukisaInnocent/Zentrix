import type { Request, Response } from 'express';
import type { PoolClient } from '../../db/pool.js';
import type { Db } from '../../db/sql.js';
import { maybeOne, one, rows } from '../../db/sql.js';
import { withTransaction } from '../../db/tx.js';
import { sha256 } from '../../lib/crypto.js';
import { AppError, badRequest, conflict, serviceUnavailable } from '../../lib/errors.js';
import { toDecimalString } from '../../lib/money.js';
import { providerAmountToMinor, scalar, verifyLivePaySignature, type ProviderCommand, type ProviderOutcome } from '../../providers/livepay.js';
import type { Services } from '../../services.js';
import type { Role } from '../auth/context.js';
import { accountId, balanceOf, InsufficientFundsError, move, post } from '../ledger/ledger.js';
import { moneyTx } from '../ledger/idempotency.js';
import { notifyPayment, type PaymentEvent } from '../notifications/notify.js';
import { memberInfo } from '../wallet/service.js';
import { systemUser } from './autopilot.js';
import { listChannels, exponentOf, normalizePhone, normalizeTxnId, type Channel } from './common.js';
import { confirmDeposit, rejectDeposit, submitDeposit, type DepositView } from './deposits.js';
import { raise } from './reconciliation.js';
import { staffWithdrawalAction, WITHDRAWAL_SELECT, withdrawalView, type WithdrawalRow, type WithdrawalView } from './withdrawals.js';

// Payments through the provider API (owner, 2026-10-30: LivePay; docs/PLAN.md D29). A collection or payout is a
// provider_requests row plus a command; the provider's answers (outcomes) are applied here, by one function, whether
// they come straight back (local, Render, simulator), through S3 (AWS), from a webhook-triggered status read, or from
// the polling job. Money moves only on a status read that matches the request's amount and currency. The system
// account zx_livepay confirms, rejects and records payouts, so staff and member checks (two-person rule) still hold.

const PROVIDER_ACTOR = { username: 'zx_livepay', phone: '+256700990003' };

// LivePay's limits: 50 collections and status reads per 15 minutes, 5 payouts a minute. We keep a margin; status
// reads after a webhook may use part of it. A member may have 5 failed prompts a day.
export const BUDGET = { readsPer15Min: 45, webhookReadsPer15Min: 48, payoutsPerMinute: 5, reserveForStatus: 10, failedPromptsPerDay: 5 };
// A request with no answer is read again after this long; one still open after a day goes to staff review.
const RECHECK_MINUTES = 2;
const MISSING_FAIL_MINUTES = 15;
const REVIEW_AFTER_HOURS = 24;

interface RequestRow {
  id: string; public_id: string; provider: string; kind: 'collect' | 'payout'; deposit_id: string | null; withdrawal_id: string | null;
  channel_id: string; reference: string; phone: string; amount_minor: string; currency_code: string; status: string;
  provider_ref: string | null; created_at: Date;
}

async function recordCall(db: Db, provider: string, op: ProviderCommand['op'], reference: string): Promise<void> {
  await db.query('INSERT INTO provider_calls (provider, op, reference) VALUES ($1, $2, $3)', [provider, op, reference]);
}

// Counting and recording calls happens under one lock, so concurrent requests cannot overshoot the budget.
async function lockBudget(db: Db): Promise<void> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtext('zentrix-provider-budget'))`);
}

async function callsSince(db: Db, provider: string, ops: string[], interval: string): Promise<number> {
  const row = await one<{ n: string }>(
    db, `SELECT count(*) AS n FROM provider_calls WHERE provider = $1 AND op = ANY($2) AND at > now() - $3::interval`, [provider, ops, interval],
  );
  return Number(row.n);
}

function gateway(services: Services) {
  const g = services.payments;
  if (!g) throw serviceUnavailable('payments.provider_off', 'Mobile money payments are not available right now. Please use another payment method.');
  return g;
}

// The provider's payment method for a country, if one is set up and switched on.
export async function providerChannel(db: Db, country: string, currency: string, use: 'deposits' | 'payouts'): Promise<Channel | null> {
  const list = await listChannels(db, { country, currency });
  return list.find(c => c.provider && (use === 'deposits' ? c.depositsEnabled : c.payoutsEnabled)) ?? null;
}

async function commandFor(db: Db, r: Pick<RequestRow, 'kind' | 'reference' | 'currency_code' | 'phone' | 'amount_minor'>, provider: string): Promise<ProviderCommand> {
  const exponent = await exponentOf(db, r.currency_code);
  return {
    op: r.kind, provider: provider as ProviderCommand['provider'], reference: r.reference, currency: r.currency_code, phone: r.phone,
    amount: toDecimalString(BigInt(r.amount_minor), exponent),
    description: r.kind === 'collect' ? `Pexerearn activation ${r.reference}` : `Pexerearn withdrawal ${r.reference}`,
    createdAt: new Date().toISOString(),
  };
}

// Member: start paying the activation fee through the provider. Runs inside the request's idempotent transaction;
// the caller sends the returned command after commit (sendCommand), so no money call happens inside a transaction.
export async function startCollection(
  db: PoolClient, services: Services, userId: number, input: { channelCode: string; phone?: string | undefined },
): Promise<{ deposit: DepositView; command: ProviderCommand }> {
  const g = gateway(services);
  const member = await memberInfo(db, userId);
  // LivePay needs the network for every currency except UGX; choosing a network is not built yet.
  if (member.currency !== 'UGX') {
    throw badRequest('payments.channel_unavailable', 'Mobile money prompts are not available for your country yet. Please use another payment method.');
  }
  // Prompts go only to the member's registered number, so nobody can send payment prompts to strangers.
  const phone = normalizePhone(input.phone ?? member.phone ?? '');
  if (!member.phone || phone !== member.phone) {
    throw badRequest('payments.phone_registered', `Payment prompts go only to your registered number ${member.phone ?? ''}. To pay from another phone, use a manual method.`, { phone: ['Use your registered number.'] });
  }
  const failed = await one<{ n: string }>(
    db,
    `SELECT count(*) AS n FROM provider_requests r JOIN deposits d ON d.id = r.deposit_id
     WHERE d.user_id = $1 AND r.status = 'failed' AND r.created_at > now() - interval '1 day'`,
    [userId],
  );
  if (Number(failed.n) >= BUDGET.failedPromptsPerDay) {
    throw badRequest('payments.too_many_failed', 'Several payment prompts did not go through today. Please try again tomorrow, or use another payment method.');
  }
  await lockBudget(db);
  if (await callsSince(db, g.provider, ['collect', 'status'], '15 minutes') >= BUDGET.readsPer15Min - BUDGET.reserveForStatus) {
    throw serviceUnavailable('payments.provider_busy', 'Mobile money payments are busy right now. Please try again in a few minutes, or use another payment method.');
  }
  const deposit = await submitDeposit(db, userId, { purpose: 'activation', method: 'api', channelCode: input.channelCode, senderPhone: phone });
  const d = await one<{ id: string; channel_id: string }>(db, 'SELECT id, channel_id FROM deposits WHERE public_id = $1', [deposit.id]);
  const request: RequestRow = await one<RequestRow>(
    db,
    `INSERT INTO provider_requests (provider, kind, deposit_id, channel_id, reference, phone, amount_minor, currency_code)
     VALUES ($1, 'collect', $2, $3, $4, $5, $6, $7) RETURNING *`,
    [g.provider, d.id, d.channel_id, deposit.reference, phone, deposit.claimedAmountMinor, deposit.currency],
  );
  await recordCall(db, g.provider, 'collect', request.reference);
  return { deposit, command: await commandFor(db, request, g.provider) };
}

// Staff: send an approved withdrawal through the provider. The starter must not be the approver when two people
// are needed (staffWithdrawalAction 'start'); the provider's method for the member's country pays it.
export async function startPayout(
  db: PoolClient, services: Services, publicId: string, staff: { id: number; roles: Role[]; note?: string | null | undefined },
): Promise<{ withdrawal: WithdrawalView; command: ProviderCommand; before: WithdrawalView }> {
  const g = gateway(services);
  await lockBudget(db);
  if (await callsSince(db, g.provider, ['payout'], '1 minute') >= BUDGET.payoutsPerMinute) {
    throw serviceUnavailable('payments.provider_busy', 'LivePay takes 5 payouts a minute. Wait a minute and send again.');
  }
  const w = await maybeOne<{ id: string; reference: string; status: string; currency_code: string; amount_minor: string; payout_phone: string; country_code: string }>(
    db,
    `SELECT w.id, w.reference, w.status, w.currency_code, w.amount_minor, w.payout_phone, u.country_code
     FROM withdrawals w JOIN users u ON u.id = w.user_id WHERE w.public_id = $1`,
    [publicId],
  );
  if (!w) throw badRequest('validation_failed', 'Unknown withdrawal.');
  if (w.status !== 'approved') throw conflict('withdrawal.wrong_state', `This withdrawal is ${w.status}; only an approved withdrawal can be sent.`);
  if (w.currency_code !== 'UGX') throw badRequest('payments.channel_unavailable', 'LivePay payouts are set up for UGX only so far. Pay this one by hand.');
  const channel = await providerChannel(db, w.country_code, w.currency_code, 'payouts');
  if (!channel) throw badRequest('payments.channel_unavailable', 'No LivePay payout method is switched on for this country. Pay this one by hand.');
  // Never send real money the ledger says the LivePay account does not hold.
  const clearing = await accountId(db, { kind: 'payment_clearing', channelId: channel.id, currency: w.currency_code });
  if (await balanceOf(db, clearing) < BigInt(w.amount_minor)) {
    throw conflict('withdrawal.channel_short', `The ledger shows less money held on ${channel.name} than this payout. Record a channel transfer first.`);
  }
  const { before } = await staffWithdrawalAction(db, publicId, { action: 'start', staffId: staff.id, roles: staff.roles, note: staff.note ?? `Sent with ${channel.name}` });
  await db.query(`UPDATE withdrawals SET payout_method = 'api' WHERE id = $1`, [w.id]);
  const request = await one<RequestRow>(
    db,
    `INSERT INTO provider_requests (provider, kind, withdrawal_id, channel_id, reference, phone, amount_minor, currency_code)
     VALUES ($1, 'payout', $2, $3, $4, $5, $6, $7) RETURNING *`,
    [g.provider, w.id, channel.id, w.reference, w.payout_phone, w.amount_minor, w.currency_code],
  );
  await recordCall(db, g.provider, 'payout', request.reference);
  const after = withdrawalView(await one<WithdrawalRow>(db, `${WITHDRAWAL_SELECT} WHERE w.id = $1`, [w.id]));
  return { withdrawal: after, command: await commandFor(db, request, g.provider), before };
}

// Staff or the polling job: ask the provider for the latest status of a request.
export async function checkRequest(services: Services, reference: string, opts: { force?: boolean } = {}): Promise<boolean> {
  const g = services.payments;
  if (!g) return false;
  const r = await maybeOne<RequestRow>(services.pool, 'SELECT * FROM provider_requests WHERE reference = $1', [reference]);
  if (!r || r.status === 'succeeded' || r.status === 'failed') return false;
  const limit = opts.force ? BUDGET.webhookReadsPer15Min : BUDGET.readsPer15Min;
  const allowed = await withTransaction(services.pool, async db => {
    await lockBudget(db);
    if (await callsSince(db, r.provider, ['collect', 'status'], '15 minutes') >= limit) return false;
    await recordCall(db, r.provider, 'status', reference);
    await db.query('UPDATE provider_requests SET checks = checks + 1, last_checked_at = now() WHERE id = $1', [r.id]);
    return true;
  });
  if (!allowed) return false;
  await sendCommand(services, { op: 'status', provider: r.provider as ProviderCommand['provider'], reference, currency: r.currency_code });
  return true;
}

// Sends a command and applies whatever comes straight back (nothing, on AWS: the outcome arrives through S3).
export async function sendCommand(services: Services, command: ProviderCommand): Promise<void> {
  const outcomes = await gateway(services).dispatch(command);
  for (const outcome of outcomes) await applyOutcome(services, outcome);
}

type Notice = { event: PaymentEvent; reference: string; note: string | null };

// Applies one provider outcome. Safe to repeat: a closed request ignores later outcomes, and every money step
// runs through the same deposit and withdrawal functions staff use, with their state checks.
export async function applyOutcome(services: Services, outcome: ProviderOutcome): Promise<void> {
  const notices = await moneyTx(services.pool, async db => {
    const out: Notice[] = [];
    const r = await maybeOne<RequestRow>(db, 'SELECT * FROM provider_requests WHERE reference = $1 FOR UPDATE', [outcome.reference]);
    if (!r) {
      services.logger.warn({ reference: outcome.reference, op: outcome.op }, 'provider outcome for an unknown reference ignored');
      return out;
    }
    if (r.status === 'succeeded' || r.status === 'failed') {
      // A result that contradicts a closed request (paid after we gave up, or reversed after success) is never
      // dropped silently: money may have moved twice or not at all.
      if (outcome.op === 'status' && ((r.status === 'failed' && outcome.status === 'succeeded') || (r.status === 'succeeded' && outcome.status === 'failed'))) {
        await raise(db, 'payments.provider_late_result', 'critical', r.currency_code,
          `LivePay now reports ${r.reference} as ${outcome.rawStatus ?? outcome.status} (${outcome.currency ?? ''} ${outcome.amount ?? ''}), but it was closed as ${r.status}. Check the LivePay dashboard and refund or recover the money.`.slice(0, 500),
          { reference: r.reference, kind: r.kind, closedAs: r.status, providerStatus: outcome.rawStatus ?? null });
      }
      return out;
    }
    const ageMinutes = (services.now().getTime() - r.created_at.getTime()) / 60_000;

    if (outcome.op !== 'status') {
      if (outcome.accepted === 'yes') {
        await db.query(
          `UPDATE provider_requests SET status = CASE WHEN status IN ('queued', 'sent') THEN 'pending' ELSE status END,
             provider_ref = coalesce($2, provider_ref), network = coalesce($3, network), message = $4 WHERE id = $1`,
          [r.id, outcome.providerRef ?? null, outcome.network ?? null, outcome.message?.slice(0, 500) ?? null],
        );
      } else if (outcome.accepted === 'no' && r.kind === 'collect') {
        out.push(...await fail(db, services, r, outcome, `LivePay refused the request: ${outcome.message ?? `HTTP ${outcome.httpStatus ?? '?'}`}`));
      } else {
        // A payout is never failed on a refusal alone (it may be a retry of one LivePay is paying): a status read decides.
        await db.query(`UPDATE provider_requests SET status = CASE WHEN status = 'queued' THEN 'sent' ELSE status END, message = $2 WHERE id = $1`,
          [r.id, (outcome.message ?? 'No clear answer; the status will be checked.').slice(0, 500)]);
      }
      return out;
    }

    await db.query('UPDATE provider_requests SET provider_status = coalesce($2, provider_status) WHERE id = $1', [r.id, outcome.rawStatus ?? null]);
    switch (outcome.status) {
      case 'pending':
        await db.query(`UPDATE provider_requests SET status = 'pending' WHERE id = $1 AND status IN ('queued', 'sent')`, [r.id]);
        if (ageMinutes > REVIEW_AFTER_HOURS * 60) await review(db, r, 'Still pending at LivePay after a day.');
        break;
      case 'missing':
        // A payout is never failed automatically on "missing": a delayed send could still pay it. Staff check it.
        if (ageMinutes > MISSING_FAIL_MINUTES) {
          if (r.kind === 'collect') out.push(...await fail(db, services, r, outcome, 'LivePay has no record of this payment.'));
          else await review(db, r, 'LivePay has no record of this payout. Check the LivePay dashboard before failing or paying it.');
        }
        break;
      case 'failed':
        out.push(...await fail(db, services, r, outcome, outcome.message ? `LivePay: ${outcome.message}` : 'The mobile-money payment failed.'));
        break;
      case 'succeeded':
        out.push(...await succeed(db, services, r, outcome));
        break;
      default:
        // An answer we cannot read: a status word we do not know goes to staff; a failed call is read again later.
        if (outcome.rawStatus) await review(db, r, `LivePay answered with an unknown status "${outcome.rawStatus}".`);
        else if (ageMinutes > REVIEW_AFTER_HOURS * 60) await review(db, r, 'No usable answer from LivePay after a day.');
    }
    return out;
  });
  for (const n of notices) await notifyPayment(services, n.event, n.reference, n.note);
}

async function review(db: PoolClient, r: RequestRow, message: string): Promise<void> {
  await db.query(`UPDATE provider_requests SET status = 'review', message = $2 WHERE id = $1`, [r.id, message.slice(0, 500)]);
  await raise(db, 'payments.provider_review', 'warning', r.currency_code, `LivePay ${r.kind === 'collect' ? 'payment' : 'payout'} ${r.reference} needs a staff check: ${message}`.slice(0, 500), { reference: r.reference });
}

async function fail(db: PoolClient, services: Services, r: RequestRow, outcome: ProviderOutcome, reason: string): Promise<Notice[]> {
  const actor = await systemUser(db, services, PROVIDER_ACTOR);
  await db.query(
    `UPDATE provider_requests SET status = 'failed', completed_at = now(), message = $2, provider_ref = coalesce($3, provider_ref) WHERE id = $1`,
    [r.id, reason.slice(0, 500), outcome.providerRef ?? null],
  );
  if (r.kind === 'collect') {
    const d = await one<{ public_id: string; reference: string; status: string }>(db, 'SELECT public_id, reference, status FROM deposits WHERE id = $1', [r.deposit_id]);
    if (d.status !== 'pending') return [];
    await rejectDeposit(db, actor, d.public_id, reason.slice(0, 500));
    return [{ event: 'deposit_rejected', reference: d.reference, note: reason }];
  }
  const w = await one<{ public_id: string; reference: string; status: string }>(db, 'SELECT public_id, reference, status FROM withdrawals WHERE id = $1', [r.withdrawal_id]);
  if (w.status !== 'processing') return [];
  await staffWithdrawalAction(db, w.public_id, { action: 'fail', staffId: actor, roles: ['finance'], note: reason.slice(0, 500) });
  return [{ event: 'withdrawal_failed', reference: w.reference, note: reason }];
}

async function succeed(db: PoolClient, services: Services, r: RequestRow, outcome: ProviderOutcome): Promise<Notice[]> {
  const exponent = await exponentOf(db, r.currency_code);
  const minor = (value: string | undefined) => providerAmountToMinor(value, exponent);
  const amount = minor(outcome.amount);
  if (amount !== BigInt(r.amount_minor) || (outcome.currency ?? '').toUpperCase() !== r.currency_code) {
    await review(db, r, `LivePay reports ${outcome.currency ?? '?'} ${outcome.amount ?? '?'} but we asked for ${r.currency_code} ${toDecimalString(BigInt(r.amount_minor), exponent)}.`);
    await raise(db, 'payments.provider_amount_mismatch', 'critical', r.currency_code, `LivePay amount does not match ${r.reference}. Nothing was credited; check it on the LivePay dashboard.`, { reference: r.reference });
    return [];
  }
  const actor = await systemUser(db, services, PROVIDER_ACTOR);
  const txnId = outcome.providerTxnId ? normalizeTxnId(outcome.providerTxnId) : '';
  const payoutTxnId = /^[A-Z0-9.-]{4,40}$/.test(txnId) ? txnId : r.reference;
  const charge = minor(outcome.charge) ?? 0n;
  // Money already moved at the provider: if our side refuses (account frozen, ledger short), keep the request for
  // staff instead of losing the result.
  await db.query('SAVEPOINT provider_apply');
  try {
    await db.query(
      `UPDATE provider_requests SET status = 'succeeded', completed_at = now(), provider_txn_id = $2, charge_minor = $3,
         provider_ref = coalesce($4, provider_ref), network = coalesce($5, network), message = $6 WHERE id = $1`,
      [r.id, outcome.providerTxnId ?? null, charge.toString(), outcome.providerRef ?? null, outcome.network ?? null, outcome.message?.slice(0, 500) ?? null],
    );
    let notice: Notice | null = null;
    if (r.kind === 'collect') {
      const d = await one<{ public_id: string; reference: string; status: string }>(db, 'SELECT public_id, reference, status FROM deposits WHERE id = $1', [r.deposit_id]);
      if (d.status === 'pending') {
        await confirmDeposit(db, actor, d.public_id, amount, `Paid with LivePay, transaction ${payoutTxnId}`);
        notice = { event: 'deposit_confirmed', reference: d.reference, note: null };
      } else {
        throw conflict('deposit.not_pending', `LivePay collected the fee but deposit ${d.reference} is already ${d.status}; refund it or settle it by hand.`);
      }
    } else {
      const w = await one<{ public_id: string; reference: string; status: string }>(db, 'SELECT public_id, reference, status FROM withdrawals WHERE id = $1', [r.withdrawal_id]);
      const channel = await one<{ code: string }>(db, 'SELECT code FROM payment_channels WHERE id = $1', [r.channel_id]);
      await staffWithdrawalAction(db, w.public_id, {
        action: 'paid', staffId: actor, roles: ['finance'], channel: channel.code, payoutTxnId, note: `Paid with LivePay, transaction ${payoutTxnId}`,
      });
      notice = { event: 'withdrawal_paid', reference: w.reference, note: payoutTxnId };
    }
    if (charge > 0n) await postCharge(db, r, charge, actor);
    await db.query('RELEASE SAVEPOINT provider_apply');
    return [notice];
  } catch (err) {
    if (!(err instanceof AppError) && !(err instanceof InsufficientFundsError)) throw err;
    await db.query('ROLLBACK TO SAVEPOINT provider_apply');
    await review(db, r, `LivePay reports success, but it could not be recorded: ${err.message}`);
    await raise(db, 'payments.provider_unrecorded', 'critical', r.currency_code, `LivePay moved money for ${r.reference} but the ledger could not record it: ${err.message}`.slice(0, 500), { reference: r.reference });
    return [];
  }
}

// The provider's charge leaves the LivePay account: platform revenue -> the channel's cash. TODO(owner): whether
// members pay it instead.
// If platform revenue cannot cover it, the payment still stands and staff are told to record the charge.
async function postCharge(db: PoolClient, r: RequestRow, charge: bigint, actor: number): Promise<void> {
  const revenue = await accountId(db, { kind: 'platform_revenue', currency: r.currency_code });
  const clearing = await accountId(db, { kind: 'payment_clearing', channelId: Number(r.channel_id), currency: r.currency_code });
  await db.query('SAVEPOINT provider_charge');
  try {
    await post(db, {
      kind: 'provider_charge', memo: `LivePay charge on ${r.reference}`, refType: 'provider_request', refId: r.reference, actorUserId: actor,
      legs: move(revenue, clearing, charge),
    });
    await db.query('RELEASE SAVEPOINT provider_charge');
  } catch (err) {
    if (!(err instanceof InsufficientFundsError)) throw err;
    await db.query('ROLLBACK TO SAVEPOINT provider_charge');
    await raise(db, 'payments.provider_charge_unrecorded', 'warning', r.currency_code,
      `LivePay charged ${charge.toString()} on ${r.reference}, but platform revenue cannot cover it. Record it with a treasury entry.`, { reference: r.reference });
  }
}

// Polling job: reads the status of requests with no answer for a while (lost webhooks, timeouts, AWS handoff),
// oldest first, within the rate budget. Old call records are dropped.
export async function pollProviderRequests(services: Services): Promise<{ checked: number }> {
  if (!services.payments) return { checked: 0 };
  await services.pool.query(`DELETE FROM provider_calls WHERE at < now() - interval '1 day'`);
  const used = await callsSince(services.pool, services.payments.provider, ['collect', 'status'], '15 minutes');
  const room = Math.max(0, Math.min(10, BUDGET.readsPer15Min - used));
  if (room === 0) return { checked: 0 };
  const due = await rows<{ reference: string }>(
    services.pool,
    `SELECT reference FROM provider_requests
     WHERE status IN ('queued', 'sent', 'pending') AND coalesce(last_checked_at, updated_at) < now() - $1::interval
     ORDER BY coalesce(last_checked_at, created_at) LIMIT $2`,
    [`${RECHECK_MINUTES} minutes`, room],
  );
  let checked = 0;
  for (const { reference } of due) {
    try {
      if (await checkRequest(services, reference)) checked++;
    } catch (err) {
      services.logger.error({ err, reference }, 'provider status check failed');
    }
  }
  return { checked };
}

// LivePay webhook. Outside the session, CSRF and Origin checks; the signature over the raw body is the only way in.
// It moves no money: it reads the status back from LivePay (checkRequest), which carries the amount.
export function livePayWebhook(services: Services) {
  return async (req: Request, res: Response): Promise<void> => {
    const secret = services.config.livepayWebhookSecret;
    if (!secret || !services.payments) return void res.status(404).json({ error: { code: 'not_found', message: 'Not found.' } });
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
      if (!payload || typeof payload !== 'object') throw new Error('not an object');
    } catch {
      return void res.status(400).json({ error: { code: 'webhook.body', message: 'Unreadable event.' } });
    }
    const header = req.get('x-webhook-signature') ?? '';
    if (!verifyLivePaySignature(secret, services.config.livepayWebhookUrl, header, payload, services.now())) {
      return void res.status(401).json({ error: { code: 'webhook.signature', message: 'Bad signature.' } });
    }
    const reference = scalar(payload.customer_reference).slice(0, 30);
    const id = sha256(header).toString('hex');
    const fresh = await withTransaction(services.pool, async db =>
      maybeOne(db, 'INSERT INTO provider_webhook_events (id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING id', [id]));
    if (fresh && reference) {
      try {
        await checkRequest(services, reference, { force: true });
      } catch (err) {
        // The polling job reads it again; LivePay must still get its 200 within 10 seconds.
        services.logger.error({ err, reference }, 'status read after a LivePay webhook failed');
      }
    }
    res.json({ ok: true });
  };
}
