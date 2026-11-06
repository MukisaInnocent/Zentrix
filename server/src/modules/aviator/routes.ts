import { Router, type Request } from 'express';
import { z } from 'zod';
import { withTransaction } from '../../db/tx.js';
import { limiter } from '../../http/rate-limit.js';
import { parse } from '../../http/validate.js';
import { notFound } from '../../lib/errors.js';
import type { Services } from '../../services.js';
import { audit } from '../audit/audit.js';
import { requireActivated, requireAuth, requireStaff } from '../auth/middleware.js';
import { balance, cashout, gameState, history, listRequests, placeBet, processRequest, requestCredits, transactions } from './service.js';

// Aviator (owner's project, 2026-11-06). The same endpoints as the project's /api/game and /api/wallet, under
// /api/aviator, for signed-in activated members; the project's admin approvals are in the staff console.
const Amount = z.strictObject({ amount: z.union([z.string(), z.number()]) });
const BetId = z.strictObject({ bet_id: z.union([z.string(), z.number()]) });
const Action = z.strictObject({ action: z.enum(['approve', 'reject']) });
const Id = z.uuid();

export function aviatorRouter(services: Services): Router {
  const { pool } = services;
  const router = Router();
  router.use(requireAuth, requireActivated(services));
  const me = (req: Request) => req.auth!.userId;
  const byUser = (req: Request) => `u${req.auth!.userId}`;

  router.get('/game/state', async (req, res) => {
    res.json(await gameState(pool, pool, me(req), services.now()));
  });
  router.get('/game/history', async (_req, res) => {
    res.json(await history(pool));
  });
  router.post('/game/bet', limiter(pool, { name: 'aviator-bet', windowMs: 60_000, limit: 30, key: byUser }), async (req, res) => {
    const { amount } = parse(Amount, req.body);
    res.json(await withTransaction(pool, db => placeBet(db, me(req), amount, services.now())));
  });
  router.post('/game/cashout', async (req, res) => {
    const { bet_id } = parse(BetId, req.body);
    const result = await withTransaction(pool, db => cashout(db, me(req), bet_id, services.now()));
    if (result.crashed) return void res.status(409).json({ error: { code: 'aviator.crashed', message: 'The round crashed before cashout' }, status: 'crashed' });
    const { crashed: _c, ...body } = result;
    res.json(body);
  });

  router.get('/wallet/balance', async (req, res) => {
    res.json(await withTransaction(pool, db => balance(db, me(req))));
  });
  for (const [path, kind] of [['deposit', 'deposit'], ['withdraw', 'withdrawal']] as const) {
    router.post(`/wallet/${path}`, limiter(pool, { name: `aviator-${path}`, windowMs: 60 * 60_000, limit: 20, key: byUser }), async (req, res) => {
      const { amount } = parse(Amount, req.body);
      res.status(201).json(await withTransaction(pool, db => requestCredits(db, me(req), kind, amount)));
    });
  }
  router.get('/wallet/transactions', async (req, res) => {
    res.json(await transactions(pool, me(req)));
  });
  return router;
}

// Staff console: approve or reject members' demo-credit requests (the project's admin deposits and withdrawals).
export function aviatorAdminRouter(services: Services): Router {
  const { pool } = services;
  const router = Router();
  router.get('/requests', requireStaff('admin', 'support', 'finance'), async (_req, res) => {
    res.json({ requests: await listRequests(pool) });
  });
  router.post('/requests/:id/process', requireStaff('admin', 'finance'), async (req, res) => {
    const id = Id.safeParse(req.params.id);
    if (!id.success) throw notFound();
    const { action } = parse(Action, req.body);
    const result = await withTransaction(pool, async db => {
      const done = await processRequest(db, req.auth!.userId, id.data, action);
      await audit(db, req, { action: `aviator.request_${done.status}`, targetType: 'aviator_request', targetId: id.data, after: done });
      return done;
    });
    res.json({ message: `Request ${result.status} successfully`, request: result });
  });
  return router;
}
