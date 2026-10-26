import { Router } from 'express';
import { z } from 'zod';
import { maybeOne, one, rows, type Db } from '../../db/sql.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { parse } from '../../http/validate.js';
import { randomCode } from '../../lib/crypto.js';
import { toDecimalString } from '../../lib/money.js';
import type { Services } from '../../services.js';
import { requireActivated, requireAuth } from '../auth/middleware.js';
import { idempotent } from '../ledger/idempotency.js';
import { accountId, InsufficientFundsError, move, post } from '../ledger/ledger.js';
import { notifyVoucherActivation } from '../notifications/notify.js';
import { exponentOf } from '../payments/common.js';
import { AmountInput, amountToMinor } from '../payments/routes.js';
import { distributeReferralRewards } from '../referrals/service.js';
import { getSetting } from '../settings/registry.js';
import { memberInfo, newReference, requireActive, requireConfig, spendLegs } from '../wallet/service.js';

// Vouchers are bought from the member's own money (deposit balance first, then balance -> voucher_liability) and
// used to activate another member's account. A voucher is worth at least the activation fee. On use the fee goes
// voucher_liability -> platform revenue, any value above the fee goes to the activated member's deposit balance,
// and referral rewards are paid as for a confirmed activation payment. Full Phase 4 vouchers (expiry, encrypted
// codes) are still to come. The value choices are multiples of the fee set by an admin (`voucher.value_multiples`).

async function activationFee(db: Db, countryCode: string): Promise<bigint> {
  return BigInt((await requireConfig(db, countryCode)).membershipFeeMinor);
}

