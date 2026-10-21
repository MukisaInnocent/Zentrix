import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../../http/validate.js';
import type { Services } from '../../services.js';
import { requireAuth } from '../auth/middleware.js';
import { completeTask, getLeaderboard, listSubmissions, listTasks } from './service.js';

const CompleteSchema = z.strictObject({
  answer: z.string().trim().max(500).optional(),
});

export function tasksRouter(services: Services): Router {
  const router = Router();
  router.use(requireAuth);

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
    const taskId = Number(req.params.id);
    const input = parse(CompleteSchema, req.body);
    const result = await completeTask(services.pool, req.auth!.userId, taskId, input.answer);
    res.json({ ok: true, ...result });
  });

  return router;
}
