import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app.js';
import type { TestClient } from '../helpers/client.js';
import { createStaff, loginStaff, registerMember, type Member } from '../helpers/factories.js';

// Owner, 2026-11-03: admins add tasks for the member task pages and video links for the Videos page; links to adult
// content are refused.
let app: TestApp;
let admin: TestClient;
let admin2: TestClient;
let support: TestClient;

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call */
type Body = Record<string, any>;
const key = () => ({ 'idempotency-key': randomUUID() });

beforeAll(async () => {
  app = await startTestApp();
  admin = await loginStaff(app, await createStaff(app, ['admin']));
  admin2 = await loginStaff(app, await createStaff(app, ['admin']));
  support = await loginStaff(app, await createStaff(app, ['support']));
  const channel = await admin.post<Body>('/api/admin/payments/channels', {
    code: 'mtn_test', name: 'MTN Mobile Money', ussdCode: '*165*3#', merchantCode: '123456', accountNumber: '123456', country: 'UG', accountName: 'PEXEREARN TEST',
  });
  expect(channel.status, JSON.stringify(channel.body)).toBe(201);
});
afterAll(async () => {
  await app.close();
});

async function activated(): Promise<Member> {
  const m = await registerMember(app);
  expect((await admin.post<Body>(`/api/admin/payments/members/${m.user.id}/activate`, { note: 'Paid me by phone' }, key())).status).toBe(201);
  return m;
}

