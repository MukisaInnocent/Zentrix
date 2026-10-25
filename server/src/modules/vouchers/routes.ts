import { Router } from 'express';
import { z } from 'zod';
import { maybeOne, one, rows } from '../../db/sql.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { parse } from '../../http/validate.js';
import { randomCode } from '../../lib/crypto.js';
import type { Services } from '../../services.js';
import { requireActivated, requireAuth } from '../auth/middleware.js';
import { idempotent } from '../ledger/idempotency.js';
import { accountId, balanceOf, InsufficientFundsError, move, post } from '../ledger/ledger.js';
import { AmountInput, amountToMinor } from '../payments/routes.js';
import { memberInfo, newReference, requireActive } from '../wallet/service.js';

// Vouchers: the buyer's main balance moves to voucher_liability; redeeming moves it to the redeemer's main
// balance. Full Phase 4 vouchers (expiry, encrypted codes) are still to come.
export function vouchersRouter(services: Services): Router {
  const { pool } = services;
  const router = Router();
  router.use(requireAuth, requireActivated(services));

  router.get('/', async (req, res) => {
    const list = await rows<{ id: string; code: string; amount_minor: string; currency_code: string; status: string; created_at: Date }>(
      pool,
      'SELECT id, code, amount_minor, currency_code, status, created_at FROM vouchers WHERE creator_user_id = $1 ORDER BY created_at DESC',
      [req.auth!.userId],
    );
    res.json({ vouchers: list.map(v => ({ id: v.id, code: v.code, amountMinor: v.amount_minor, currency: v.currency_code, status: v.status, createdAt: v.created_at })) });
  });

  router.post('/buy', async (req, res) => {
    const input = parse(z.strictObject({ amount: AmountInput, quantity: z.coerce.number().int().min(1).max(10).default(1) }), req.body);
    const result = await idempotent(pool, req, 'voucher.buy', async db => {
      const userId = req.auth!.userId;
      const member = await memberInfo(db, userId);
      requireActive(member);
      const each = await amountToMinor(db, member.currency, input.amount);
      const main = await accountId(db, { kind: 'member_main', userId, currency: member.currency });
      const liability = await accountId(db, { kind: 'voucher_liability', currency: member.currency });
      let txn: number;
      try {
        txn = await post(db, { kind: 'voucher_purchase', memo: `Bought ${input.quantity} voucher(s)`, refType: 'voucher', actorUserId: userId, legs: move(main, liability, each * BigInt(input.quantity)) });
      } catch (err) {
        if (err instanceof InsufficientFundsError) throw badRequest('insufficient_funds', 'Your main balance is too low for these vouchers.');
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
      return { status: 201, body: { ok: true, vouchers, balance: (await balanceOf(db, main)).toString() } };
    });
    res.status(result.status).json(result.body);
  });

  router.post('/redeem', async (req, res) => {
    const input = parse(z.strictObject({ code: z.string().trim().toUpperCase().max(25) }), req.body);
    const result = await idempotent(pool, req, 'voucher.redeem', async db => {
      const userId = req.auth!.userId;
      const member = await memberInfo(db, userId);
      requireActive(member);
      const voucher = await maybeOne<{ id: string; code: string; amount_minor: string; currency_code: string; status: string }>(
        db, 'SELECT id, code, amount_minor, currency_code, status FROM vouchers WHERE code = $1 FOR UPDATE', [input.code],
      );
      if (!voucher) throw notFound('voucher.not_found', 'Voucher code not found.');
      if (voucher.status !== 'active') throw badRequest('voucher.already_used', 'This voucher has already been redeemed or cancelled.');
      if (voucher.currency_code !== member.currency) throw badRequest('voucher.currency', 'This voucher is in another currency.');
      const liability = await accountId(db, { kind: 'voucher_liability', currency: member.currency });
      const main = await accountId(db, { kind: 'member_main', userId, currency: member.currency });
      await post(db, { kind: 'voucher_redeem', memo: `Redeemed voucher ${voucher.code}`, refType: 'voucher', refId: voucher.code, actorUserId: userId, legs: move(liability, main, BigInt(voucher.amount_minor)) });
      await db.query(`UPDATE vouchers SET status = 'redeemed', redeemed_by_user_id = $1, redeemed_at = now() WHERE id = $2`, [userId, voucher.id]);
      return { status: 200, body: { ok: true, amount: voucher.amount_minor, currency: voucher.currency_code, balance: (await balanceOf(db, main)).toString() } };
    });
    res.status(result.status).json(result.body);
  });

  return router;
}

// Pay For Client: a wallet-to-wallet payment to another verified member (by username or phone), same currency.
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
        recipient: z.string().trim().min(3, { error: 'Enter the member\'s username or phone number.' }).max(40),
        amount: AmountInput,
        note: z.string().trim().max(200).optional(),
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
         WHERE anonymized_at IS NULL AND (username = $1 OR phone_e164 = $2)`,
        [handle, input.recipient.replace(/\s+/g, '')],
      );
      const fail = () => badRequest('validation_failed', 'No verified member matches that username or phone.', { recipient: ['No verified member matches.'] });
      if (!payee || payee.status !== 'active' || !payee.phone_ok) throw fail();
      if (Number(payee.id) === userId) throw badRequest('validation_failed', 'You cannot pay yourself.', { recipient: ['You cannot pay yourself.'] });
      if (payee.currency_code !== payer.currency) throw conflict('transfer.currency', 'That member uses another currency. Currency conversion is not available yet.');
      const amount = await amountToMinor(db, payer.currency, input.amount);
      const from = await accountId(db, { kind: 'member_main', userId, currency: payer.currency });
      const to = await accountId(db, { kind: 'member_main', userId: Number(payee.id), currency: payer.currency });
      const reference = newReference('PT');
      let txn: number;
      try {
        txn = await post(db, { kind: 'member_transfer', memo: `Payment to @${payee.username}`, refType: 'transfer', refId: reference, actorUserId: userId, legs: move(from, to, amount) });
      } catch (err) {
        if (err instanceof InsufficientFundsError) throw badRequest('insufficient_funds', 'Your main balance is too low for this payment.');
        throw err;
      }
      await one(
        db,
        `INSERT INTO member_transfers (reference, payer_user_id, payee_user_id, amount_minor, currency_code, note, ledger_transaction_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [reference, userId, payee.id, amount.toString(), payer.currency, input.note ?? null, txn],
      );
      return { status: 201, body: { ok: true, reference, payee: payee.username, balance: (await balanceOf(db, from)).toString() } };
    });
    res.status(result.status).json(result.body);
  });

  return router;
}
