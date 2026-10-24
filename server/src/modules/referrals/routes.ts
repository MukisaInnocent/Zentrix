import { Router, type Request, type Response } from 'express';
import type { Services } from '../../services.js';
import { requireAuth } from '../auth/middleware.js';
import { getReferralOverview } from './service.js';

export function referralsRouter(services: Services): Router {
  const router = Router();
  router.use(requireAuth);

  const handleOverview = async (req: Request, res: Response) => {
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

  return router;
}