export function vouchersRouter(services: Services): Router {
  const { pool } = services;
  const router = Router();
  router.use(requireAuth, requireActivated(services));

  router.get('/', async (req, res) => {
    const member = await memberInfo(pool, req.auth!.userId);
    const fee = await activationFee(pool, member.countryCode);
    const exponent = await exponentOf(pool, member.currency);
    const list = await rows<{ code: string; amount_minor: string; currency_code: string; status: string; created_at: Date; used_by: string | null; used_at: Date | null }>(
      pool,
      `SELECT v.code, v.amount_minor, v.currency_code, v.status, v.created_at, r.username AS used_by, v.redeemed_at AS used_at
       FROM vouchers v LEFT JOIN users r ON r.id = v.redeemed_by_user_id WHERE v.creator_user_id = $1 ORDER BY v.created_at DESC`,
      [req.auth!.userId],
    );
    res.json({
      currency: member.currency,
      activationFeeMinor: fee.toString(),
      valueOptions: (await getSetting(pool, 'voucher.value_multiples')).map(BigInt).map(m => ({ amount: toDecimalString(fee * m, exponent), amountMinor: (fee * m).toString() })),
      vouchers: list.map(v => ({
        code: v.code, amountMinor: v.amount_minor, currency: v.currency_code, status: v.status === 'redeemed' ? 'used' : v.status,
        createdAt: v.created_at, usedBy: v.used_by, usedAt: v.used_at,
      })),
    });
  });

  router.post('/buy', async (req, res) => {
    const input = parse(z.strictObject({ amount: AmountInput, quantity: z.coerce.number().int().min(1).max(10).default(1) }), req.body);
    const result = await idempotent(pool, req, 'voucher.buy', async db => {
      const userId = req.auth!.userId;
      const member = await memberInfo(db, userId);
      requireActive(member);
      const each = await amountToMinor(db, member.currency, input.amount);
      if (each < (await activationFee(db, member.countryCode))) {
        throw badRequest('validation_failed', 'A voucher must be worth at least the activation fee.', { amount: ['Must be at least the activation fee.'] });
      }
      const liability = await accountId(db, { kind: 'voucher_liability', currency: member.currency });
      const legs = await spendLegs(db, userId, member.currency, each * BigInt(input.quantity), liability);
      let txn: number;
      try {
        txn = await post(db, { kind: 'voucher_purchase', memo: `Bought ${input.quantity} voucher(s)`, refType: 'voucher', actorUserId: userId, legs });
      } catch (err) {
        if (err instanceof InsufficientFundsError) throw badRequest('insufficient_funds', 'Your deposit and balance together are too low for these vouchers.');
        throw err;
      }
      const vouchers = [];
      for (let i = 0; i < input.quantity; i++) {
        const code = `ZX-${randomCode(4)}-${randomCode(4)}-${randomCode(4)}`;
        await db.query(
          `INSERT INTO vouchers (code, creator_user_id, amount_minor, currency_code, status, ledger_transaction_id) VALUES ($1, $2, $3, $4, 'active', $5)`,
          [code, userId, each.toString(), member.currency, txn],
        );
        vouchers.push({ code, amountMinor: each.toString(), currency: member.currency });
      }
      return { status: 201, body: { ok: true, vouchers } };
    });
    res.status(result.status).json(result.body);
  });

  // Activates a member who has not paid yet, using one of the buyer's own unused vouchers.
  router.post('/activate', async (req, res) => {
    const input = parse(
      z.strictObject({
        code: z.string().trim().toUpperCase().min(1, { error: 'Choose a voucher.' }).max(25),
        username: z.string().trim().min(3, { error: 'Enter the username of the account to activate.' }).max(40),
      }),
      req.body,
    );
    const result = await idempotent(pool, req, 'voucher.activate', async db => {
      const userId = req.auth!.userId;
      requireActive(await memberInfo(db, userId));
      const voucher = await maybeOne<{ id: string; code: string; creator_user_id: string; amount_minor: string; currency_code: string; status: string }>(
        db, 'SELECT id, code, creator_user_id, amount_minor, currency_code, status FROM vouchers WHERE code = $1 FOR UPDATE', [input.code],
      );
      if (!voucher || Number(voucher.creator_user_id) !== userId) throw notFound('voucher.not_found', 'You have no voucher with that code.');
      if (voucher.status !== 'active') throw badRequest('voucher.already_used', 'This voucher has already been used or cancelled.');
      const handle = input.username.toLowerCase().replace(/^@/, '');
      const target = await maybeOne<{ id: string; username: string; status: string; currency_code: string; country_code: string }>(
        db, 'SELECT id, username, status, currency_code, country_code FROM users WHERE anonymized_at IS NULL AND username = $1 FOR UPDATE', [handle],
      );
      if (!target) throw badRequest('validation_failed', 'No member has that username.', { username: ['No member has that username.'] });
      const targetId = Number(target.id);
      if (await maybeOne(db, 'SELECT 1 FROM memberships WHERE user_id = $1', [targetId])) {
        throw badRequest('validation_failed', 'That account is already activated.', { username: ['That account is already activated.'] });
      }
      if (target.status !== 'active') throw conflict('voucher.member_not_active', 'That account is on hold, so it cannot be activated now.');
      if (target.currency_code !== voucher.currency_code) throw conflict('voucher.currency', 'That member uses another currency, so this voucher cannot activate their account.');
      const fee = await activationFee(db, target.country_code);
      const value = BigInt(voucher.amount_minor);
      if (value < fee) throw badRequest('voucher.too_small', 'This voucher is worth less than the activation fee for that account.');

      const liability = await accountId(db, { kind: 'voucher_liability', currency: voucher.currency_code });
      const revenue = await accountId(db, { kind: 'platform_revenue', currency: voucher.currency_code });
      const legs = move(liability, revenue, fee);
      if (value > fee) legs.push(...move(liability, await accountId(db, { kind: 'member_deposit', userId: targetId, currency: voucher.currency_code }), value - fee));
      const receiptNo = newReference('MB');
      const txn = await post(db, {
        kind: 'voucher_activation', memo: `Activation of @${target.username} with voucher ${voucher.code}`, refType: 'membership', refId: receiptNo, actorUserId: userId, legs,
      });
      await db.query(
        'INSERT INTO memberships (user_id, receipt_no, fee_minor, currency_code, ledger_transaction_id) VALUES ($1, $2, $3, $4, $5)',
        [targetId, receiptNo, fee.toString(), voucher.currency_code, txn],
      );
      await db.query(`UPDATE vouchers SET status = 'redeemed', redeemed_by_user_id = $1, redeemed_at = now() WHERE id = $2`, [targetId, voucher.id]);
      // Referral rewards for the people who invited the activated member, exactly as for a confirmed payment.
      await distributeReferralRewards(db, targetId);
      return { status: 200, body: { ok: true, username: target.username, code: voucher.code, receiptNo } };
    });
    if (!result.replayed) void notifyVoucherActivation(services, String(result.body.username), String(result.body.code));
    res.status(result.status).json(result.body);
  });

  return router;
}

