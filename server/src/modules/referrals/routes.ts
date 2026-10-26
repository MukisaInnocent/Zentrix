import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { parse } from '../../http/validate.js';
import type { Services } from '../../services.js';
import { requireActivated, requireAuth } from '../auth/middleware.js';
import { getReferralOverview, listReferralMembers, referralLeaders } from './service.js';

const LeaderboardQuery = z.object({ period: z.enum(['all', '30d', '7d']).default('all') });
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

  // The member leaderboard (rule 3.3 as changed by the owner): usernames, countries and invite counts only.
  router.get('/leaderboard', async (req, res) => {
    const { period } = parse(LeaderboardQuery, req.query);
    const all = await referralLeaders(services.pool, period, 1000);
    const view = (l: (typeof all)[number]) => ({ rank: l.rank, username: l.username, country: l.country, activated: l.activated, invited: l.invited });
    const mine = all.find(l => l.userId === req.auth!.userId);
    res.json({ period, leaders: all.slice(0, 20).map(view), me: mine ? view(mine) : null });
  });

  return router;
}
