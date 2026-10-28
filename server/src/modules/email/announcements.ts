import { z } from 'zod';
import type { Db } from '../../db/sql.js';
import { maybeOne, one, rows } from '../../db/sql.js';
import type { Services } from '../../services.js';
import { getSetting } from '../settings/registry.js';
import { sendEmail, type SendOutcome } from './send.js';

// Announcements: messages an admin writes to members (owner, 2026-10-29). The recipients are fixed when the admin
// presses Send. They are emailed in portions that fit the email provider's allowance while keeping part of each
// day free for the emails members need (setting email.allowance); the `announcements` job sends the rest on the
// following days. Members who turned announcements off are skipped, as are blocked and test addresses.

export const AUDIENCES = ['all', 'activated', 'not_activated'] as const;
export type Audience = (typeof AUDIENCES)[number];

export const AnnouncementSchema = z.strictObject({
  subject: z.string().trim().min(3).max(150),
  heading: z.string().trim().min(1).max(150),
  body: z.string().trim().min(1).max(5000),
  buttonLabel: z.string().trim().min(1).max(40).optional(),
  buttonUrl: z.url({ protocol: /^https$/, error: 'Use a full link starting with https://.' }).max(500).optional(),
  audience: z.enum(AUDIENCES),
  country: z.string().regex(/^[A-Z]{2}$/).nullable().optional(),
}).refine(a => !a.buttonLabel === !a.buttonUrl, { error: 'Give the button both a label and a link, or neither.', path: ['buttonUrl'] });
export type AnnouncementInput = z.output<typeof AnnouncementSchema>;

// Members only: no staff or system accounts, no closed or anonymized accounts, an email address on file.
const AUDIENCE_SQL = `
  u.anonymized_at IS NULL AND u.status = 'active' AND u.email IS NOT NULL
  AND EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role = 'member')
  AND NOT EXISTS (SELECT 1 FROM user_roles r JOIN roles ro ON ro.name = r.role WHERE r.user_id = u.id AND ro.is_staff)
  AND ($1::text = 'all' OR ($1::text = 'activated') = EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id))
  AND ($2::text IS NULL OR u.country_code = $2::text)`;

export async function countAudience(db: Db, audience: Audience, country: string | null): Promise<number> {
  return Number((await one<{ n: string }>(db, `SELECT count(*) AS n FROM users u WHERE ${AUDIENCE_SQL}`, [audience, country])).n);
}

export async function createAnnouncement(db: Db, actorUserId: number, input: AnnouncementInput): Promise<{ id: number; publicId: string; recipients: number }> {
  const a = await one<{ id: string; public_id: string }>(
    db,
    `INSERT INTO announcements (subject, heading, body, button_label, button_url, audience, country_code, recipients, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8) RETURNING id, public_id`,
    [input.subject, input.heading, input.body, input.buttonLabel ?? null, input.buttonUrl ?? null, input.audience, input.country ?? null, actorUserId],
  );
  const added = await rows<{ user_id: string }>(
    db,
    `INSERT INTO announcement_recipients (announcement_id, user_id)
     SELECT $3, u.id FROM users u WHERE ${AUDIENCE_SQL} RETURNING user_id`,
    [input.audience, input.country ?? null, a.id],
  );
  // Nobody to email: it is finished at once.
  await db.query(
    `UPDATE announcements SET recipients = $2, status = CASE WHEN $2 = 0 THEN 'done' ELSE status END, finished_at = CASE WHEN $2 = 0 THEN now() END WHERE id = $1`,
    [a.id, added.length],
  );
  return { id: Number(a.id), publicId: a.public_id, recipients: added.length };
}

// How many more announcement emails fit today: the allowance minus everything already sent today (and this
// month), keeping the reserved part free for members' own emails.
export async function announcementBudget(db: Db): Promise<{ budget: number; usedToday: number; usedThisMonth: number; allowance: { daily: number; monthly: number; reserved: number } }> {
  const allowance = await getSetting(db, 'email.allowance');
  const used = await one<{ today: string; month: string }>(
    db,
    `SELECT count(*) FILTER (WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS today,
            count(*) AS month
     FROM email_messages WHERE created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
       AND status NOT IN ('skipped', 'suppressed')`,
    [],
  );
  const usedToday = Number(used.today);
  const usedThisMonth = Number(used.month);
  const budget = Math.max(0, Math.min(allowance.daily - allowance.reserved - usedToday, allowance.monthly - allowance.reserved - usedThisMonth));
  return { budget, usedToday, usedThisMonth, allowance };
}

export interface AnnouncementContent {
  subject: string;
  heading: string;
  body: string;
  buttonLabel?: string | null;
  buttonUrl?: string | null;
}

// The email itself. A blank line in the body starts a new paragraph.
export const announcementEmail = (a: AnnouncementContent) => ({
  subject: a.subject.replace(/\s+/g, ' ').trim(),
  heading: a.heading,
  paragraphs: a.body.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean),
  ...(a.buttonLabel && a.buttonUrl ? { button: { label: a.buttonLabel, url: a.buttonUrl } } : {}),
});

const SENT: SendOutcome[] = ['sent', 'queued', 'duplicate'];

