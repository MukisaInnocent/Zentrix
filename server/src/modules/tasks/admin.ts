import { Router } from 'express';
import { z } from 'zod';
import type { PoolClient } from '../../db/pool.js';
import type { Db } from '../../db/sql.js';
import { maybeOne, one, rows } from '../../db/sql.js';
import { withTransaction } from '../../db/tx.js';
import { parse } from '../../http/validate.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { MoneyFormatError, toDecimalString, toMinor } from '../../lib/money.js';
import { videoEmbed } from '../../lib/safe-links.js';
import type { Services } from '../../services.js';
import { audit } from '../audit/audit.js';
import { requireStaff } from '../auth/middleware.js';
import { idempotent } from '../ledger/idempotency.js';
import { accountId, InsufficientFundsError, move, post } from '../ledger/ledger.js';
import { safeLink } from '../videos/routes.js';

// Tasks in the staff console (owner, 2026-11-03): admins add, edit, hide and show the tasks on the member YouTube,
// TikTok, Ads and Trivia pages. Links are https and never to adult content; YouTube and TikTok tasks link one video,
// which plays on the member's page (owner, 2026-11-05). Every change is audited.
// Budgets (owner, 2026-11-05): each task has its own budget, moved from the promotions budget into the task's account
// (campaign_escrow) when the admin sets it, and each completed task pays from there (completeTask). Members see a task
// only while what is left covers one reward. Lowering the budget returns the unspent part; it cannot go below what was
// paid. The promotions budget itself is funded through a treasury request a second admin approves, so setting a task's
// budget needs one admin.

const MODULES = ['youtube', 'tiktok', 'ads', 'trivia'] as const;

interface TaskRow {
  id: string; public_id: string; module: string; title: string; description: string; reward_minor: string; currency_code: string;
  exponent: number; url: string | null; duration_sec: number | null; details: { options?: string[]; answer?: string }; is_active: boolean;
  created_at: Date; completions: string; budget_minor: string; remaining_minor: string;
}

const SELECT = `SELECT t.id, t.public_id, t.module, t.title, t.description, t.reward_minor, t.currency_code, c.exponent, t.url, t.duration_sec,
                       t.details, t.is_active, t.created_at, t.budget_minor, coalesce(a.balance_minor, 0) AS remaining_minor,
                       (SELECT count(*) FROM task_submissions s WHERE s.task_id = t.id AND s.status = 'approved') AS completions
                FROM tasks t JOIN currencies c ON c.code = t.currency_code
                LEFT JOIN accounts a ON a.kind = 'campaign_escrow' AND a.task_id = t.id AND a.currency_code = t.currency_code`;

const view = (t: TaskRow) => ({
  id: t.public_id, module: t.module, title: t.title, description: t.description, rewardMinor: t.reward_minor,
  reward: toDecimalString(BigInt(t.reward_minor), t.exponent), currency: t.currency_code, linkUrl: t.url, durationSec: t.duration_sec,
  options: t.details.options ?? [], answer: t.details.answer ?? null, active: t.is_active, createdAt: t.created_at, completions: Number(t.completions),
  budgetMinor: t.budget_minor, budget: toDecimalString(BigInt(t.budget_minor), t.exponent), remainingMinor: t.remaining_minor,
  spentMinor: (BigInt(t.budget_minor) - BigInt(t.remaining_minor)).toString(), usedUp: BigInt(t.remaining_minor) < BigInt(t.reward_minor),
});

