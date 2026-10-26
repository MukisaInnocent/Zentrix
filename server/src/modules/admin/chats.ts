import { Router } from 'express';
import { z } from 'zod';
import { maybeOne, rows } from '../../db/sql.js';
import { withTransaction } from '../../db/tx.js';
import { parse } from '../../http/validate.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import type { Services } from '../../services.js';
import { audit } from '../audit/audit.js';
import { requireStaff } from '../auth/middleware.js';
import { messagesOf } from '../chat/service.js';

// Reported member chats. Staff read a conversation only through a report, and every read is audited.
const ListQuery = z.object({ status: z.enum(['open', 'closed', 'all']).default('open') });
const CloseBody = z.strictObject({ note: z.string().trim().min(3, { error: 'Say what was done.' }).max(500) });
const Uuid = z.uuid();
const VIEW = ['support', 'compliance'] as const;

function reportId(value: unknown): string {
  const id = Uuid.safeParse(value);
  if (!id.success) throw badRequest('validation_failed', 'Unknown report.');
  return id.data;
}

const REPORT_SELECT = `
  SELECT r.id, r.public_id, r.conversation_id, r.reason, r.status, r.closing_note, r.closed_at, r.created_at, c.kind,
         rep.username AS reporter, a.username AS user_a, a.country_code AS country_a, b.username AS user_b, b.country_code AS country_b,
         s.username AS closed_by
  FROM chat_reports r
  JOIN chat_conversations c ON c.id = r.conversation_id
  JOIN users rep ON rep.id = r.reporter_user_id
  JOIN users a ON a.id = c.user_a_id
  JOIN users b ON b.id = c.user_b_id
  LEFT JOIN users s ON s.id = r.closed_by`;

interface ReportRow {
  id: string; public_id: string; conversation_id: string; reason: string; status: string; closing_note: string | null; closed_at: Date | null;
  created_at: Date; kind: string; reporter: string; user_a: string; country_a: string; user_b: string; country_b: string; closed_by: string | null;
}

const reportView = (r: ReportRow) => ({
  id: r.public_id, reason: r.reason, status: r.status, kind: r.kind, reporter: r.reporter, createdAt: r.created_at,
  members: [{ username: r.user_a, country: r.country_a }, { username: r.user_b, country: r.country_b }],
  closingNote: r.closing_note, closedAt: r.closed_at, closedBy: r.closed_by,
});

export function chatsAdminRouter(services: Services): Router {
  const { pool } = services;
  const router = Router();

  router.get('/reports', requireStaff(...VIEW), async (req, res) => {
    const { status } = parse(ListQuery, req.query);
    const list = await rows<ReportRow>(pool, `${REPORT_SELECT} WHERE ($1 = 'all' OR r.status = $1) ORDER BY r.created_at DESC LIMIT 200`, [status]);
    res.json({ reports: list.map(reportView) });
  });

  router.get('/reports/:id', requireStaff(...VIEW), async (req, res) => {
    const id = reportId(req.params.id);
    const result = await withTransaction(pool, async db => {
      const r = await maybeOne<ReportRow>(db, `${REPORT_SELECT} WHERE r.public_id = $1`, [id]);
      if (!r) throw notFound();
      await audit(db, req, { action: 'chat.report_viewed', targetType: 'chat_report', targetId: id });
      const messages = await messagesOf(db, r.conversation_id);
      return { report: reportView(r), messages: messages.map(m => ({ id: m.id, username: m.username, body: m.body, createdAt: m.created_at })) };
    });
    res.json(result);
  });

  router.post('/reports/:id/close', requireStaff(...VIEW), async (req, res) => {
    const id = reportId(req.params.id);
    const { note } = parse(CloseBody, req.body);
    await withTransaction(pool, async db => {
      const r = await maybeOne<{ status: string }>(db, 'SELECT status FROM chat_reports WHERE public_id = $1 FOR UPDATE', [id]);
      if (!r) throw notFound();
      if (r.status !== 'open') throw conflict('chat.report_closed', 'This report is already closed.');
      await db.query(`UPDATE chat_reports SET status = 'closed', closed_by = $2, closed_at = now(), closing_note = $3 WHERE public_id = $1`, [id, req.auth!.userId, note]);
      await audit(db, req, { action: 'chat.report_closed', targetType: 'chat_report', targetId: id, before: { status: 'open' }, after: { status: 'closed' }, reason: note });
    });
    res.json({ ok: true });
  });

  return router;
}
