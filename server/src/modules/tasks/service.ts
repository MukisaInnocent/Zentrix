import type { PoolClient } from '../../db/pool.js';
import type { Db } from '../../db/sql.js';
import { maybeOne, one, rows } from '../../db/sql.js';
import { badRequest, notFound } from '../../lib/errors.js';
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

export async function ensureDefaultTasks(db: Db): Promise<void> {
  const count = await one<{ n: string }>(db, 'SELECT count(*) AS n FROM tasks');
  if (Number(count.n) > 0) return;

  const defaults = [
    // YouTube
    { module: 'youtube', title: 'Watch Tech Trends 2026', description: 'Watch the full 3-minute video on emerging mobile technologies.', reward: 1500, url: 'https://youtube.com', duration: 180 },
    { module: 'youtube', title: 'Subscribe to Zentrix Official', description: 'Subscribe to our official YouTube channel and hit the notification bell.', reward: 1000, url: 'https://youtube.com', duration: 60 },
    { module: 'youtube', title: 'Review Mobile Wallet Security', description: 'Learn key security practices for safeguarding your digital wallet credentials.', reward: 2000, url: 'https://youtube.com', duration: 240 },

    // TikTok
    { module: 'tiktok', title: 'Watch Zentrix Life Highlights', description: 'Watch and like the featured member story highlight on TikTok.', reward: 1200, url: 'https://tiktok.com', duration: 45 },
    { module: 'tiktok', title: 'Follow Creator of the Week', description: 'Follow our partner creator specializing in personal finance education.', reward: 800, url: 'https://tiktok.com', duration: 30 },
    { module: 'tiktok', title: 'Share TikTok Educational Reel', description: 'Share the short clip about budgeting in local currencies to your profile.', reward: 1500, url: 'https://tiktok.com', duration: 60 },

    // Ads
    { module: 'ads', title: 'Clean Energy & Solar Solutions', description: 'View the 30-second sponsored advertisement about household solar kits.', reward: 500, duration: 30 },
    { module: 'ads', title: 'AgriTech Farmers Market App', description: 'Explore the 45-second interactive showcase for farm produce delivery.', reward: 800, duration: 45 },
    { module: 'ads', title: 'Fast Mobile Broadband Promo', description: 'View the 60-second high-speed internet bundle promotion.', reward: 1000, duration: 60 },

    // Trivia
    { module: 'trivia', title: 'Red Planet Trivia', description: 'Which planet in our solar system is commonly known as the Red Planet?', reward: 500, details: { options: ['Venus', 'Mars', 'Jupiter', 'Saturn'], answer: 'Mars' } },
    { module: 'trivia', title: 'Capital Cities of East Africa', description: 'What is the capital city of Uganda?', reward: 500, details: { options: ['Nairobi', 'Kigali', 'Kampala', 'Dodoma'], answer: 'Kampala' } },
    { module: 'trivia', title: 'Currencies of the World', description: 'What is the official currency code of Uganda?', reward: 500, details: { options: ['KES', 'TZS', 'UGX', 'RWF'], answer: 'UGX' } },
    { module: 'trivia', title: 'Geography Quiz: Great Lakes', description: 'Which is the largest tropical lake in the world by surface area?', reward: 500, details: { options: ['Lake Victoria', 'Lake Tanganyika', 'Lake Malawi', 'Lake Albert'], answer: 'Lake Victoria' } },
    { module: 'trivia', title: 'Global Economics Quiz', description: 'What is the currency of the United Kingdom?', reward: 500, details: { options: ['Euro', 'Dollar', 'Pound Sterling', 'Yen'], answer: 'Pound Sterling' } },

    // Fix Tap
    { module: 'fixtap', title: 'Data Categorization Micro-task', description: 'Tag 5 store receipts with the correct spending category.', reward: 800, duration: 60 },
    { module: 'fixtap', title: 'Local Business Info Verification', description: 'Verify opening hours and contact info for a local merchant.', reward: 1200, duration: 90 },

    // Music
    { module: 'music', title: 'Stream Trending Afrobeat Track', description: 'Stream the sponsored track on the integrated player for at least 60 seconds.', reward: 600, duration: 60 },
    { module: 'music', title: 'Listen to Indie Artist Spotlight', description: 'Listen to the featured independent artist track and leave a quick rating.', reward: 750, duration: 75 },
  ];

  for (const t of defaults) {
    await db.query(
      `INSERT INTO tasks (module, title, description, reward_minor, currency_code, url, duration_sec, details)
       VALUES ($1, $2, $3, $4, 'UGX', $5, $6, $7)`,
      [t.module, t.title, t.description, t.reward, t.url ?? null, t.duration ?? null, JSON.stringify(t.details ?? {})],
    );
  }
}

export async function listTasks(db: Db, userId: number, module?: string): Promise<TaskItem[]> {
  await ensureDefaultTasks(db);

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

  return taskRows.map(t => ({
    id: t.id,
    module: t.module,
    title: t.title,
    description: t.description,
    rewardMinor: t.reward_minor,
    currency: t.currency_code,
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
  if (member.currency_code !== task.currency_code) {
    throw badRequest('task.currency_unavailable', 'This task pays in another currency. Currency conversion is not available yet.');
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

  const rewardMinor = BigInt(task.reward_minor);
  const budget = await accountId(db, { kind: 'promotions_budget', currency: task.currency_code });
  const earnings = await accountId(db, { kind: 'member_task', userId, module: task.module as TaskModule, currency: task.currency_code });
  let txn: number;
  try {
    txn = await post(db, {
      kind: 'task_reward', memo: `${task.module.toUpperCase()} reward: ${task.title}`, refType: 'task', refId: task.id, actorUserId: userId,
      legs: move(budget, earnings, rewardMinor),
    });
  } catch (err) {
    if (err instanceof InsufficientFundsError) throw badRequest('task.budget_empty', 'This task has no budget left right now. Try again later.');
    throw err;
  }

  await db.query(
    `INSERT INTO task_submissions (user_id, task_id, proof_text, status, reward_minor, currency_code, ledger_transaction_id)
     VALUES ($1, $2, $3, 'approved', $4, $5, $6)`,
    [userId, taskId, answerOrProof ?? 'completed', rewardMinor.toString(), task.currency_code, txn],
  );

  return {
    rewardMinor: task.reward_minor,
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