const task = { module: 'youtube', title: 'Watch our intro', description: 'Watch the whole video.', reward: '500', budget: '5000', currency: 'UGX', linkUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', durationSec: 30 };
const addTask = (body: Body) => admin.post<Body>('/api/admin/tasks', body, key());
const editTask = (id: string, body: Body) => admin.put<Body>(`/api/admin/tasks/${id}`, body, key());
const balanceOf = async (kind: string, currency = 'UGX') =>
  BigInt((await app.owner.query<{ s: string }>('SELECT coalesce(sum(balance_minor), 0)::text AS s FROM accounts WHERE kind = $1 AND currency_code = $2', [kind, currency])).rows[0]!.s);

// Owner capital, then the promotions budget, each approved by a second admin (treasury maker-checker).
async function fundPromotions(amount: string) {
  const capital = await admin.post<Body>('/api/admin/payments/treasury', { kind: 'capital_in', currency: 'UGX', amount, channel: 'mtn_test', externalRef: `OWNER-${randomUUID().slice(0, 8)}`, note: 'Owner capital for tests' });
  expect(capital.status, JSON.stringify(capital.body)).toBe(201);
  expect((await admin2.post<Body>(`/api/admin/payments/treasury/${capital.body.id}/decide`, { approve: true }, key())).status).toBe(200);
  const budget = await admin.post<Body>('/api/admin/payments/treasury', { kind: 'fund_budget', currency: 'UGX', amount, source: 'owner_capital', budget: 'promotions_budget', note: 'Task budget' });
  expect((await admin2.post<Body>(`/api/admin/payments/treasury/${budget.body.id}/decide`, { approve: true }, key())).status).toBe(200);
}

describe('tasks in the staff console', () => {
  it('lets an admin add, edit, hide and show tasks that members then see, and refuses bad input', async () => {
    await fundPromotions('20000');
    const member = await activated();
    expect((await support.post<Body>('/api/admin/tasks', task, key())).status).toBe(403);
    const bad = async (body: Body) => (await addTask({ ...task, ...body })).body.error?.fields ?? {};
    expect(Object.keys(await bad({ linkUrl: 'https://www.pornhub.com/view_video.php?viewkey=1' }))).toEqual(['linkUrl']);
    expect(Object.keys(await bad({ linkUrl: null }))).toEqual(['linkUrl']);
    expect(Object.keys(await bad({ reward: '0' }))).toEqual(['reward']);
    expect(Object.keys(await bad({ reward: '10.5' }))).toEqual(['reward']);
    expect(Object.keys(await bad({ module: 'trivia', options: ['Kampala', 'Nairobi'], answer: 'Dodoma' }))).toEqual(['answer']);

    const created = await addTask(task);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.task.id as string;
    let seen = (await member.client.get<Body>('/api/tasks?module=youtube')).body.tasks;
    expect(seen.find((t: Body) => t.title === task.title)).toMatchObject({
      rewardMinor: '500', currency: 'UGX', url: task.linkUrl, embedUrl: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', durationSec: 30,
    });

    const trivia = await addTask({ ...task, module: 'trivia', title: 'Capital', description: 'What is the capital of Uganda?', linkUrl: null, options: ['Kampala', 'Nairobi'], answer: 'kampala' });
    expect(trivia.status, JSON.stringify(trivia.body)).toBe(201);
    const question = (await member.client.get<Body>('/api/tasks?module=trivia')).body.tasks.find((t: Body) => t.title === 'Capital');
    expect(question.details).toEqual({ options: ['Kampala', 'Nairobi'] }); // the answer never goes to the browser

    expect((await editTask(id, { ...task, title: 'Watch our intro video', reward: '700' })).body.task).toMatchObject({ title: 'Watch our intro video', rewardMinor: '700' });
    expect((await editTask(id, { ...task, module: 'ads' })).body.error?.fields?.module).toBeDefined();
    await admin.post<Body>(`/api/admin/tasks/${id}/hide`, {});
    seen = (await member.client.get<Body>('/api/tasks?module=youtube')).body.tasks;
    expect(seen.some((t: Body) => t.title.startsWith('Watch our intro'))).toBe(false);
    await admin.post<Body>(`/api/admin/tasks/${id}/show`, {});
    expect((await support.get<Body>('/api/admin/tasks?module=youtube')).body.tasks.find((t: Body) => t.id === id)).toMatchObject({ active: true, completions: 0 });

    const audits = await app.owner.query(`SELECT action FROM audit_log WHERE target_type = 'task' AND target_id = $1 ORDER BY id`, [id]);
    expect(audits.rows.map(r => r.action)).toEqual(['task.created', 'task.updated', 'task.hidden', 'task.shown']);
  });
});

describe('TikTok LIVE tasks (owner, 2026-11-06)', () => {
  it('accepts a TikTok LIVE link, which members open on TikTok, and still refuses other non-video links', async () => {
    const member = await activated();
    const live = { ...task, module: 'tiktok', title: `Live ${randomUUID().slice(0, 6)}`, linkUrl: 'https://www.tiktok.com/@pexerearn/live' };
    const created = await addTask(live);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const shown = (await member.client.get<Body>('/api/tasks?module=tiktok')).body.tasks.find((t: Body) => t.title === live.title);
    expect(shown).toMatchObject({ live: true, embedUrl: null, url: live.linkUrl });
    expect((await addTask({ ...live, linkUrl: 'https://www.tiktok.com/@pexerearn' })).body.error?.fields?.linkUrl).toBeDefined();
    expect((await addTask({ ...live, module: 'youtube' })).body.error?.fields?.linkUrl).toBeDefined();
    // A short link from TikTok's Share button opens on TikTok too (owner, 2026-11-08).
    const short = { ...live, title: `Short ${randomUUID().slice(0, 6)}`, linkUrl: 'https://vt.tiktok.com/ZSabc123x/' };
    expect((await addTask(short)).status).toBe(201);
    expect((await member.client.get<Body>('/api/tasks?module=tiktok')).body.tasks.find((t: Body) => t.title === short.title))
      .toMatchObject({ live: false, embedUrl: null, url: short.linkUrl });
    expect((await addTask({ ...short, linkUrl: 'https://vt.tiktok.com/' })).body.error?.fields?.linkUrl).toBeDefined();
    expect((await member.client.post<Body>(`/api/tasks/${shown.id}/complete`, {}, key())).status).toBe(200);
  });
});

describe('task budgets (owner, 2026-11-05)', () => {
  it('issues any budget the admin sets into the task (not real money), pays each member from it and hides the task when it runs out', async () => {
    const promotions = await balanceOf('promotions_budget');
    const issued = await balanceOf('task_credit');
    const members = [await activated(), await activated(), await activated()];
    const body = { ...task, title: `Budget ${randomUUID().slice(0, 6)}`, reward: '1000', budget: '2500' };

    expect((await addTask({ ...body, budget: '900' })).body.error?.fields?.budget).toBeDefined(); // below one reward
    expect((await admin.post<Body>('/api/admin/tasks', body)).body.error?.code).toBe('idempotency.missing');
    expect(await balanceOf('task_credit')).toBe(issued);

    const created = await addTask(body);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.task.id as string;
    expect(created.body.task).toMatchObject({ budgetMinor: '2500', remainingMinor: '2500', spentMinor: '0' });
    // No promotions budget needed: the budget is issued from task_credit (owner, 2026-11-05).
    expect(await balanceOf('task_credit')).toBe(issued + 2500n);
    expect(await balanceOf('promotions_budget')).toBe(promotions);

    const complete = async (m: Member) => {
      const shown = (await m.client.get<Body>('/api/tasks?module=youtube')).body.tasks.find((t: Body) => t.title === body.title);
      return shown ? m.client.post<Body>(`/api/tasks/${shown.id}/complete`, {}, key()) : null;
    };
    expect((await complete(members[0]!))?.status).toBe(200);
    expect((await complete(members[1]!))?.status).toBe(200);
    // 500 left is less than one reward: the task is gone from members' pages.
    expect(await complete(members[2]!)).toBeNull();
    const after = (await support.get<Body>('/api/admin/tasks?module=youtube')).body.tasks.find((t: Body) => t.id === id);
    expect(after).toMatchObject({ budgetMinor: '2500', remainingMinor: '500', spentMinor: '2000', completions: 2 });

    // Raising the budget issues more and shows the task again.
    expect((await editTask(id, { ...body, budget: '3500' })).body.task).toMatchObject({ remainingMinor: '1500', spentMinor: '2000' });
    expect(await balanceOf('task_credit')).toBe(issued + 3500n);
    expect((await complete(members[2]!))?.status).toBe(200);

    // The budget cannot go below what was paid; lowering it returns the unspent part.
    expect((await editTask(id, { ...body, budget: '2999' })).body.error?.fields?.budget).toBeDefined();
    expect((await editTask(id, { ...body, budget: '3000' })).body.task).toMatchObject({ remainingMinor: '0', spentMinor: '3000' });
    expect(await balanceOf('task_credit')).toBe(issued + 3000n);
    expect(await balanceOf('promotions_budget')).toBe(promotions);
    // The currency is fixed once a budget is set.
    expect((await editTask(id, { ...body, budget: '3000', currency: 'KES' })).body.error?.fields?.currency).toBeDefined();

    const actions = await app.owner.query(`SELECT action FROM audit_log WHERE target_type = 'task' AND target_id = $1 ORDER BY id`, [id]);
    expect(actions.rows.map(r => r.action)).toEqual(['task.created', 'task.updated', 'task.updated']);
    const kinds = await app.owner.query(`SELECT kind FROM ledger_transactions WHERE ref_type = 'task' AND ref_id = (SELECT id::text FROM tasks WHERE public_id = $1) ORDER BY id`, [id]);
    expect(kinds.rows.map(r => r.kind)).toEqual(['task_budget', 'task_reward', 'task_reward', 'task_budget', 'task_reward', 'task_budget']);
  });

  it('pays only one member when two race for the last reward', async () => {
    await fundPromotions('1000');
    const [a, b] = [await activated(), await activated()];
    const body = { ...task, title: `Race ${randomUUID().slice(0, 6)}`, reward: '1000', budget: '1000' };
    expect((await addTask(body)).status).toBe(201);
    const shown = (await a.client.get<Body>('/api/tasks?module=youtube')).body.tasks.find((t: Body) => t.title === body.title);
    const results = await Promise.all([a, b].map(m => m.client.post<Body>(`/api/tasks/${shown.id}/complete`, {}, key())));
    expect(results.map(r => r.status).sort()).toEqual([200, 400]);
    expect(results.find(r => r.status === 400)!.body.error?.code).toBe('task.budget_empty');
  });

  it('requires a link to one video that can play on the page for YouTube and TikTok tasks', async () => {
    expect((await addTask({ ...task, linkUrl: 'https://www.youtube.com/@somechannel' })).body.error?.fields?.linkUrl).toBeDefined();
    expect((await addTask({ ...task, module: 'tiktok', linkUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' })).body.error?.fields?.linkUrl).toBeDefined();
    expect((await addTask({ ...task, module: 'tiktok', linkUrl: 'https://www.tiktok.com/@creator' })).body.error?.fields?.linkUrl).toBeDefined();
  });
});

describe('videos', () => {
  it('accepts only YouTube and TikTok videos that play on the site, and shows activated members the published ones without the outside link', async () => {
    const member = await activated();
    const waiting = await registerMember(app);
    expect((await support.post<Body>('/api/admin/videos', { title: 'Intro', linkUrl: 'https://youtu.be/dQw4w9WgXcQ' })).status).toBe(403);
    expect((await admin.post<Body>('/api/admin/videos', { title: 'Bad', linkUrl: 'https://xhamster.com/videos/1' })).body.error?.fields?.linkUrl).toEqual(['Links to adult content are not allowed.']);
    expect((await admin.post<Body>('/api/admin/videos', { title: 'Bad', linkUrl: 'http://example.org/v' })).body.error?.fields?.linkUrl).toBeDefined();

    const yt = await admin.post<Body>('/api/admin/videos', { title: 'How to start', description: 'Our first lesson.', linkUrl: 'https://youtu.be/dQw4w9WgXcQ', sort: 1 });
    expect(yt.status, JSON.stringify(yt.body)).toBe(201);
    await admin.post<Body>('/api/admin/videos', { title: 'On TikTok', linkUrl: 'https://www.tiktok.com/@creator/video/7212345678901234567', sort: 2 });
    // Owner, 2026-11-05: every video plays on the site, so other sites and channel pages are refused.
    expect((await admin.post<Body>('/api/admin/videos', { title: 'Elsewhere', linkUrl: 'https://vimeo.com/123456' })).body.error?.fields?.linkUrl).toBeDefined();
    expect((await admin.post<Body>('/api/admin/videos', { title: 'Channel', linkUrl: 'https://www.youtube.com/@somechannel' })).body.error?.fields?.linkUrl).toBeDefined();
    await admin.post<Body>('/api/admin/videos', { title: 'Draft', linkUrl: 'https://youtu.be/abcdefghijk', published: false });
    // An older link saved before the rule stays hidden from members.
    await app.owner.query(`INSERT INTO videos (title, link_url, sort, created_by) SELECT 'Old link', 'https://vimeo.com/1', 3, id FROM users ORDER BY id LIMIT 1`);

    const videos = (await member.client.get<Body>('/api/videos')).body.videos;
    expect(videos.map((v: Body) => [v.title, v.platform, v.embedUrl])).toEqual([
      ['How to start', 'youtube', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'],
      ['On TikTok', 'tiktok', 'https://www.tiktok.com/embed/v2/7212345678901234567'],
    ]);
    expect(videos.some((v: Body) => 'linkUrl' in v)).toBe(false);
    expect((await waiting.client.get<Body>('/api/videos')).status).toBe(403);

    const id = yt.body.video.id as string;
    await admin.post<Body>(`/api/admin/videos/${id}/remove`, { note: 'Old' });
    expect((await member.client.get<Body>('/api/videos')).body.videos.map((v: Body) => v.title)).toEqual(['On TikTok']);
    expect((await admin.put<Body>(`/api/admin/videos/${id}`, { title: 'New title', linkUrl: 'https://youtu.be/dQw4w9WgXcQ' })).body.error?.code).toBe('video.removed');
    expect((await support.get<Body>('/api/admin/videos?removed=1')).body.videos).toHaveLength(4);
  });
});
