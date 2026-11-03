import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app.js';
import type { TestClient } from '../helpers/client.js';
import { createStaff, loginStaff, registerMember, type Member } from '../helpers/factories.js';

// Owner, 2026-11-03: admins add tasks for the member task pages and video links for the Videos page; links to adult
// content are refused.
let app: TestApp;
let admin: TestClient;
let support: TestClient;

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call */
type Body = Record<string, any>;
const key = () => ({ 'idempotency-key': randomUUID() });

beforeAll(async () => {
  app = await startTestApp();
  admin = await loginStaff(app, await createStaff(app, ['admin']));
  support = await loginStaff(app, await createStaff(app, ['support']));
});
afterAll(async () => {
  await app.close();
});

async function activated(): Promise<Member> {
  const m = await registerMember(app);
  expect((await admin.post<Body>(`/api/admin/payments/members/${m.user.id}/activate`, { note: 'Paid me by phone' }, key())).status).toBe(201);
  return m;
}

const task = { module: 'youtube', title: 'Watch our intro', description: 'Watch the whole video.', reward: '500', currency: 'UGX', linkUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', durationSec: 30 };

describe('tasks in the staff console', () => {
  it('lets an admin add, edit, hide and show tasks that members then see, and refuses bad input', async () => {
    const member = await activated();
    expect((await support.post<Body>('/api/admin/tasks', task)).status).toBe(403);
    const bad = async (body: Body) => (await admin.post<Body>('/api/admin/tasks', { ...task, ...body })).body.error?.fields ?? {};
    expect(Object.keys(await bad({ linkUrl: 'https://www.pornhub.com/view_video.php?viewkey=1' }))).toEqual(['linkUrl']);
    expect(Object.keys(await bad({ linkUrl: null }))).toEqual(['linkUrl']);
    expect(Object.keys(await bad({ reward: '0' }))).toEqual(['reward']);
    expect(Object.keys(await bad({ reward: '10.5' }))).toEqual(['reward']);
    expect(Object.keys(await bad({ module: 'trivia', options: ['Kampala', 'Nairobi'], answer: 'Dodoma' }))).toEqual(['answer']);

    const created = await admin.post<Body>('/api/admin/tasks', task);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.task.id as string;
    let seen = (await member.client.get<Body>('/api/tasks?module=youtube')).body.tasks;
    expect(seen.find((t: Body) => t.title === task.title)).toMatchObject({ rewardMinor: '500', currency: 'UGX', url: task.linkUrl, durationSec: 30 });

    const trivia = await admin.post<Body>('/api/admin/tasks', { ...task, module: 'trivia', title: 'Capital', description: 'What is the capital of Uganda?', linkUrl: null, options: ['Kampala', 'Nairobi'], answer: 'kampala' });
    expect(trivia.status, JSON.stringify(trivia.body)).toBe(201);
    const question = (await member.client.get<Body>('/api/tasks?module=trivia')).body.tasks.find((t: Body) => t.title === 'Capital');
    expect(question.details).toEqual({ options: ['Kampala', 'Nairobi'] }); // the answer never goes to the browser

    expect((await admin.put<Body>(`/api/admin/tasks/${id}`, { ...task, title: 'Watch our intro video', reward: '700' })).body.task).toMatchObject({ title: 'Watch our intro video', rewardMinor: '700' });
    expect((await admin.put<Body>(`/api/admin/tasks/${id}`, { ...task, module: 'ads' })).body.error?.fields?.module).toBeDefined();
    await admin.post<Body>(`/api/admin/tasks/${id}/hide`, {});
    seen = (await member.client.get<Body>('/api/tasks?module=youtube')).body.tasks;
    expect(seen.some((t: Body) => t.title.startsWith('Watch our intro'))).toBe(false);
    await admin.post<Body>(`/api/admin/tasks/${id}/show`, {});
    expect((await support.get<Body>('/api/admin/tasks?module=youtube')).body.tasks.find((t: Body) => t.id === id)).toMatchObject({ active: true, completions: 0 });

    const audits = await app.owner.query(`SELECT action FROM audit_log WHERE target_type = 'task' AND target_id = $1 ORDER BY id`, [id]);
    expect(audits.rows.map(r => r.action)).toEqual(['task.created', 'task.updated', 'task.hidden', 'task.shown']);
  });
});

describe('videos', () => {
  it('lets an admin add video links from any site but not adult ones, and shows activated members the published ones', async () => {
    const member = await activated();
    const waiting = await registerMember(app);
    expect((await support.post<Body>('/api/admin/videos', { title: 'Intro', linkUrl: 'https://youtu.be/dQw4w9WgXcQ' })).status).toBe(403);
    expect((await admin.post<Body>('/api/admin/videos', { title: 'Bad', linkUrl: 'https://xhamster.com/videos/1' })).body.error?.fields?.linkUrl).toEqual(['Links to adult content are not allowed.']);
    expect((await admin.post<Body>('/api/admin/videos', { title: 'Bad', linkUrl: 'http://example.org/v' })).body.error?.fields?.linkUrl).toBeDefined();

    const yt = await admin.post<Body>('/api/admin/videos', { title: 'How to start', description: 'Our first lesson.', linkUrl: 'https://youtu.be/dQw4w9WgXcQ', sort: 1 });
    expect(yt.status, JSON.stringify(yt.body)).toBe(201);
    await admin.post<Body>('/api/admin/videos', { title: 'On TikTok', linkUrl: 'https://www.tiktok.com/@creator/video/7212345678901234567', sort: 2 });
    await admin.post<Body>('/api/admin/videos', { title: 'Elsewhere', linkUrl: 'https://vimeo.com/123456', sort: 3 });
    await admin.post<Body>('/api/admin/videos', { title: 'Draft', linkUrl: 'https://vimeo.com/999', published: false });

    const videos = (await member.client.get<Body>('/api/videos')).body.videos;
    expect(videos.map((v: Body) => [v.title, v.platform, v.embedUrl])).toEqual([
      ['How to start', 'youtube', 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'],
      ['On TikTok', 'tiktok', 'https://www.tiktok.com/embed/v2/7212345678901234567'],
      ['Elsewhere', 'other', null],
    ]);
    expect((await waiting.client.get<Body>('/api/videos')).status).toBe(403);

    const id = yt.body.video.id as string;
    await admin.post<Body>(`/api/admin/videos/${id}/remove`, { note: 'Old' });
    expect((await member.client.get<Body>('/api/videos')).body.videos.map((v: Body) => v.title)).toEqual(['On TikTok', 'Elsewhere']);
    expect((await admin.put<Body>(`/api/admin/videos/${id}`, { title: 'New title', linkUrl: 'https://youtu.be/dQw4w9WgXcQ' })).body.error?.code).toBe('video.removed');
    expect((await support.get<Body>('/api/admin/videos?removed=1')).body.videos).toHaveLength(4);
  });
});
