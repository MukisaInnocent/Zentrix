import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../../db/sql.js';
import { maybeOne, one, rows } from '../../db/sql.js';
import { withTransaction } from '../../db/tx.js';
import { parse } from '../../http/validate.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { MoneyFormatError, toDecimalString, toMinor } from '../../lib/money.js';
import type { Services } from '../../services.js';
import { audit } from '../audit/audit.js';
import { requireStaff } from '../auth/middleware.js';
import { safeLink } from '../videos/routes.js';

// Tasks in the staff console (owner, 2026-11-03): admins add, edit, hide and show the tasks on the member YouTube,
// TikTok, Ads and Trivia pages. A completed task still pays from the promotions budget into the member's task balance
// (completeTask), which cannot be withdrawn yet. Links are https and never to adult content. Every change is audited.

const MODULES = ['youtube', 'tiktok', 'ads', 'trivia'] as const;

interface TaskRow {
  id: string; public_id: string; module: string; title: string; description: string; reward_minor: string; currency_code: string;
  exponent: number; url: string | null; duration_sec: number | null; details: { options?: string[]; answer?: string }; is_active: boolean;
  created_at: Date; completions: string;
}

const SELECT = `SELECT t.id, t.public_id, t.module, t.title, t.description, t.reward_minor, t.currency_code, c.exponent, t.url, t.duration_sec,
                       t.details, t.is_active, t.created_at,
                       (SELECT count(*) FROM task_submissions s WHERE s.task_id = t.id AND s.status = 'approved') AS completions
                FROM tasks t JOIN currencies c ON c.code = t.currency_code`;

const view = (t: TaskRow) => ({
  id: t.public_id, module: t.module, title: t.title, description: t.description, rewardMinor: t.reward_minor,
  reward: toDecimalString(BigInt(t.reward_minor), t.exponent), currency: t.currency_code, linkUrl: t.url, durationSec: t.duration_sec,
  options: t.details.options ?? [], answer: t.details.answer ?? null, active: t.is_active, createdAt: t.created_at, completions: Number(t.completions),
});

const TaskBody = z.strictObject({
  module: z.enum(MODULES),
  title: z.string().trim().min(2).max(120),
  description: z.string().trim().min(2, { error: 'Describe the task. For trivia, this is the question.' }).max(600),
  reward: z.string().trim().min(1).max(24),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
  linkUrl: z.string().trim().max(500).nullable().optional(),
  durationSec: z.int().min(5).max(3600).nullable().optional(),
  options: z.array(z.string().trim().min(1).max(120)).max(6).default([]),
  answer: z.string().trim().max(120).nullable().optional(),
  active: z.boolean().default(true),
});
type TaskInput = z.infer<typeof TaskBody>;
const Id = z.uuid();

function taskId(value: unknown): string {
  const id = Id.safeParse(value);
  if (!id.success) throw notFound();
  return id.data;
}

const field = (name: string, message: string) => badRequest('validation_failed', message, { [name]: [message] });

// Checks the input and turns it into the row's columns.
async function columns(db: Db, body: TaskInput) {
  const currency = await maybeOne<{ exponent: number }>(db, 'SELECT exponent FROM currencies WHERE code = $1', [body.currency]);
  if (!currency) throw field('currency', 'Unknown currency.');
  let rewardMinor: bigint;
  try {
    rewardMinor = toMinor(body.reward, currency.exponent);
  } catch (err) {
    if (err instanceof MoneyFormatError) throw field('reward', err.message);
    throw err;
  }
  if (rewardMinor <= 0n) throw field('reward', 'The reward must be more than zero.');
  const url = body.linkUrl ? safeLink(body.linkUrl) : null;
  if (!url && (body.module === 'youtube' || body.module === 'tiktok')) throw field('linkUrl', 'Add the link to the video.');

  let details: { options?: string[]; answer?: string } = {};
  if (body.module === 'trivia') {
    const options = [...new Set(body.options)];
    if (options.length < 2) throw field('options', 'Give at least two different answers to choose from.');
    const answer = body.answer?.trim();
    if (!answer || !options.some(o => o.toLowerCase() === answer.toLowerCase())) throw field('answer', 'The correct answer must be one of the choices.');
    details = { options, answer };
  }
  return { rewardMinor: rewardMinor.toString(), url, details, duration: body.module === 'trivia' ? null : body.durationSec ?? null };
}

