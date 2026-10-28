import { Router } from 'express';
import { z } from 'zod';
import { maybeOne, rows } from '../../db/sql.js';
import { withTransaction } from '../../db/tx.js';
import { parse } from '../../http/validate.js';
import { notFound } from '../../lib/errors.js';
import type { Services } from '../../services.js';
import { audit } from '../audit/audit.js';
import { requireStaff } from '../auth/middleware.js';
import { sendEmail } from '../email/send.js';

// Staff view of the email system (owner, 2026-10-28): every email sent with its delivery status, the addresses
// that get no more mail, and a test email. Removing a suppression and sending a test email are audited.

const STATUSES = ['queued', 'sent', 'delayed', 'delivered', 'bounced', 'complained', 'failed', 'skipped', 'suppressed'] as const;
const ListQuery = z.object({
  status: z.enum(STATUSES).optional(),
  q: z.string().trim().max(100).optional(),
});
const Address = z.string().trim().toLowerCase().max(254).pipe(z.email({ error: 'Enter a valid email address.' }));
const RemoveBody = z.strictObject({ email: Address, reason: z.string().trim().min(3).max(300) });
const TestBody = z.strictObject({ to: Address });

export function emailsAdminRouter(services: Services): Router {
  const { pool } = services;
  const router = Router();

  router.get('/', requireStaff('support'), async (req, res) => {
    const query = parse(ListQuery, req.query);
    const like = query.q ? `%${query.q.replace(/[\\%_]/g, c => `\\${c}`)}%` : null;
    const [messages, summary] = await Promise.all([
      rows(
        pool,
        `SELECT e.id, e.recipient, e.kind, e.category, e.subject, e.status, e.detail, e.created_at, e.updated_at, u.username
         FROM email_messages e LEFT JOIN users u ON u.id = e.user_id
         WHERE ($1::text IS NULL OR e.status = $1)
           AND ($2::text IS NULL OR e.recipient ILIKE $2 OR e.kind ILIKE $2 OR e.subject ILIKE $2 OR u.username ILIKE $2)
         ORDER BY e.created_at DESC LIMIT 200`,
        [query.status ?? null, like],
      ),
      rows<{ status: string; n: string }>(pool, `SELECT status, count(*)::text AS n FROM email_messages WHERE created_at > now() - interval '7 days' GROUP BY status`, []),
    ]);
    res.json({ messages, last7Days: Object.fromEntries(summary.map(s => [s.status, Number(s.n)])) });
  });

  router.get('/suppressions', requireStaff('support'), async (_req, res) => {
    res.json({ suppressions: await rows(pool, 'SELECT email, reason, detail, created_at FROM email_suppressions ORDER BY created_at DESC LIMIT 500', []) });
  });

  // For example after a member fixed their mailbox. Their next email goes out again.
  router.post('/suppressions/remove', requireStaff('admin'), async (req, res) => {
    const body = parse(RemoveBody, req.body);
    await withTransaction(pool, async db => {
      const row = await maybeOne<{ reason: string; detail: string | null }>(db, 'DELETE FROM email_suppressions WHERE email = $1 RETURNING reason, detail', [body.email]);
      if (!row) throw notFound('email.not_suppressed', 'That address is not on the list.');
      await audit(db, req, { action: 'email.suppression_removed', targetType: 'email', targetId: body.email, before: row, reason: body.reason });
    });
    res.json({ ok: true });
  });

  router.post('/test', requireStaff('admin'), async (req, res) => {
    const body = parse(TestBody, req.body);
    const outcome = await sendEmail(services, {
      to: body.to, kind: 'staff_test', category: 'account', subject: 'Pexerearn test email', heading: 'This is a test email',
      paragraphs: ['A member of the Pexerearn staff sent this email to check that email delivery works.', 'There is nothing you need to do.'],
      button: { label: 'Open Pexerearn', url: services.config.publicOrigin },
    });
    await withTransaction(pool, db => audit(db, req, { action: 'email.test_sent', targetType: 'email', targetId: body.to, after: { outcome } }));
    res.json({ outcome });
  });

  return router;
}
