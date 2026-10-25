import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../../http/validate.js';
import type { Services } from '../../services.js';
import { requireActivated, requireAuth } from '../auth/middleware.js';
import { idempotent } from '../ledger/idempotency.js';
import { completeTask, getLeaderboard, listSubmissions, listTasks } from './service.js';

const CompleteSchema = z.strictObject({
  answer: z.string().trim().max(500).optional(),
});

export function tasksRouter(services: Services): Router {
  const router = Router();
  router.use(requireAuth, requireActivated(services));

  router.get('/', async (req, res) => {
    const module = typeof req.query.module === 'string' ? req.query.module : undefined;
    const tasks = await listTasks(services.pool, req.auth!.userId, module);
    res.json({ tasks });
  });

  router.get('/submissions', async (req, res) => {
    const module = typeof req.query.module === 'string' ? req.query.module : undefined;
    const submissions = await listSubmissions(services.pool, req.auth!.userId, module);
    res.json({ submissions });
  });

  router.get('/leaderboard', async (_req, res) => {
    const leaderboard = await getLeaderboard(services.pool);
    res.json({ leaderboard });
  });

  router.get('/:module', async (req, res, next) => {
    const { module } = req.params;
    if (['submissions', 'leaderboard'].includes(module)) return next();
    const tasks = await listTasks(services.pool, req.auth!.userId, module);
    res.json({ tasks });
  });

  router.post('/:id/complete', async (req, res) => {
    const taskId = parse(z.coerce.number().int().positive(), req.params.id);
    const input = parse(CompleteSchema, req.body);
    const result = await idempotent(services.pool, req, `task.complete.${taskId}`, async db => ({
      status: 200, body: { ok: true, ...(await completeTask(db, req.auth!.userId, taskId, input.answer)) },
    }));
    res.status(result.status).json(result.body);
  });

  return router;
}