const TaskBody = z.strictObject({
  module: z.enum(MODULES),
  title: z.string().trim().min(2).max(120),
  description: z.string().trim().min(2, { error: 'Describe the task. For trivia, this is the question.' }).max(600),
  reward: z.string().trim().min(1).max(24),
  budget: z.string().trim().min(1).max(24),
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
  const amount = (name: 'reward' | 'budget') => {
    try {
      return toMinor(body[name], currency.exponent);
    } catch (err) {
      if (err instanceof MoneyFormatError) throw field(name, err.message);
      throw err;
    }
  };
  const rewardMinor = amount('reward');
  if (rewardMinor <= 0n) throw field('reward', 'The reward must be more than zero.');
  const budgetMinor = amount('budget');
  const url = body.linkUrl ? safeLink(body.linkUrl) : null;
  if (body.module === 'youtube' || body.module === 'tiktok') {
    if (!url) throw field('linkUrl', 'Add the link to the video.');
    const embed = videoEmbed(new URL(url));
    if (embed.platform !== body.module || !embed.embedUrl) {
      throw field('linkUrl', `Use the link to one ${body.module === 'youtube' ? 'YouTube' : 'TikTok'} video, so it plays on the member's page.`);
    }
  }

  let details: { options?: string[]; answer?: string } = {};
  if (body.module === 'trivia') {
    const options = [...new Set(body.options)];
    if (options.length < 2) throw field('options', 'Give at least two different answers to choose from.');
    const answer = body.answer?.trim();
    if (!answer || !options.some(o => o.toLowerCase() === answer.toLowerCase())) throw field('answer', 'The correct answer must be one of the choices.');
    details = { options, answer };
  }
  return { rewardMinor, budgetMinor, exponent: currency.exponent, url, details, duration: body.module === 'trivia' ? null : body.durationSec ?? null };
}

// Brings the task's account to the new budget less what was already paid, moving the difference from or back to the
// promotions budget. Runs inside the request's SERIALIZABLE transaction.
async function setBudget(
  db: PoolClient, actorUserId: number, task: { id: string; title: string; currency: string; exponent: number; budgetMinor: bigint }, budgetMinor: bigint,
): Promise<void> {
  const escrow = await accountId(db, { kind: 'campaign_escrow', taskId: Number(task.id), currency: task.currency });
  const { balance_minor } = await one<{ balance_minor: string }>(db, 'SELECT balance_minor FROM accounts WHERE id = $1 FOR UPDATE', [escrow]);
  const remaining = BigInt(balance_minor);
  const spent = task.budgetMinor - remaining;
  if (budgetMinor < spent) {
    throw field('budget', `Members were already paid ${task.currency} ${toDecimalString(spent, task.exponent)} from this task. The budget cannot go below that.`);
  }
  const change = budgetMinor - spent - remaining;
  if (change !== 0n) {
    const promotions = await accountId(db, { kind: 'promotions_budget', currency: task.currency });
    try {
      await post(db, {
        kind: 'task_budget', memo: `${change > 0n ? 'Budget for' : 'Budget returned from'} task: ${task.title}`, refType: 'task', refId: task.id,
        actorUserId, legs: change > 0n ? move(promotions, escrow, change) : move(escrow, promotions, -change),
      });
    } catch (err) {
      if (err instanceof InsufficientFundsError) throw field('budget', 'The promotions budget does not hold that much. Fund it on Balances first (Fund a budget).');
      throw err;
    }
  }
  await db.query('UPDATE tasks SET budget_minor = $2 WHERE id = $1', [task.id, budgetMinor.toString()]);
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
    const result = await idempotent(pool, req, 'task.create', async db => {
      const c = await columns(db, body);
      if (c.budgetMinor < c.rewardMinor) throw field('budget', 'The budget must cover at least one reward.');
      const { id } = await one<{ id: string }>(
        db,
        `INSERT INTO tasks (module, title, description, reward_minor, currency_code, url, duration_sec, details, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [body.module, body.title, body.description, c.rewardMinor.toString(), body.currency, c.url, c.duration, JSON.stringify(c.details), body.active],
      );
      await setBudget(db, req.auth!.userId, { id, title: body.title, currency: body.currency, exponent: c.exponent, budgetMinor: 0n }, c.budgetMinor);
      const after = view(await one<TaskRow>(db, `${SELECT} WHERE t.id = $1`, [id]));
      await audit(db, req, { action: 'task.created', targetType: 'task', targetId: after.id, after });
      return { status: 201, body: { task: after } };
    });
    res.status(result.status).json(result.body);
  });

  router.put('/:id', requireStaff('admin'), async (req, res) => {
    const id = taskId(req.params.id);
    const body = parse(TaskBody, req.body);
    const result = await idempotent(pool, req, `task.update.${id}`, async db => {
      const before = await lockTask(db, id);
      if (before.module !== body.module) throw field('module', 'A task cannot move to another page. Add a new task instead.');
      const hasBudget = BigInt(before.budget_minor) > 0n || BigInt(before.remaining_minor) > 0n;
      if (hasBudget && before.currency_code !== body.currency) throw field('currency', 'The currency cannot change once the task has a budget. Add a new task instead.');
      const c = await columns(db, body);
      await db.query(
        `UPDATE tasks SET title = $2, description = $3, reward_minor = $4, currency_code = $5, url = $6, duration_sec = $7, details = $8, is_active = $9
         WHERE id = $1`,
        [before.id, body.title, body.description, c.rewardMinor.toString(), body.currency, c.url, c.duration, JSON.stringify(c.details), body.active],
      );
      await setBudget(db, req.auth!.userId, { id: before.id, title: body.title, currency: body.currency, exponent: c.exponent, budgetMinor: BigInt(before.budget_minor) }, c.budgetMinor);
      const after = view(await one<TaskRow>(db, `${SELECT} WHERE t.id = $1`, [before.id]));
      await audit(db, req, { action: 'task.updated', targetType: 'task', targetId: id, before: view(before), after });
      return { status: 200, body: { task: after } };
    });
    res.status(result.status).json(result.body);
  });

  // Hiding stops members seeing and completing the task; completed tasks keep their record and the budget stays.
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
