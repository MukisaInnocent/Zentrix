import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app.js';
import type { TestClient } from '../helpers/client.js';
import { createStaff, loginStaff, registerMember, type Member } from '../helpers/factories.js';

// Member chat: invite contacts, random matches across countries, blocks and reports. Activation runs through the
// test autopilot so each member is activated the real way.
let app: TestApp;
let support: TestClient;

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call */
type Body = Record<string, any> & { error?: { code: string; fields?: Record<string, string[]> } };
const key = () => ({ 'idempotency-key': randomUUID() });
const kenyanPhone = () => `+25471${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;

beforeAll(async () => {
  app = await startTestApp({ TEST_AUTO_APPROVE: 'true' });
  support = await loginStaff(app, await createStaff(app, ['support']));
});
afterAll(async () => {
  await app.close();
});

async function member(overrides: Record<string, unknown> = {}, activated = true): Promise<Member> {
  const m = await registerMember(app, overrides);
  if (activated) {
    const info = await m.client.get<Body>('/api/payments/channels');
    const channel = info.body.channels[0].code as string;
    const res = await m.client.post<Body>('/api/payments/deposits', { channel, senderPhone: m.input.phone, providerTxnId: `TEST${randomUUID().slice(0, 8)}` }, key());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  }
  return m;
}

describe('invite chat', () => {
  it('connects a member with their inviter and the people they invited, and nobody else', async () => {
    const inviter = await member();
    const me = await member({ referralCode: inviter.input.username });
    const invited = await member({ referralCode: me.input.username });
    const grandchild = await member({ referralCode: invited.input.username });
    await member({ referralCode: me.input.username }, false); // not activated: not a contact yet

    const contacts = (await me.client.get<Body>('/api/chat/contacts')).body.contacts;
    expect(contacts.map((c: Body) => [c.username, c.relation])).toEqual([[invited.input.username, 'invited'], [inviter.input.username, 'inviter']]);
    // Usernames and countries only: no phone numbers or email addresses.
    expect(Object.keys(contacts[0]).sort()).toEqual(['blocked', 'conversationId', 'country', 'relation', 'username']);

    expect((await me.client.post<Body>('/api/chat/conversations', { username: grandchild.input.username })).body.error?.fields?.username).toBeDefined();
    const open = await me.client.post<Body>('/api/chat/conversations', { username: `@${inviter.input.username}` });
    expect(open.status, JSON.stringify(open.body)).toBe(201);
    const id = open.body.conversation.id as string;
    // Opening again returns the same conversation.
    expect((await inviter.client.post<Body>('/api/chat/conversations', { username: me.input.username })).body.conversation.id).toBe(id);

    expect((await me.client.post<Body>(`/api/chat/conversations/${id}/messages`, { body: 'Hello, thanks for the invite' })).status).toBe(201);
    const list = (await inviter.client.get<Body>('/api/chat/conversations')).body.conversations;
    expect(list[0]).toMatchObject({ id, kind: 'invite', username: me.input.username, lastMessage: 'Hello, thanks for the invite', unread: 1 });
    const thread = await inviter.client.get<Body>(`/api/chat/conversations/${id}`);
    expect(thread.body.messages.map((m: Body) => [m.username, m.body, m.mine])).toEqual([[me.input.username, 'Hello, thanks for the invite', false]]);
    expect((await inviter.client.get<Body>('/api/chat/conversations')).body.conversations[0].unread).toBe(0);

    // Nobody outside the conversation can read it or write to it.
    expect((await grandchild.client.get<Body>(`/api/chat/conversations/${id}`)).status).toBe(404);
    expect((await grandchild.client.post<Body>(`/api/chat/conversations/${id}/messages`, { body: 'hi' })).status).toBe(404);
  });

  it('needs an activated account', async () => {
    const waiting = await member({}, false);
    expect((await waiting.client.get<Body>('/api/chat/contacts')).body.error?.code).toBe('activation.required');
  });
});

describe('chat with foreigners', () => {
  it('matches a random activated member from another country, and never a blocked one', async () => {
    // Every other member in this file is Ugandan, so the Kenyan is the only possible match for a Ugandan.
    const ugandan = await member();
    const kenyan = await member({ country: 'KE', phone: kenyanPhone() });
    const match = await ugandan.client.post<Body>('/api/chat/match', {});
    expect(match.status, JSON.stringify(match.body)).toBe(201);
    expect(match.body.conversation).toMatchObject({ username: kenyan.input.username, country: 'KE' });
    const id = match.body.conversation.id as string;
    expect((await ugandan.client.get<Body>(`/api/chat/conversations/${id}`)).body.conversation.kind).toBe('foreign');
    expect((await kenyan.client.post<Body>('/api/chat/match', {})).body.conversation.country).toBe('UG');

    // The Kenyan blocks the Ugandan: no messages either way, and no more matches between them.
    expect((await kenyan.client.post<Body>('/api/chat/blocks', { username: ugandan.input.username })).status).toBe(201);
    expect((await ugandan.client.post<Body>(`/api/chat/conversations/${id}/messages`, { body: 'hello?' })).body.error?.code).toBe('chat.blocked');
    expect((await kenyan.client.post<Body>(`/api/chat/conversations/${id}/messages`, { body: 'hello?' })).body.error?.code).toBe('chat.blocked');
    expect((await ugandan.client.post<Body>('/api/chat/match', {})).body.error?.code).toBe('chat.no_match');
    expect((await kenyan.client.get<Body>('/api/chat/blocks')).body.blocked.map((b: Body) => b.username)).toEqual([ugandan.input.username]);

    expect((await kenyan.client.delete<Body>(`/api/chat/blocks/${ugandan.input.username}`)).status).toBe(200);
    expect((await ugandan.client.post<Body>(`/api/chat/conversations/${id}/messages`, { body: 'Hi again' })).status).toBe(201);
  });
});

describe('chat reports', () => {
  it('lets a member report a chat once, and staff read it only through the report, with an audit entry', async () => {
    const inviter = await member();
    const me = await member({ referralCode: inviter.input.username });
    const id = (await me.client.post<Body>('/api/chat/conversations', { username: inviter.input.username })).body.conversation.id as string;
    await inviter.client.post(`/api/chat/conversations/${id}/messages`, { body: 'Send me your PIN' });
    const reported = await me.client.post<Body>(`/api/chat/conversations/${id}/report`, { reason: 'Asked for my mobile money PIN' });
    expect(reported.status, JSON.stringify(reported.body)).toBe(201);
    expect((await me.client.post<Body>(`/api/chat/conversations/${id}/report`, { reason: 'Again please' })).body.error?.code).toBe('chat.already_reported');

    expect((await me.client.get<Body>('/api/admin/chats/reports')).status).toBe(403);
    const open = (await support.get<Body>('/api/admin/chats/reports')).body.reports;
    const mine = open.find((r: Body) => r.id === reported.body.report.id);
    expect(mine).toMatchObject({ reporter: me.input.username, reason: 'Asked for my mobile money PIN', status: 'open' });
    const detail = await support.get<Body>(`/api/admin/chats/reports/${mine.id}`);
    expect(detail.body.messages.map((m: Body) => m.body)).toEqual(['Send me your PIN']);
    const audited = await app.owner.query(`SELECT 1 FROM audit_log WHERE action = 'chat.report_viewed' AND target_id = $1`, [mine.id]);
    expect(audited.rowCount).toBe(1);
    expect((await support.post<Body>(`/api/admin/chats/reports/${mine.id}/close`, { note: 'Warned the member' })).status).toBe(200);
    expect((await support.post<Body>(`/api/admin/chats/reports/${mine.id}/close`, { note: 'Again' })).body.error?.code).toBe('chat.report_closed');
    // Messages cannot be edited or deleted, even by the database owner.
    await expect(app.owner.query(`UPDATE chat_messages SET body = 'x'`)).rejects.toBeDefined();
  });
});
