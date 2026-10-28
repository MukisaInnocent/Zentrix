import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../../http/validate.js';
import { notFound } from '../../lib/errors.js';
import type { Services } from '../../services.js';
import { hashKey, limiter } from '../../http/rate-limit.js';
import { changeEmail, changePhone, openGrants } from '../auth/changes.js';
import { requireAuth } from '../auth/middleware.js';
import { validTimezone } from '../auth/register.js';
import { emailPreferences } from '../email/send.js';
import { loadProfile } from './profile.js';

// Members change presentation preferences freely. Username and country are locked. Password, email and phone change
// only after an admin unlocks them (see auth/changes.ts).
const EmailPreferencesSchema = z.strictObject({ referralRewards: z.boolean(), signInAlerts: z.boolean(), announcements: z.boolean().optional() });

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

  // Which of password, email and phone an admin has unlocked for this member, and until when.
  router.get('/changes', async (req, res) => {
    const grants = await openGrants(services.pool, req.auth!.userId);
    res.json({ unlocked: Object.fromEntries(grants.map(g => [g.kind, g.expiresAt])) });
  });

  const changeLimit = limiter(services.pool, { name: 'account-change', windowMs: 3_600_000, limit: 10, key: req => hashKey(`u${req.auth?.userId ?? 0}`) });

  router.post('/email', changeLimit, async (req, res) => {
    await changeEmail(services, req, req.auth!, req.body);
    res.json({ ok: true });
  });

  router.post('/phone', changeLimit, async (req, res) => {
    const result = await changePhone(services, req, req.auth!, req.body);
    res.json({ ok: true, ...result });
  });

  // Optional emails (owner, 2026-10-28). Security and payment emails always go.
  router.get('/email-preferences', async (req, res) => {
    const p = await emailPreferences(services, req.auth!.userId);
    res.json({ preferences: { referralRewards: p.referral_rewards, signInAlerts: p.sign_in_alerts, announcements: p.announcements } });
  });

  router.put('/email-preferences', async (req, res) => {
    const input = parse(EmailPreferencesSchema, req.body);
    await services.pool.query(
      `INSERT INTO email_preferences (user_id, referral_rewards, sign_in_alerts, announcements) VALUES ($1, $2, $3, coalesce($4, true))
       ON CONFLICT (user_id) DO UPDATE SET referral_rewards = $2, sign_in_alerts = $3, announcements = coalesce($4, email_preferences.announcements), updated_at = now()`,
      [req.auth!.userId, input.referralRewards, input.signInAlerts, input.announcements ?? null],
    );
    const p = await emailPreferences(services, req.auth!.userId);
    res.json({ preferences: { referralRewards: p.referral_rewards, signInAlerts: p.sign_in_alerts, announcements: p.announcements } });
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
