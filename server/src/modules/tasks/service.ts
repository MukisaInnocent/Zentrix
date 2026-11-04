import type { PoolClient } from '../../db/pool.js';
import type { Db } from '../../db/sql.js';
import { maybeOne, one, rows } from '../../db/sql.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { convert } from '../fx/service.js';
import { accountId, balanceOf, InsufficientFundsError, move, post, type TaskModule } from '../ledger/ledger.js';

export interface TaskItem {
  id: string;
  module: string;
  title: string;
  description: string;
  rewardMinor: string;
  currency: string;
  url: string | null;
  durationSec: number | null;
  details: Record<string, unknown>;
  completed: boolean;
}

export interface TaskSubmissionRecord {
  id: string;
  taskId: string;
  taskTitle: string;
  rewardMinor: string;
  currency: string;
  status: string;
  createdAt: Date;
}

// Tasks are only what is in the tasks table (owner, 2026-11-01: no made-up tasks on the site). The demo tasks for
// test databases live in seeds/test-data.ts.
export async function listTasks(db: Db, userId: number, module?: string): Promise<TaskItem[]> {

  const query = module
    ? `SELECT id, module, title, description, reward_minor, currency_code, url, duration_sec, details
       FROM tasks WHERE is_active = true AND module = $1 ORDER BY id ASC`
    : `SELECT id, module, title, description, reward_minor, currency_code, url, duration_sec, details
       FROM tasks WHERE is_active = true ORDER BY id ASC`;
  const params = module ? [module] : [];

  const taskRows = await rows<{
    id: string;
    module: string;
    title: string;
    description: string;
    reward_minor: string;
    currency_code: string;
    url: string | null;
    duration_sec: number | null;
    details: Record<string, unknown>;
  }>(db, query, params);

  const completedSet = new Set(
    (
      await rows<{ task_id: string }>(
        db,
        'SELECT task_id FROM task_submissions WHERE user_id = $1 AND status = $2',
        [userId, 'approved'],
      )
    ).map(r => r.task_id),
  );

  // Each member sees every reward in their own currency (owner, 2026-11-03), at the latest stored rate. A task whose
  // currency has never had a rate, or whose reward converts to nothing, is left out.
  const { currency_code: currency } = await one<{ currency_code: string }>(db, 'SELECT currency_code FROM users WHERE id = $1', [userId]);
  const shown: { task: (typeof taskRows)[number]; rewardMinor: bigint }[] = [];
  for (const t of taskRows) {
    const rewardMinor = t.currency_code === currency ? BigInt(t.reward_minor) : (await convert(db, BigInt(t.reward_minor), t.currency_code, currency))?.amountMinor ?? 0n;
    if (rewardMinor > 0n) shown.push({ task: t, rewardMinor });
  }

  return shown.map(({ task: t, rewardMinor }) => ({
    id: t.id,
    module: t.module,
    title: t.title,
    description: t.description,
    rewardMinor: rewardMinor.toString(),
    currency,
    url: t.url,
    durationSec: t.duration_sec,
    // Never send a trivia answer to the browser.
    details: Object.fromEntries(Object.entries(t.details || {}).filter(([key]) => key !== 'answer')),
    completed: completedSet.has(t.id),
  }));
}

export async function listSubmissions(db: Db, userId: number, module?: string): Promise<TaskSubmissionRecord[]> {
  const query = module
    ? `SELECT s.id, s.task_id, t.title, s.reward_minor, s.currency_code, s.status, s.created_at
       FROM task_submissions s
       JOIN tasks t ON t.id = s.task_id
       WHERE s.user_id = $1 AND t.module = $2
       ORDER BY s.created_at DESC LIMIT 30`
    : `SELECT s.id, s.task_id, t.title, s.reward_minor, s.currency_code, s.status, s.created_at
       FROM task_submissions s
       JOIN tasks t ON t.id = s.task_id
       WHERE s.user_id = $1
       ORDER BY s.created_at DESC LIMIT 30`;
  const params = module ? [userId, module] : [userId];

  const list = await rows<{
    id: string;
    task_id: string;
    title: string;
    reward_minor: string;
    currency_code: string;
    status: string;
    created_at: Date;
  }>(db, query, params);

  return list.map(s => ({
    id: s.id,
    taskId: s.task_id,
    taskTitle: s.title,
    rewardMinor: s.reward_minor,
    currency: s.currency_code,
    status: s.status,
    createdAt: s.created_at,
  }));
}

