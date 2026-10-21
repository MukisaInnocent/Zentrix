import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../../http/validate.js';
import type { Services } from '../../services.js';
import { requireAuth } from '../auth/middleware.js';
import { distributeReferralRewards, getReferralOverview } from './service.js';

export function referralsRouter(services: Services): Router {
  const router = Router();
  router.use(requireAuth);

  const handleOverview = async (req: any, res: any) => {
    const userId = req.auth!.userId;
    const overview = await getReferralOverview(services.pool, userId);
    const host = req.get('host') || 'localhost:3000';
    const proto = req.protocol || 'http';
    const referralLink = `${proto}://${host}/register.html?ref=${overview.stats.referralCode}`;
    res.json({
      ...overview,
      referralLink,
    });
  };

  router.get('/', handleOverview);
  router.get('/overview', handleOverview);

  // Test helper: distribute rewards for a specific user ID or self
  router.post('/simulate', async (req, res) => {
    const input = parse(
      z.strictObject({
        userId: z.coerce.number().int().positive().optional(),
      }),
      req.body,
    );
    const targetUserId = input.userId ?? req.auth!.userId;
    const result = await distributeReferralRewards(services.pool, targetUserId);
    res.json({ ok: true, result });
  });

  return router;
}
