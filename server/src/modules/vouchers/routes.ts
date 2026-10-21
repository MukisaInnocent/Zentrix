import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { maybeOne, one, rows } from '../../db/sql.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { parse } from '../../http/validate.js';
import type { Services } from '../../services.js';
import { requireAuth } from '../auth/middleware.js';

export function vouchersRouter(services: Services): Router {
  const router = Router();
  router.use(requireAuth);

  router.get('/', async (req, res) => {
    const list = await rows<{
      id: string;
      code: string;
      amount_minor: string;
      currency_code: string;
      status: string;
      created_at: Date;
    }>(
      services.pool,
      'SELECT id, code, amount_minor, currency_code, status, created_at FROM vouchers WHERE creator_user_id = $1 ORDER BY created_at DESC',
      [req.auth!.userId],
    );
    res.json({ vouchers: list.map(v => ({ id: v.id, code: v.code, amountMinor: v.amount_minor, currency: v.currency_code, status: v.status, createdAt: v.created_at })) });
  });

  router.post('/buy', async (req, res) => {
    const input = parse(
      z.strictObject({
        amount: z.coerce.number().int().positive({ error: 'Enter a valid voucher amount.' }),
        quantity: z.coerce.number().int().min(1).max(10).default(1),
      }),
      req.body,
    );

    const totalCost = BigInt(input.amount) * BigInt(input.quantity);
    const wallet = await one<{ balance_minor: string; currency_code: string }>(
      services.pool,
      'SELECT balance_minor, currency_code FROM wallets WHERE user_id = $1 FOR UPDATE',
      [req.auth!.userId],
    );

    if (BigInt(wallet.balance_minor) < totalCost) {
      throw badRequest('insufficient_funds', 'Insufficient balance to purchase voucher(s).');
    }

    const createdVouchers = [];
    for (let i = 0; i < input.quantity; i++) {
      const code = `ZX-${randomBytes(2).toString('hex').toUpperCase()}-${randomBytes(2).toString('hex').toUpperCase()}`;
      await services.pool.query(
        'INSERT INTO vouchers (code, creator_user_id, amount_minor, currency_code, status) VALUES ($1, $2, $3, $4, $5)',
        [code, req.auth!.userId, input.amount.toString(), wallet.currency_code, 'active'],
      );
      createdVouchers.push({ code, amount: input.amount.toString(), currency: wallet.currency_code });
    }

    const updated = await one<{ balance_minor: string }>(
      services.pool,
      'UPDATE wallets SET balance_minor = balance_minor - $1, updated_at = now() WHERE user_id = $2 RETURNING balance_minor',
      [totalCost.toString(), req.auth!.userId],
    );

    await services.pool.query(
      `INSERT INTO wallet_transactions (user_id, kind, amount_minor, currency_code, balance_after_minor, description)
       VALUES ($1, 'voucher_purchase', $2, $3, $4, $5)`,
      [
        req.auth!.userId,
        (-totalCost).toString(),
        wallet.currency_code,
        updated.balance_minor,
        `Purchased ${input.quantity} voucher(s) worth UGX ${input.amount}`,
      ],
    );

    res.status(201).json({ ok: true, vouchers: createdVouchers, balance: updated.balance_minor });
  });

  router.post('/redeem', async (req, res) => {
    const input = parse(
      z.strictObject({
        code: z.string().trim().toUpperCase(),
      }),
      req.body,
    );

    const voucher = await maybeOne<{
      id: string;
      code: string;
      amount_minor: string;
      currency_code: string;
      status: string;
    }>(services.pool, 'SELECT id, code, amount_minor, currency_code, status FROM vouchers WHERE code = $1 FOR UPDATE', [input.code]);

    if (!voucher) throw notFound('voucher.not_found', 'Voucher code not found.');
    if (voucher.status !== 'active') throw badRequest('voucher.already_used', 'This voucher has already been redeemed or cancelled.');

    await services.pool.query(
      `UPDATE vouchers SET status = 'redeemed', redeemed_by_user_id = $1, redeemed_at = now() WHERE id = $2`,
      [req.auth!.userId, voucher.id],
    );

    const updated = await one<{ balance_minor: string }>(
      services.pool,
      'UPDATE wallets SET balance_minor = balance_minor + $1, updated_at = now() WHERE user_id = $2 RETURNING balance_minor',
      [voucher.amount_minor, req.auth!.userId],
    );

    await services.pool.query(
      `INSERT INTO wallet_transactions (user_id, kind, amount_minor, currency_code, balance_after_minor, description, reference)
       VALUES ($1, 'voucher_redeem', $2, $3, $4, $5, $6)`,
      [
        req.auth!.userId,
        voucher.amount_minor,
        voucher.currency_code,
        updated.balance_minor,
        `Redeemed voucher ${voucher.code}`,
        voucher.code,
      ],
    );

    res.json({ ok: true, amount: voucher.amount_minor, currency: voucher.currency_code, balance: updated.balance_minor });
  });

  return router;
}

