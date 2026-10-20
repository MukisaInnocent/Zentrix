import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../../http/validate.js';
import { notFound } from '../../lib/errors.js';
import type { Services } from '../../services.js';
import { requireAuth } from '../auth/middleware.js';
import { validTimezone } from '../auth/register.js';
import { loadProfile } from './profile.js';

// Members may change only presentation preferences. Username, email, phone and country are locked
// (sections 1 and 10); the phone field shows "Contact admin to change your phone number".
const PatchMeSchema = z.strictObject({
  timezone: z.string().trim().max(64).refine(validTimezone, { error: 'Choose a valid time zone.' }).optional(),
  locale: z.string().trim().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/, { error: 'Choose a valid language.' }).optional(),
});

export function meRouter(services: Services): Router {
  const router = Router();
  router.use(requireAuth);

  router.get('/', async (req, res) => {
    const profile = await loadProfile(services.pool, req.auth!.userId);
    if (!profile) throw notFound();
    res.json({ user: profile, session: { mfaVerified: req.auth!.mfaVerified } });
  });

  router.patch('/', async (req, res) => {
    const input = parse(PatchMeSchema, req.body);
    await services.pool.query('UPDATE users SET timezone = coalesce($2, timezone), locale = coalesce($3, locale) WHERE id = $1', [
      req.auth!.userId, input.timezone ?? null, input.locale ?? null,
    ]);
    res.json({ user: await loadProfile(services.pool, req.auth!.userId) });
  });

  return router;
}
