import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app.js';
import type { TestClient } from '../helpers/client.js';
import { createStaff, loginStaff, registerMember, type Member } from '../helpers/factories.js';

// Member chat between a member and their direct inviter or direct invitees, blocks and reports (owner, 2026-11-08). Activation runs through the
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

describe('chat with foreigners (owner, 2026-11-08: an outside live chat page)', () => {
  it('makes no random matches and pays no chat rewards; older foreign chats are closed; blocks still work for invite chats', async () => {
    const ugandan = await member();
    const kenyan = await member({ country: 'KE', phone: kenyanPhone() });
    expect((await ugandan.client.post<Body>('/api/chat/match', {})).body.error?.code).toBe('chat.foreign_closed');

    // A foreign chat made before the change is no longer listed, opened, written to or rewarded.
    const idOf = async (m: Member) => Number((await app.owner.query<{ id: string }>('SELECT id FROM users WHERE username = $1', [m.input.username])).rows[0]!.id);
    const [a, b] = [await idOf(ugandan), await idOf(kenyan)].sort((x, y) => x - y);
    const id = (await app.owner.query<{ public_id: string }>(
      `INSERT INTO chat_conversations (kind, user_a_id, user_b_id) VALUES ('foreign', $1, $2) RETURNING public_id`, [a, b],
    )).rows[0]!.public_id;
    expect((await ugandan.client.get<Body>('/api/chat/conversations')).body.conversations).toEqual([]);
    expect((await ugandan.client.get<Body>(`/api/chat/conversations/${id}`)).status).toBe(404);
    expect((await kenyan.client.post<Body>(`/api/chat/conversations/${id}/messages`, { body: 'hello?' })).status).toBe(404);
    expect((await ugandan.client.post<Body>(`/api/chat/conversations/${id}/claim`, {}, key())).body.error?.code).toBe('chat.foreign_closed');

    // Invite chats keep blocks: the inviter blocks the member, so no messages either way until unblocked.
    const invited = await member({ referralCode: ugandan.input.username });
    const chat = (await invited.client.post<Body>('/api/chat/conversations', { username: ugandan.input.username })).body.conversation.id as string;
    expect((await ugandan.client.post<Body>('/api/chat/blocks', { username: invited.input.username })).status).toBe(201);
    expect((await invited.client.post<Body>(`/api/chat/conversations/${chat}/messages`, { body: 'hello?' })).body.error?.code).toBe('chat.blocked');
    expect((await ugandan.client.delete<Body>(`/api/chat/blocks/${invited.input.username}`)).status).toBe(200);
    expect((await invited.client.post<Body>(`/api/chat/conversations/${chat}/messages`, { body: 'Hi again' })).status).toBe(201);
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
