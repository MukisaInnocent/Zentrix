import { Router } from 'express';
import { z } from 'zod';
import { rows } from '../../db/sql.js';
import { withTransaction } from '../../db/tx.js';
import { parse } from '../../http/validate.js';
import { notFound } from '../../lib/errors.js';
import type { Services } from '../../services.js';
import { audit } from '../audit/audit.js';
import { requireStaff } from '../auth/middleware.js';
import { sendEmail } from '../email/send.js';
import {
  currentContent, fill, isTemplateKind, sampleValues, saveContent, templateCatalogue, validateContent, type TemplateKind,
} from '../email/templates.js';

// Staff console: the wording of the automatic emails (owner, 2026-10-29). Admins change it, preview it with sample
// values, send themselves a test and go back to the built-in wording. Every change is a new version, audited.

const Address = z.string().trim().toLowerCase().max(254).pipe(z.email({ error: 'Enter a valid email address.' }));
const SaveBody = z.strictObject({ content: z.unknown(), note: z.string().trim().min(3).max(300) });
const RestoreBody = z.strictObject({ note: z.string().trim().min(3).max(300) });
const PreviewBody = z.strictObject({ content: z.unknown() });
const TestBody = z.strictObject({ content: z.unknown(), to: Address });

function kindOf(value: unknown): TemplateKind {
  if (typeof value !== 'string' || !isTemplateKind(value)) throw notFound('template.unknown', 'There is no such email.');
  return value;
}

export function emailTemplatesAdminRouter(services: Services): Router {
  const { pool } = services;
  const router = Router();

  router.get('/', requireStaff('admin', 'support'), async (_req, res) => {
    const current = new Map((await rows<{ kind: string; version: number; content: unknown; created_at: Date; username: string }>(
      pool,
      `SELECT t.kind, t.version, t.content, t.created_at, u.username FROM current_email_templates t JOIN users u ON u.id = t.created_by`,
      [],
    )).map(r => [r.kind, r]));
    res.json({
      templates: templateCatalogue().map(t => {
        const c = current.get(t.kind);
        return { ...t, content: (c?.content as object | null) ?? t.defaults, custom: Boolean(c?.content), version: c?.version ?? 0, updatedAt: c?.created_at ?? null, updatedBy: c?.username ?? null };
      }),
    });
  });

  router.get('/:kind/history', requireStaff('admin', 'support'), async (req, res) => {
    const kind = kindOf(req.params.kind);
    res.json({
      history: await rows(
        pool,
        `SELECT t.version, t.content, t.note, t.created_at, u.username FROM email_templates t JOIN users u ON u.id = t.created_by
         WHERE t.kind = $1 ORDER BY t.version DESC LIMIT 50`,
        [kind],
      ),
    });
  });

  // The email filled with sample values, as members would read it (also checks the wording).
  router.post('/:kind/preview', requireStaff('admin'), (req, res) => {
    const kind = kindOf(req.params.kind);
    const content = validateContent(kind, parse(PreviewBody, req.body).content);
    res.json({ preview: fill(kind, content, sampleValues(kind)) });
  });

  router.put('/:kind', requireStaff('admin'), async (req, res) => {
    const kind = kindOf(req.params.kind);
    const body = parse(SaveBody, req.body);
    const content = validateContent(kind, body.content);
    const version = await withTransaction(pool, async db => {
      const before = await currentContent(db, kind);
      const v = await saveContent(db, kind, content, req.auth!.userId, body.note);
      await audit(db, req, { action: 'email_template.changed', targetType: 'email_template', targetId: kind, before: before.content, after: content, reason: body.note });
      return v;
    });
    res.json({ version });
  });

  router.post('/:kind/restore', requireStaff('admin'), async (req, res) => {
    const kind = kindOf(req.params.kind);
    const { note } = parse(RestoreBody, req.body);
    const version = await withTransaction(pool, async db => {
      const before = await currentContent(db, kind);
      const v = await saveContent(db, kind, null, req.auth!.userId, note);
      await audit(db, req, { action: 'email_template.restored', targetType: 'email_template', targetId: kind, before: before.content, reason: note });
      return v;
    });
    res.json({ version });
  });

  router.post('/:kind/test', requireStaff('admin'), async (req, res) => {
    const kind = kindOf(req.params.kind);
    const body = parse(TestBody, req.body);
    const filled = fill(kind, validateContent(kind, body.content), sampleValues(kind));
    const outcome = await sendEmail(services, {
      to: body.to, kind: 'template_test', category: 'account', subject: `[Test] ${filled.subject}`, heading: filled.heading, paragraphs: filled.paragraphs,
      ...(filled.buttonLabel ? { button: { label: filled.buttonLabel, url: services.config.publicOrigin } } : {}),
      ...(filled.note ? { note: filled.note } : {}),
    });
    await withTransaction(pool, db => audit(db, req, { action: 'email_template.test_sent', targetType: 'email_template', targetId: kind, after: { to: body.to, outcome } }));
    res.json({ outcome });
  });

  return router;
}
