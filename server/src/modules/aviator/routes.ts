import { Router, type Request } from 'express';
import { z } from 'zod';
import { withTransaction } from '../../db/tx.js';
import { limiter } from '../../http/rate-limit.js';
import { parse } from '../../http/validate.js';
import { notFound } from '../../lib/errors.js';
import type { Services } from '../../services.js';
import { requireActivated, requireAuth } from '../auth/middleware.js';
import { aviatorState, cashOut, roundStatus, startRound } from './service.js';

// Aviator with free game points (owner, 2026-11-06). See service.ts.
const StakeBody = z.strictObject({ stake: z.coerce.number().int() });
const Id = z.uuid();
const roundId = (value: unknown) => {
  const id = Id.safeParse(value);
  if (!id.success) throw notFound();
  return id.data;
};

export function aviatorRouter(services: Services): Router {
  const { pool } = services;
  const router = Router();
  router.use(requireAuth, requireActivated(services));
  const me = (req: Request) => req.auth!.userId;
  const byUser = (req: Request) => `u${req.auth!.userId}`;

  router.get('/', async (req, res) => {
    res.json(await withTransaction(pool, db => aviatorState(db, me(req))));
  });
  router.post('/rounds', limiter(pool, { name: 'aviator-start', windowMs: 60_000, limit: 30, key: byUser }), async (req, res) => {
    const { stake } = parse(StakeBody, req.body);
    res.status(201).json(await withTransaction(pool, db => startRound(db, me(req), stake)));
  });
  router.get('/rounds/:id', async (req, res) => {
    res.json(await withTransaction(pool, db => roundStatus(db, me(req), roundId(req.params.id))));
  });
  router.post('/rounds/:id/cashout', async (req, res) => {
    res.json(await withTransaction(pool, db => cashOut(db, me(req), roundId(req.params.id))));
  });
  return router;
}
