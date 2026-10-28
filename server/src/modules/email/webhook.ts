import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { maybeOne } from '../../db/sql.js';
import { withTransaction } from '../../db/tx.js';
import type { Services } from '../../services.js';

// Delivery results from Resend (owner, 2026-10-28). Resend signs each webhook with the Svix scheme: an HMAC-SHA256
// of "<svix-id>.<svix-timestamp>.<raw body>" with the endpoint's signing secret. The route sits outside the session,
// CSRF and Origin checks (it is server to server), so the signature is the only way in; a delivery older than five
// minutes is refused, and a delivery already handled changes nothing.

const TOLERANCE_SECONDS = 300;

export function verifySignature(secret: string, id: string, timestamp: string, signatures: string, body: Buffer, now: Date): boolean {
  if (!id || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(now.getTime() / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.`).update(body).digest();
  return signatures.split(' ').some(part => {
    const [version, value] = part.split(',');
    if (version !== 'v1' || !value) return false;
    const given = Buffer.from(value, 'base64');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

const Event = z.object({
  type: z.string().max(60),
  data: z.object({
    email_id: z.string().max(100).optional(),
    to: z.array(z.string().max(254)).optional(),
    tags: z.record(z.string(), z.string()).optional(),
    bounce: z.object({ type: z.string().max(40).optional(), subType: z.string().max(40).optional(), message: z.string().optional() }).optional(),
  }).loose(),
}).loose();

const STATUS: Record<string, string> = {
  'email.sent': 'sent',
  'email.delivery_delayed': 'delayed',
  'email.delivered': 'delivered',
  'email.bounced': 'bounced',
  'email.complained': 'complained',
  'email.failed': 'failed',
  'email.suppressed': 'suppressed',
};
// A later event never moves a message back (webhooks can arrive out of order).
const ORDER = `ARRAY['queued', 'sent', 'delayed', 'delivered', 'failed', 'suppressed', 'bounced', 'complained']`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function resendWebhook(services: Services) {
  return async (req: Request, res: Response): Promise<void> => {
    const secret = services.config.resendWebhookSecret;
    if (!secret) return void res.status(404).json({ error: { code: 'not_found', message: 'Not found.' } });
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const id = req.get('svix-id') ?? '';
    if (!verifySignature(secret, id, req.get('svix-timestamp') ?? '', req.get('svix-signature') ?? '', body, services.now())) {
      return void res.status(401).json({ error: { code: 'webhook.signature', message: 'Bad signature.' } });
    }
    let event: z.infer<typeof Event>;
    try {
      event = Event.parse(JSON.parse(body.toString('utf8')));
    } catch {
      return void res.status(400).json({ error: { code: 'webhook.body', message: 'Unreadable event.' } });
    }
    const status = STATUS[event.type];
    await withTransaction(services.pool, async db => {
      const fresh = await maybeOne(db, 'INSERT INTO email_webhook_events (id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING id', [id.slice(0, 100)]);
      if (!fresh || !status) return;
      const tagged = event.data.tags?.message_id;
      const detail = event.data.bounce?.message?.slice(0, 500) ?? null;
      await db.query(
        `UPDATE email_messages SET status = $3, provider_id = coalesce($2, provider_id), detail = coalesce($4, detail), updated_at = now()
         WHERE (id = $1::uuid OR ($1::uuid IS NULL AND provider_id = $2))
           AND array_position(${ORDER}, status) <= array_position(${ORDER}, $3::text)`,
        [tagged && UUID.test(tagged) ? tagged : null, event.data.email_id ?? null, status, detail],
      );
      const permanent = status === 'complained' || status === 'suppressed' || (status === 'bounced' && event.data.bounce?.type !== 'Transient');
      if (permanent) {
        for (const to of event.data.to ?? []) {
          await db.query(
            `INSERT INTO email_suppressions (email, reason, detail) VALUES (lower($1), $2, $3) ON CONFLICT (email) DO NOTHING`,
            [to.trim(), status === 'complained' ? 'complained' : 'bounced', detail],
          );
        }
      }
    });
    res.json({ ok: true });
  };
}
