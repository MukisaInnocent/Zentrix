import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { parse } from '../../http/validate.js';
import type { Services } from '../../services.js';
import { requireActivated, requireAuth } from '../auth/middleware.js';
import { getReferralOverview, listReferralMembers } from './service.js';

const MembersQuery = z.object({
  level: z.coerce.number().int().min(1).max(3).default(1),
  status: z.enum(['all', 'active', 'inactive']).default('all'),
});

export function referralsRouter(services: Services): Router {
  const router = Router();
  router.use(requireAuth, requireActivated(services));

  // The invite link carries the username of the member who invites (owner, 2026-10-25).
  const linkFor = (req: Request, username: string) => `${req.protocol}://${req.get('host') ?? 'localhost:3000'}/register.html?ref=${encodeURIComponent(username)}`;

  const handleOverview = async (req: Request, res: Response) => {
    const overview = await getReferralOverview(services.pool, req.auth!.userId);
    res.json({ ...overview, referralLink: linkFor(req, overview.username) });
  };

  router.get('/', handleOverview);
  router.get('/overview', handleOverview);

  router.get('/members', async (req, res) => {
    const { level, status } = parse(MembersQuery, req.query);
    const [overview, members] = await Promise.all([
      getReferralOverview(services.pool, req.auth!.userId),
      listReferralMembers(services.pool, req.auth!.userId, level, status),
    ]);
    res.json({ level, status, counts: overview.levels[level as 1 | 2 | 3], members });
  });

  return router;
}
