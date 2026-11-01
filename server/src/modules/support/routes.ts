import { Router, type Request } from 'express';
import { z } from 'zod';
import { maybeOne } from '../../db/sql.js';
import { limiter } from '../../http/rate-limit.js';
import { parse } from '../../http/validate.js';
import { badRequest, serviceUnavailable } from '../../lib/errors.js';
import type { Services } from '../../services.js';
import { sendTemplated } from '../email/templates.js';
import { getSetting } from '../settings/registry.js';

const HOUR = 3_600_000;

// The Contact page form (owner, 2026-11-01). Anyone may send it, signed in or not; the message is emailed to the
// support address an admin sets in Settings, with the sender's email as reply-to. A visitor who is not signed in
// gives an email address for the answer. Rate-limited per IP and per account against spam.
const MessageBody = z.strictObject({
  email: z.email({ error: 'Enter your email address so we can answer you.' }).max(254).optional(),
  subject: z.string().trim().min(3, { error: 'Write a short subject.' }).max(120),
  message: z.string().trim().min(10, { error: 'Describe your question in a sentence or two.' }).max(2000),
});

export function supportRouter(services: Services): Router {
  const { pool } = services;
  const router = Router();
  const byUserOrIp = (req: Request) => (req.auth ? `u${req.auth.userId}` : `ip${req.ip ?? ''}`);

  router.post('/messages', limiter(pool, { name: 'support-message', windowMs: HOUR, limit: 5, key: byUserOrIp }), async (req, res) => {
    const input = parse(MessageBody, req.body);
    const member = req.auth
      ? await maybeOne<{ username: string; email: string | null }>(pool, 'SELECT username, email FROM users WHERE id = $1', [req.auth.userId])
      : null;
    const replyTo = member?.email ?? input.email;
    if (!replyTo) throw badRequest('validation_failed', 'Enter your email address so we can answer you.', { email: ['Enter your email address so we can answer you.'] });
    const support = await getSetting(pool, 'support.contact');
    const outcome = await sendTemplated(services, {
      kind: 'support_message', to: support.email, userId: null, replyTo,
      values: { from: member ? `@${member.username}` : 'a visitor', email: replyTo, subject: input.subject, message: input.message },
    });
    if (outcome === 'failed') throw serviceUnavailable('support.send_failed', 'Your message could not be sent right now. Please try again, or email us directly.');
    res.status(202).json({ ok: true });
  });

  return router;
}