// Pay For Client: a wallet-to-wallet payment to another verified member, found by username only, same currency.
export function clientPaymentsRouter(services: Services): Router {
  const { pool } = services;
  const router = Router();
  router.use(requireAuth, requireActivated(services));

  router.get('/', async (req, res) => {
    const list = await rows<{ reference: string; amount_minor: string; currency_code: string; note: string | null; created_at: Date; payer: string; payee: string; outgoing: boolean }>(
      pool,
      `SELECT t.reference, t.amount_minor, t.currency_code, t.note, t.created_at, p.username AS payer, q.username AS payee, t.payer_user_id = $1 AS outgoing
       FROM member_transfers t JOIN users p ON p.id = t.payer_user_id JOIN users q ON q.id = t.payee_user_id
       WHERE t.payer_user_id = $1 OR t.payee_user_id = $1 ORDER BY t.id DESC LIMIT 50`,
      [req.auth!.userId],
    );
    res.json({
      payments: list.map(p => ({
        reference: p.reference, amountMinor: p.amount_minor, currency: p.currency_code, note: p.note, createdAt: p.created_at,
        direction: p.outgoing ? 'out' : 'in', counterparty: p.outgoing ? p.payee : p.payer, status: 'completed',
      })),
    });
  });

  router.post('/', async (req, res) => {
    const input = parse(
      z.strictObject({
        recipient: z.string().trim().min(3, { error: 'Enter the member\'s username.' }).max(40),
        amount: AmountInput,
      }),
      req.body,
    );
    const result = await idempotent(pool, req, 'transfer.send', async db => {
      const userId = req.auth!.userId;
      const payer = await memberInfo(db, userId);
      requireActive(payer);
      const handle = input.recipient.toLowerCase().replace(/^@/, '');
      const payee = await maybeOne<{ id: string; username: string; currency_code: string; status: string; phone_ok: boolean }>(
        db,
        `SELECT id, username, currency_code, status, phone_verified_at IS NOT NULL AS phone_ok FROM users
         WHERE anonymized_at IS NULL AND username = $1`,
        [handle],
      );
      const fail = () => badRequest('validation_failed', 'No verified member has that username.', { recipient: ['No verified member has that username.'] });
      if (!payee || payee.status !== 'active' || !payee.phone_ok) throw fail();
      if (Number(payee.id) === userId) throw badRequest('validation_failed', 'You cannot pay yourself.', { recipient: ['You cannot pay yourself.'] });
      if (payee.currency_code !== payer.currency) throw conflict('transfer.currency', 'That member uses another currency. Currency conversion is not available yet.');
      const amount = await amountToMinor(db, payer.currency, input.amount);
      // Paid from the payer's deposit balance first, then their balance; received into the payee's deposit
      // balance, since a member's balance holds referral money only.
      const to = await accountId(db, { kind: 'member_deposit', userId: Number(payee.id), currency: payer.currency });
      const legs = await spendLegs(db, userId, payer.currency, amount, to);
      const reference = newReference('PT');
      let txn: number;
      try {
        txn = await post(db, { kind: 'member_transfer', memo: `Payment to @${payee.username}`, refType: 'transfer', refId: reference, actorUserId: userId, legs });
      } catch (err) {
        if (err instanceof InsufficientFundsError) throw badRequest('insufficient_funds', 'Your deposit and balance together are too low for this payment.');
        throw err;
      }
      await one(
        db,
        `INSERT INTO member_transfers (reference, payer_user_id, payee_user_id, amount_minor, currency_code, note, ledger_transaction_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [reference, userId, payee.id, amount.toString(), payer.currency, null, txn],
      );
      return { status: 201, body: { ok: true, reference, payee: payee.username } };
    });
    res.status(result.status).json(result.body);
  });

  return router;
}
