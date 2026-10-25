import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../../http/validate.js';
import type { Services } from '../../services.js';
import { requireAuth } from '../auth/middleware.js';
import { getTransactions, getWalletSummary } from './service.js';

const ListQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) });

// Balances and the statement come from the ledger. The activation payment and withdrawals live under
// /api/payments, and a member's account is activated when staff confirm the activation payment.
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

  return router;
}
