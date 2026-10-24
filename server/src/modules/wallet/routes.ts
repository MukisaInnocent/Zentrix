import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../../http/validate.js';
import type { Services } from '../../services.js';
import { requireAuth } from '../auth/middleware.js';
import { idempotent } from '../ledger/idempotency.js';
import { activateMembership, getTransactions, getWalletSummary } from './service.js';

const ListQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) });

// Balances and the statement come from the ledger. Deposits and withdrawals live under /api/payments.
export function walletRouter(services: Services): Router {
  const { pool } = services;
  const router = Router();
  router.use(requireAuth);

  router.get('/summary', async (req, res) => {
    res.json(await getWalletSummary(pool, req.auth!.userId));
  });

  router.get('/transactions', async (req, res) => {
    const { limit } = parse(ListQuery, req.query);
    res.json({ transactions: await getTransactions(pool, req.auth!.userId, limit) });
  });

  router.post('/membership/activate', async (req, res) => {
    const result = await idempotent(pool, req, 'membership.activate', async db => {
      const r = await activateMembership(db, req.auth!.userId);
      return { status: 200, body: { ok: true, ...r, activatedAt: r.activatedAt.toISOString() } };
    });
    res.status(result.status).json({ ...result.body, summary: await getWalletSummary(pool, req.auth!.userId) });
  });

  router.get('/membership/status', async (req, res) => {
    const summary = await getWalletSummary(pool, req.auth!.userId);
    res.json({ active: summary.membershipActive, activatedAt: summary.membershipActivatedAt, fee: summary.membershipFeeMinor, currency: summary.currency });
  });

  return router;
}
