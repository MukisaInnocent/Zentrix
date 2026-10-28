import { Router } from 'express';
import { z } from 'zod';
import { withTransaction } from '../../db/tx.js';
import { parse } from '../../http/validate.js';
import { badRequest, notFound } from '../../lib/errors.js';
import type { Services } from '../../services.js';
import { audit } from '../audit/audit.js';
import { requireStaff } from '../auth/middleware.js';
import {
  announcementBudget, announcementEmail, AnnouncementSchema, AUDIENCES, cancelAnnouncement, countAudience, createAnnouncement,
  listAnnouncements, sendAnnouncementPortion,
} from '../email/announcements.js';
import { sendEmail } from '../email/send.js';

// Staff console: announcements to members (owner, 2026-10-29). One admin writes and sends; every send, test and
// cancellation is audited. The first portion goes out while the admin waits, the rest with the daily job.

const Address = z.string().trim().toLowerCase().max(254).pipe(z.email({ error: 'Enter a valid email address.' }));
const AudienceQuery = z.object({ audience: z.enum(AUDIENCES), country: z.string().regex(/^[A-Z]{2}$/).optional() });
const TestBody = z.strictObject({ to: Address, message: z.unknown() });
const Uuid = z.uuid();
// Sent while the admin waits; the rest go out with the daily job.
const FIRST_PORTION = 40;

export function announcementsAdminRouter(services: Services): Router {
  const { pool } = services;
  const router = Router();

  router.get('/', requireStaff('admin', 'support'), async (_req, res) => {
    const [announcements, budget] = await Promise.all([listAnnouncements(pool), announcementBudget(pool)]);
    res.json({ announcements, budget });
  });

  // How many members a choice of audience reaches (before sending).
  router.get('/audience', requireStaff('admin'), async (req, res) => {
    const q = parse(AudienceQuery, req.query);
    res.json({ members: await countAudience(pool, q.audience, q.country ?? null) });
  });

  router.post('/test', requireStaff('admin'), async (req, res) => {
    const body = parse(TestBody, req.body);
    const message = parse(AnnouncementSchema, body.message);
    const outcome = await sendEmail(services, { to: body.to, kind: 'announcement_test', category: 'account', ...announcementEmail(message) });
    await withTransaction(pool, db => audit(db, req, { action: 'announcement.test_sent', targetType: 'email', targetId: body.to, after: { subject: message.subject, outcome } }));
    res.json({ outcome });
  });

  router.post('/', requireStaff('admin'), async (req, res) => {
    const input = parse(AnnouncementSchema, req.body);
    const created = await withTransaction(pool, async db => {
      if ((await countAudience(db, input.audience, input.country ?? null)) === 0) {
        throw badRequest('announcement.no_recipients', 'No member matches that choice, so nothing was sent.');
      }
      const a = await createAnnouncement(db, req.auth!.userId, input);
      await audit(db, req, {
        action: 'announcement.sent', targetType: 'announcement', targetId: a.publicId,
        after: { subject: input.subject, audience: input.audience, country: input.country ?? null, recipients: a.recipients },
      });
      return a;
    });
    const sentNow = await sendAnnouncementPortion(services, FIRST_PORTION);
    res.status(201).json({ id: created.publicId, recipients: created.recipients, sentNow });
  });

  router.post('/:id/cancel', requireStaff('admin'), async (req, res) => {
    const id = Uuid.safeParse(req.params.id);
    if (!id.success) throw notFound();
    const result = await withTransaction(pool, async db => {
      const r = await cancelAnnouncement(db, id.data);
      if (!r) throw notFound('announcement.not_sending', 'That announcement has finished or was already cancelled.');
      await audit(db, req, { action: 'announcement.cancelled', targetType: 'announcement', targetId: id.data, after: { notSent: r.waiting } });
      return r;
    });
    res.json({ ok: true, notSent: result.waiting });
  });

  return router;
}
