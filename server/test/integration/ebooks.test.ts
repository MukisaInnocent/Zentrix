import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app.js';
import type { TestClient } from '../helpers/client.js';
import { createStaff, loginStaff, registerMember } from '../helpers/factories.js';

// E-books (owner, 2026-11-01): admins manage the books on the member E-books page; members see published ones.
let app: TestApp;
let admin: TestClient;
let support: TestClient;

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call */
type Body = Record<string, any>;

beforeAll(async () => {
  app = await startTestApp();
  admin = await loginStaff(app, await createStaff(app, ['admin']));
  support = await loginStaff(app, await createStaff(app, ['support']));
});
afterAll(async () => {
  await app.close();
});

const book = { section: 'Marketing', title: 'Selling on WhatsApp', description: 'A short guide to WhatsApp Status selling.', pages: 24, linkUrl: 'https://example.org/whatsapp.pdf' };

describe('e-books', () => {
  it('starts empty, lets an admin add, edit, hide and remove books, and shows members only published ones', async () => {
    const member = await registerMember(app);
    // No made-up books.
    expect((await member.client.get<Body>('/api/ebooks')).body.ebooks).toEqual([]);
    expect((await app.client().get<Body>('/api/ebooks')).status).toBe(401);

    expect((await support.post<Body>('/api/admin/ebooks', book)).status).toBe(403);
    expect((await admin.post<Body>('/api/admin/ebooks', { ...book, linkUrl: 'http://example.org/x.pdf' })).body.error?.fields?.linkUrl).toBeDefined();
    const created = await admin.post<Body>('/api/admin/ebooks', book);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.ebook.id as string;
    const hidden = await admin.post<Body>('/api/admin/ebooks', { ...book, title: 'Draft book', published: false });
    expect(hidden.status).toBe(201);

    let seen = (await member.client.get<Body>('/api/ebooks')).body.ebooks;
    expect(seen).toEqual([{ id, section: 'Marketing', title: 'Selling on WhatsApp', description: book.description, pages: 24, linkUrl: book.linkUrl }]);
    expect((await support.get<Body>('/api/admin/ebooks')).body.ebooks).toHaveLength(2);

    const edited = await admin.put<Body>(`/api/admin/ebooks/${id}`, { ...book, section: 'Entrepreneurship', pages: null });
    expect(edited.body.ebook).toMatchObject({ section: 'Entrepreneurship', pages: null });
    expect((await admin.post<Body>(`/api/admin/ebooks/${id}/remove`, { note: 'Out of date' })).body.ebook.removedAt).not.toBeNull();
    expect((await member.client.get<Body>('/api/ebooks')).body.ebooks).toEqual([]);
    expect((await admin.put<Body>(`/api/admin/ebooks/${id}`, book)).body.error?.code).toBe('ebook.removed');
    await admin.post<Body>(`/api/admin/ebooks/${id}/restore`, {});
    seen = (await member.client.get<Body>('/api/ebooks')).body.ebooks;
    expect(seen.map((b: Body) => b.section)).toEqual(['Entrepreneurship']);

    const audits = await app.owner.query(`SELECT action FROM audit_log WHERE target_type = 'ebook' AND target_id = $1 ORDER BY id`, [id]);
    expect(audits.rows.map(r => r.action)).toEqual(['ebook.created', 'ebook.updated', 'ebook.removed', 'ebook.restored']);
  });
});