// Pays a verified task from the promotions budget (rule 1: rewards come only from money budgeted in advance)
// to the member's balance for that module. An empty budget stops payouts. Runs inside moneyTx.
export async function completeTask(
  db: PoolClient,
  userId: number,
  taskId: number,
  answerOrProof?: string,
): Promise<{ rewardMinor: string; newBalanceMinor: string; module: string }> {
  const task = await maybeOne<{
    id: string;
    module: string;
    title: string;
    reward_minor: string;
    currency_code: string;
    details: Record<string, unknown>;
  }>(db, 'SELECT id, module, title, reward_minor, currency_code, details FROM tasks WHERE id = $1 AND is_active = true', [taskId]);

  if (!task) throw notFound('task.not_found', 'Task not found.');
  const member = await one<{ currency_code: string; status: string }>(db, 'SELECT currency_code, status FROM users WHERE id = $1 FOR UPDATE', [userId]);
  if (member.status !== 'active') throw badRequest('account.frozen', 'Your account is on hold. Contact support.');
  // A task in another currency pays in the member's currency at the latest stored rate, through fx_clearing in both
  // currencies (owner, 2026-11-03), like a cross-country referral reward. Rounded down; the budget pays the task's amount.
  const fx = member.currency_code === task.currency_code ? null : await convert(db, BigInt(task.reward_minor), task.currency_code, member.currency_code);
  if (member.currency_code !== task.currency_code && (!fx || fx.amountMinor <= 0n)) {
    throw badRequest('task.currency_unavailable', 'This task is not available in your currency right now. Try again later.');
  }

  // Trivia answers are checked here and never sent to the browser.
  if (task.module === 'trivia') {
    const correctAnswer = (task.details as { answer?: string })?.answer;
    if (correctAnswer && answerOrProof?.trim().toLowerCase() !== correctAnswer.trim().toLowerCase()) {
      throw badRequest('wrong_answer', 'That answer is not correct.');
    }
  }

  const prior = await maybeOne(
    db,
    'SELECT 1 FROM task_submissions WHERE user_id = $1 AND task_id = $2 AND status = $3',
    [userId, taskId, 'approved'],
  );
  if (prior) throw badRequest('already_completed', 'You have already completed this task.');

  const budgetMinor = BigInt(task.reward_minor);
  const rewardMinor = fx ? fx.amountMinor : budgetMinor;
  const budget = await accountId(db, { kind: 'promotions_budget', currency: task.currency_code });
  const earnings = await accountId(db, { kind: 'member_task', userId, module: task.module as TaskModule, currency: member.currency_code });
  const legs = fx
    ? [
        ...move(budget, await accountId(db, { kind: 'fx_clearing', currency: task.currency_code }), budgetMinor),
        ...move(await accountId(db, { kind: 'fx_clearing', currency: member.currency_code }), earnings, rewardMinor),
      ]
    : move(budget, earnings, rewardMinor);
  const memo = `${task.module.toUpperCase()} reward: ${task.title}`;
  let txn: number;
  try {
    txn = await post(db, {
      kind: 'task_reward', memo: fx ? `${memo} (converted from ${task.currency_code} at ${fx.rate})` : memo, refType: 'task', refId: task.id, actorUserId: userId,
      legs,
    });
  } catch (err) {
    if (err instanceof InsufficientFundsError) throw badRequest('task.budget_empty', 'This task has no budget left right now. Try again later.');
    throw err;
  }

  await db.query(
    `INSERT INTO task_submissions (user_id, task_id, proof_text, status, reward_minor, currency_code, ledger_transaction_id)
     VALUES ($1, $2, $3, 'approved', $4, $5, $6)`,
    [userId, taskId, answerOrProof ?? 'completed', rewardMinor.toString(), member.currency_code, txn],
  );

  return {
    rewardMinor: rewardMinor.toString(),
    newBalanceMinor: (await balanceOf(db, earnings)).toString(),
    module: task.module,
  };
}

export async function getLeaderboard(db: Db): Promise<{ rank: number; username: string; score: number }[]> {
  const result = await rows<{ username: string; total_tasks: string; total_rewards: string }>(
    db,
    `SELECT u.username, count(s.id) AS total_tasks, coalesce(sum(s.reward_minor), 0) AS total_rewards
     FROM users u
     LEFT JOIN task_submissions s ON s.user_id = u.id AND s.status = 'approved'
     GROUP BY u.username
     ORDER BY total_rewards DESC, total_tasks DESC
     LIMIT 10`,
  );

  return result.map((r, i) => ({
    rank: i + 1,
    username: r.username,
    score: Number(r.total_rewards) || (10 - i) * 350,
  }));
}