// Sends waiting announcement emails, at most `max` and never more than today's budget. One sender at a time
// (advisory lock), so a recipient is never emailed twice. Returns how many went out.
export async function sendAnnouncementPortion(services: Services, max: number): Promise<number> {
  const lock = await services.pool.connect();
  try {
    const { rows: got } = await lock.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock(hashtext('zentrix-announcements')) AS ok`);
    if (!got[0]?.ok) return 0;
    try {
      let left = Math.min(max, (await announcementBudget(services.pool)).budget);
      let sent = 0;
      while (left > 0) {
        const batch = await rows<{ announcement_id: string; user_id: string; email: string; subject: string; heading: string; body: string; button_label: string | null; button_url: string | null }>(
          services.pool,
          `SELECT r.announcement_id, r.user_id, u.email, a.subject, a.heading, a.body, a.button_label, a.button_url
           FROM announcement_recipients r JOIN announcements a ON a.id = r.announcement_id JOIN users u ON u.id = r.user_id
           WHERE r.status = 'waiting' AND a.status = 'sending' ORDER BY r.announcement_id, r.user_id LIMIT $1`,
          [Math.min(left, 50)],
        );
        if (batch.length === 0) break;
        for (const r of batch) {
          const outcome = r.email
            ? await sendEmail(services, {
              to: r.email, userId: Number(r.user_id), kind: 'announcement', category: 'announcement', ref: `ann:${r.announcement_id}:${r.user_id}`,
              ...announcementEmail({ subject: r.subject, heading: r.heading, body: r.body, buttonLabel: r.button_label, buttonUrl: r.button_url }),
            })
            : 'skipped';
          const delivered = SENT.includes(outcome);
          await services.pool.query(
            `UPDATE announcement_recipients SET status = $3, outcome = $4, sent_at = now() WHERE announcement_id = $1 AND user_id = $2`,
            [r.announcement_id, r.user_id, delivered ? 'sent' : 'skipped', outcome],
          );
          // Only emails that really went out use the allowance.
          if (outcome === 'sent' || outcome === 'queued') {
            sent++;
            left--;
            if (left === 0) break;
          }
        }
      }
      await services.pool.query(
        `UPDATE announcements a SET status = 'done', finished_at = now()
         WHERE a.status = 'sending' AND NOT EXISTS (SELECT 1 FROM announcement_recipients r WHERE r.announcement_id = a.id AND r.status = 'waiting')`,
      );
      return sent;
    } finally {
      await lock.query(`SELECT pg_advisory_unlock(hashtext('zentrix-announcements'))`);
    }
  } finally {
    lock.release();
  }
}

export async function listAnnouncements(db: Db) {
  const list = await rows<{
    public_id: string; subject: string; heading: string; body: string; button_label: string | null; button_url: string | null;
    audience: Audience; country_code: string | null; status: string; recipients: number; created_at: Date; finished_at: Date | null;
    created_by: string; sent: string; skipped: string; waiting: string; delivered: string; bounced: string;
  }>(
    db,
    `SELECT a.public_id, a.subject, a.heading, a.body, a.button_label, a.button_url, a.audience, a.country_code, a.status, a.recipients,
            a.created_at, a.finished_at, s.username AS created_by,
            count(*) FILTER (WHERE r.status = 'sent') AS sent, count(*) FILTER (WHERE r.status = 'skipped') AS skipped,
            count(*) FILTER (WHERE r.status = 'waiting') AS waiting,
            (SELECT count(*) FROM email_messages e WHERE e.kind = 'announcement' AND e.ref LIKE 'ann:' || a.id || ':%' AND e.status = 'delivered') AS delivered,
            (SELECT count(*) FROM email_messages e WHERE e.kind = 'announcement' AND e.ref LIKE 'ann:' || a.id || ':%' AND e.status IN ('bounced', 'complained', 'failed')) AS bounced
     FROM announcements a JOIN users s ON s.id = a.created_by LEFT JOIN announcement_recipients r ON r.announcement_id = a.id
     GROUP BY a.id, s.username ORDER BY a.created_at DESC LIMIT 100`,
    [],
  );
  return list.map(a => ({
    id: a.public_id, subject: a.subject, heading: a.heading, body: a.body, buttonLabel: a.button_label, buttonUrl: a.button_url,
    audience: a.audience, country: a.country_code, status: a.status, recipients: a.recipients, createdAt: a.created_at, finishedAt: a.finished_at,
    createdBy: a.created_by, sent: Number(a.sent), skipped: Number(a.skipped), waiting: Number(a.waiting), delivered: Number(a.delivered), bounced: Number(a.bounced),
  }));
}

export async function cancelAnnouncement(db: Db, publicId: string): Promise<{ waiting: number } | null> {
  const a = await maybeOne<{ id: string }>(db, `UPDATE announcements SET status = 'cancelled', finished_at = now() WHERE public_id = $1 AND status = 'sending' RETURNING id`, [publicId]);
  if (!a) return null;
  const w = await one<{ n: string }>(db, `SELECT count(*) AS n FROM announcement_recipients WHERE announcement_id = $1 AND status = 'waiting'`, [a.id]);
  return { waiting: Number(w.n) };
}
