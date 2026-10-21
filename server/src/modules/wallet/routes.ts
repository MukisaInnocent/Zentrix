import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../../http/validate.js';
import type { Services } from '../../services.js';
import { requireAuth } from '../auth/middleware.js';
import {
  activateMembership,
  getTransactions,
  getWalletSummary,
  recordDeposit,
  requestWithdrawal,
} from './service.js';

const DepositSchema = z.strictObject({
  amount: z.coerce.number().int().positive({ error: 'Enter a valid amount.' }),
  method: z.string().trim().min(1).default('mobile_money'),
  phone: z.string().trim().optional(),
});

const WithdrawSchema = z.strictObject({
  amount: z.coerce.number().int().min(1000, { error: 'Minimum withdrawal is UGX 1,000.' }),
  method: z.string().trim().min(1).default('mobile_money'),
  destination: z.string().trim().min(3, { error: 'Enter payout phone or account number.' }),
});

export function walletRouter(services: Services): Router {
  const router = Router();
  router.use(requireAuth);

  router.get('/summary', async (req, res) => {
    const summary = await getWalletSummary(services.pool, req.auth!.userId);
    res.json(summary);
  });

  router.get('/transactions', async (req, res) => {
    const limit = Math.min(Number(req.query.limit || 50), 100);
    const transactions = await getTransactions(services.pool, req.auth!.userId, limit);
    res.json({ transactions });
  });

  router.post('/deposit', async (req, res) => {
    const input = parse(DepositSchema, req.body);
    const result = await recordDeposit(
      services.pool,
      req.auth!.userId,
      BigInt(input.amount),
      input.method,
      input.phone,
    );
    const summary = await getWalletSummary(services.pool, req.auth!.userId);
    res.status(201).json({
      ok: true,
      reference: result.reference,
      balance: result.newBalanceMinor,
      summary,
    });
  });

  router.post('/withdraw', async (req, res) => {
    const input = parse(WithdrawSchema, req.body);
    const result = await requestWithdrawal(
      services.pool,
      req.auth!.userId,
      BigInt(input.amount),
      input.method,
      input.destination,
    );
    const summary = await getWalletSummary(services.pool, req.auth!.userId);
    res.status(201).json({
      ok: true,
      reference: result.reference,
      fee: result.feeMinor,
      balance: result.newBalanceMinor,
      summary,
    });
  });

  router.post('/membership/activate', async (req, res) => {
    const result = await activateMembership(services.pool, req.auth!.userId);
    const summary = await getWalletSummary(services.pool, req.auth!.userId);
    res.json({
      ok: true,
      ...result,
      summary,
    });
  });

  router.get('/membership/status', async (req, res) => {
    const summary = await getWalletSummary(services.pool, req.auth!.userId);
    res.json({
      active: summary.membershipActive,
      activatedAt: summary.membershipActivatedAt,
      fee: '19000',
      currency: summary.currency,
    });
  });

  return router;
}