export function clientPaymentsRouter(services: Services): Router {
  const router = Router();
  router.use(requireAuth);

  router.get('/', async (req, res) => {
    const list = await rows<{
      id: string;
      client_name: string;
      client_phone: string;
      amount_minor: string;
      currency_code: string;
      status: string;
      reference: string;
      created_at: Date;
    }>(
      services.pool,
      'SELECT id, client_name, client_phone, amount_minor, currency_code, status, reference, created_at FROM client_payments WHERE payer_user_id = $1 ORDER BY created_at DESC',
      [req.auth!.userId],
    );
    res.json({
      payments: list.map(p => ({
        id: p.id,
        clientName: p.client_name,
        clientPhone: p.client_phone,
        amountMinor: p.amount_minor,
        currency: p.currency_code,
        status: p.status,
        reference: p.reference,
        createdAt: p.created_at,
      })),
    });
  });

  router.post('/', async (req, res) => {
    const input = parse(
      z.strictObject({
        clientName: z.string().trim().min(2, { error: 'Client name is required.' }),
        clientPhone: z.string().trim().min(4, { error: 'Client phone is required.' }),
        amount: z.coerce.number().int().positive({ error: 'Enter a valid amount.' }),
        note: z.string().trim().max(500).optional(),
      }),
      req.body,
    );

    const cost = BigInt(input.amount);
    const wallet = await one<{ balance_minor: string; currency_code: string }>(
      services.pool,
      'SELECT balance_minor, currency_code FROM wallets WHERE user_id = $1 FOR UPDATE',
      [req.auth!.userId],
    );

    if (BigInt(wallet.balance_minor) < cost) {
      throw badRequest('insufficient_funds', 'Insufficient funds for client payment.');
    }

    const ref = `PFC-${randomBytes(4).toString('hex').toUpperCase()}`;
    await services.pool.query(
      `INSERT INTO client_payments (payer_user_id, client_name, client_phone, amount_minor, currency_code, note, status, reference)
       VALUES ($1, $2, $3, $4, $5, $6, 'completed', $7)`,
      [req.auth!.userId, input.clientName, input.clientPhone, cost.toString(), wallet.currency_code, input.note ?? null, ref],
    );

    const updated = await one<{ balance_minor: string }>(
      services.pool,
      'UPDATE wallets SET balance_minor = balance_minor - $1, updated_at = now() WHERE user_id = $2 RETURNING balance_minor',
      [cost.toString(), req.auth!.userId],
    );

    await services.pool.query(
      `INSERT INTO wallet_transactions (user_id, kind, amount_minor, currency_code, balance_after_minor, description, reference)
       VALUES ($1, 'client_payment', $2, $3, $4, $5, $6)`,
      [
        req.auth!.userId,
        (-cost).toString(),
        wallet.currency_code,
        updated.balance_minor,
        `Pay For Client: ${input.clientName} (${input.clientPhone})`,
        ref,
      ],
    );

    res.status(201).json({ ok: true, reference: ref, balance: updated.balance_minor });
  });

  return router;
}