async function lockTask(db: Db, id: string): Promise<TaskRow> {
  const row = await maybeOne<{ id: string }>(db, 'SELECT id FROM tasks WHERE public_id = $1 FOR UPDATE', [id]);
  if (!row) throw notFound();
  return one<TaskRow>(db, `${SELECT} WHERE t.id = $1`, [row.id]);
}

export function tasksAdminRouter(services: Services): Router {
  const { pool } = services;
  const router = Router();

  router.get('/', requireStaff('admin', 'support'), async (req, res) => {
    const asked = typeof req.query.module === 'string' ? req.query.module : '';
    const module = (MODULES as readonly string[]).includes(asked) ? asked : null;
    const list = await rows<TaskRow>(pool, `${SELECT} WHERE t.module = ANY($1) AND ($2::text IS NULL OR t.module = $2) ORDER BY t.module, t.id DESC`, [MODULES, module]);
    res.json({ tasks: list.map(view) });
  });

  router.post('/', requireStaff('admin'), async (req, res) => {
    const body = parse(TaskBody, req.body);
    const task = await withTransaction(pool, async db => {
      const c = await columns(db, body);
      const { id } = await one<{ id: string }>(
        db,
        `INSERT INTO tasks (module, title, description, reward_minor, currency_code, url, duration_sec, details, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [body.module, body.title, body.description, c.rewardMinor, body.currency, c.url, c.duration, JSON.stringify(c.details), body.active],
      );
      const after = view(await one<TaskRow>(db, `${SELECT} WHERE t.id = $1`, [id]));
      await audit(db, req, { action: 'task.created', targetType: 'task', targetId: after.id, after });
      return after;
    });
    res.status(201).json({ task });
  });

  router.put('/:id', requireStaff('admin'), async (req, res) => {
    const id = taskId(req.params.id);
    const body = parse(TaskBody, req.body);
    const task = await withTransaction(pool, async db => {
      const before = await lockTask(db, id);
      if (before.module !== body.module) throw field('module', 'A task cannot move to another page. Add a new task instead.');
      const c = await columns(db, body);
      await db.query(
        `UPDATE tasks SET title = $2, description = $3, reward_minor = $4, currency_code = $5, url = $6, duration_sec = $7, details = $8, is_active = $9
         WHERE id = $1`,
        [before.id, body.title, body.description, c.rewardMinor, body.currency, c.url, c.duration, JSON.stringify(c.details), body.active],
      );
      const after = view(await one<TaskRow>(db, `${SELECT} WHERE t.id = $1`, [before.id]));
      await audit(db, req, { action: 'task.updated', targetType: 'task', targetId: id, before: view(before), after });
      return after;
    });
    res.json({ task });
  });

  // Hiding stops members seeing and completing the task; completed tasks keep their record.
  for (const action of ['hide', 'show'] as const) {
    router.post(`/:id/${action}`, requireStaff('admin'), async (req, res) => {
      const id = taskId(req.params.id);
      const task = await withTransaction(pool, async db => {
        const before = await lockTask(db, id);
        await db.query('UPDATE tasks SET is_active = $2 WHERE id = $1', [before.id, action === 'show']);
        const after = view(await one<TaskRow>(db, `${SELECT} WHERE t.id = $1`, [before.id]));
        await audit(db, req, { action: `task.${action === 'hide' ? 'hidden' : 'shown'}`, targetType: 'task', targetId: id, before: view(before), after });
        return after;
      });
      res.json({ task });
    });
  }

  return router;
}
