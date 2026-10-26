import type { Db } from '../../db/sql.js';
import { maybeOne, one, rows } from '../../db/sql.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';

// Member chat (owner, 2026-10-26). Free of charge, never a way to move money. Members see usernames and
// countries only, never phone numbers or email addresses.
//   invite   a member and the person who invited them, or someone they invited directly;
//   foreign  a random activated member from another country ("Random match").
// Either side can block the other; a blocked pair cannot send messages or be matched again.

export type ChatKind = 'invite' | 'foreign';

// Activated members, not frozen or closed, and not staff or system accounts: the only people who can chat.
const CAN_CHAT = `u.anonymized_at IS NULL AND u.status = 'active' AND EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id)
  AND NOT EXISTS (SELECT 1 FROM user_roles ur JOIN roles ro ON ro.name = ur.role WHERE ur.user_id = u.id AND ro.is_staff)`;
const BLOCKED = `EXISTS (SELECT 1 FROM chat_blocks b WHERE (b.blocker_user_id = $1 AND b.blocked_user_id = u.id) OR (b.blocker_user_id = u.id AND b.blocked_user_id = $1))`;

export interface ConversationRow {
  id: string; public_id: string; kind: ChatKind; user_a_id: string; user_b_id: string; a_last_read_id: string; b_last_read_id: string;
}

const pair = (x: number, y: number): [number, number] => (x < y ? [x, y] : [y, x]);

async function blockedBetween(db: Db, x: number, y: number): Promise<boolean> {
  return Boolean(await maybeOne(
    db, 'SELECT 1 FROM chat_blocks WHERE (blocker_user_id = $1 AND blocked_user_id = $2) OR (blocker_user_id = $2 AND blocked_user_id = $1)', [x, y],
  ));
}

// Finds the pair's conversation or starts one. A pair keeps one conversation whichever way it started.
async function conversationFor(db: Db, kind: ChatKind, x: number, y: number): Promise<string> {
  const [a, b] = pair(x, y);
  await db.query(
    `INSERT INTO chat_conversations (kind, user_a_id, user_b_id) VALUES ($1, $2, $3) ON CONFLICT (user_a_id, user_b_id) DO NOTHING`, [kind, a, b],
  );
  return (await one<{ public_id: string }>(db, 'SELECT public_id FROM chat_conversations WHERE user_a_id = $1 AND user_b_id = $2', [a, b])).public_id;
}

// The person who invited the member and the people they invited directly, if they can chat.
export async function listContacts(db: Db, userId: number) {
  const list = await rows<{ id: string; username: string; country_code: string; relation: 'inviter' | 'invited'; conversation_id: string | null; blocked: boolean }>(
    db,
    `SELECT u.id, u.username, u.country_code,
            CASE WHEN u.id = me.referred_by_user_id THEN 'inviter' ELSE 'invited' END AS relation,
            c.public_id AS conversation_id, ${BLOCKED} AS blocked
     FROM users me
     JOIN users u ON (u.id = me.referred_by_user_id OR u.referred_by_user_id = me.id)
     LEFT JOIN chat_conversations c ON c.user_a_id = least(me.id, u.id) AND c.user_b_id = greatest(me.id, u.id)
     WHERE me.id = $1 AND ${CAN_CHAT}
     ORDER BY relation, u.username`,
    [userId],
  );
  return list.map(c => ({ username: c.username, country: c.country_code, relation: c.relation, conversationId: c.conversation_id, blocked: c.blocked }));
}

export async function openInviteConversation(db: Db, userId: number, username: string): Promise<string> {
  const other = await maybeOne<{ id: string }>(
    db,
    `SELECT u.id FROM users me JOIN users u ON (u.id = me.referred_by_user_id OR u.referred_by_user_id = me.id)
     WHERE me.id = $1 AND u.username = $2 AND ${CAN_CHAT}`,
    [userId, username.trim().toLowerCase().replace(/^@/, '')],
  );
  if (!other) throw badRequest('validation_failed', 'You can chat only with the person who invited you and the people you invited.', { username: ['Not one of your invite contacts.'] });
  if (await blockedBetween(db, userId, Number(other.id))) throw forbidden('chat.blocked', 'One of you has blocked the other.');
  return conversationFor(db, 'invite', userId, Number(other.id));
}

// Random match: an activated member from another country, not blocked either way, preferring someone the
// member has not chatted with yet.
export async function matchForeign(db: Db, userId: number): Promise<{ conversationId: string; username: string; country: string }> {
  const match = await maybeOne<{ id: string; username: string; country_code: string }>(
    db,
    `SELECT u.id, u.username, u.country_code FROM users u, users me
     WHERE me.id = $1 AND u.id <> me.id AND u.country_code <> me.country_code AND ${CAN_CHAT} AND NOT ${BLOCKED}
     ORDER BY EXISTS (SELECT 1 FROM chat_conversations c WHERE c.user_a_id = least(me.id, u.id) AND c.user_b_id = greatest(me.id, u.id)), random()
     LIMIT 1`,
    [userId],
  );
  if (!match) throw notFound('chat.no_match', 'Nobody from another country is available right now. Try again later.');
  return { conversationId: await conversationFor(db, 'foreign', userId, Number(match.id)), username: match.username, country: match.country_code };
}

export async function listConversations(db: Db, userId: number) {
  const list = await rows<{
    public_id: string; kind: ChatKind; username: string; country_code: string; last_body: string | null; last_message_at: Date | null; unread: string; blocked: boolean;
  }>(
    db,
    `SELECT c.public_id, c.kind, u.username, u.country_code, c.last_message_at, ${BLOCKED} AS blocked,
            (SELECT left(m.body, 80) FROM chat_messages m WHERE m.conversation_id = c.id ORDER BY m.id DESC LIMIT 1) AS last_body,
            (SELECT count(*) FROM chat_messages m WHERE m.conversation_id = c.id AND m.sender_user_id <> $1
               AND m.id > CASE WHEN c.user_a_id = $1 THEN c.a_last_read_id ELSE c.b_last_read_id END) AS unread
     FROM chat_conversations c JOIN users u ON u.id = CASE WHEN c.user_a_id = $1 THEN c.user_b_id ELSE c.user_a_id END
     WHERE c.user_a_id = $1 OR c.user_b_id = $1
     ORDER BY coalesce(c.last_message_at, c.created_at) DESC LIMIT 100`,
    [userId],
  );
  return list.map(c => ({
    id: c.public_id, kind: c.kind, username: c.username, country: c.country_code, lastMessage: c.last_body, lastMessageAt: c.last_message_at,
    unread: Number(c.unread), blocked: c.blocked,
  }));
}

// A conversation the member is part of (anyone else gets "not found").
export async function findConversation(db: Db, userId: number, publicId: string): Promise<ConversationRow & { other_id: number }> {
  const c = await maybeOne<ConversationRow>(db, 'SELECT * FROM chat_conversations WHERE public_id = $1', [publicId]);
  if (!c || (Number(c.user_a_id) !== userId && Number(c.user_b_id) !== userId)) throw notFound();
  return { ...c, other_id: Number(c.user_a_id) === userId ? Number(c.user_b_id) : Number(c.user_a_id) };
}

export async function messagesOf(db: Db, conversationId: string, afterId = 0) {
  const list = await rows<{ id: string; body: string; created_at: Date; sender_user_id: string; username: string }>(
    db,
    `SELECT m.id, m.body, m.created_at, m.sender_user_id, u.username FROM chat_messages m JOIN users u ON u.id = m.sender_user_id
     WHERE m.conversation_id = $1 AND m.id > $2 ORDER BY m.id DESC LIMIT 200`,
    [conversationId, afterId],
  );
  return list.reverse();
}

// The conversation's messages for one member, marking them read.
export async function readConversation(db: Db, userId: number, publicId: string, afterId = 0) {
  const c = await findConversation(db, userId, publicId);
  const list = await messagesOf(db, c.id, afterId);
  const last = list.at(-1);
  if (last) {
    const col = Number(c.user_a_id) === userId ? 'a_last_read_id' : 'b_last_read_id';
    await db.query(`UPDATE chat_conversations SET ${col} = greatest(${col}, $2) WHERE id = $1`, [c.id, last.id]);
  }
  const other = await one<{ username: string; country_code: string }>(db, 'SELECT username, country_code FROM users WHERE id = $1', [c.other_id]);
  return {
    conversation: { id: c.public_id, kind: c.kind, username: other.username, country: other.country_code, blocked: await blockedBetween(db, userId, c.other_id) },
    messages: list.map(m => ({ id: m.id, body: m.body, createdAt: m.created_at, mine: Number(m.sender_user_id) === userId, username: m.username })),
  };
}

export async function sendMessage(db: Db, userId: number, publicId: string, body: string) {
  const c = await findConversation(db, userId, publicId);
  if (await blockedBetween(db, userId, c.other_id)) throw forbidden('chat.blocked', 'One of you has blocked the other, so messages cannot be sent.');
  const other = await maybeOne(db, `SELECT 1 FROM users u WHERE u.id = $1 AND ${CAN_CHAT}`, [c.other_id]);
  if (!other) throw conflict('chat.unavailable', 'This member cannot receive messages right now.');
  const message = await one<{ id: string; created_at: Date }>(
    db, 'INSERT INTO chat_messages (conversation_id, sender_user_id, body) VALUES ($1, $2, $3) RETURNING id, created_at', [c.id, userId, body],
  );
  const col = Number(c.user_a_id) === userId ? 'a_last_read_id' : 'b_last_read_id';
  await db.query(`UPDATE chat_conversations SET last_message_at = $2, ${col} = $3 WHERE id = $1`, [c.id, message.created_at, message.id]);
  return { id: message.id, body, createdAt: message.created_at, mine: true };
}

async function memberId(db: Db, username: string): Promise<number> {
  const u = await maybeOne<{ id: string }>(db, 'SELECT id FROM users WHERE username = $1 AND anonymized_at IS NULL', [username.trim().toLowerCase().replace(/^@/, '')]);
  if (!u) throw badRequest('validation_failed', 'No member has that username.', { username: ['No member has that username.'] });
  return Number(u.id);
}

export async function block(db: Db, userId: number, username: string): Promise<void> {
  const other = await memberId(db, username);
  if (other === userId) throw badRequest('validation_failed', 'You cannot block yourself.', { username: ['You cannot block yourself.'] });
  await db.query('INSERT INTO chat_blocks (blocker_user_id, blocked_user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, other]);
}

export async function unblock(db: Db, userId: number, username: string): Promise<void> {
  await db.query('DELETE FROM chat_blocks WHERE blocker_user_id = $1 AND blocked_user_id = $2', [userId, await memberId(db, username)]);
}

export async function listBlocked(db: Db, userId: number) {
  return (await rows<{ username: string; created_at: Date }>(
    db, 'SELECT u.username, b.created_at FROM chat_blocks b JOIN users u ON u.id = b.blocked_user_id WHERE b.blocker_user_id = $1 ORDER BY b.created_at DESC', [userId],
  )).map(b => ({ username: b.username, blockedAt: b.created_at }));
}

export async function report(db: Db, userId: number, publicId: string, reason: string): Promise<string> {
  const c = await findConversation(db, userId, publicId);
  const open = await maybeOne(db, `SELECT 1 FROM chat_reports WHERE conversation_id = $1 AND reporter_user_id = $2 AND status = 'open'`, [c.id, userId]);
  if (open) throw conflict('chat.already_reported', 'You have already reported this chat. Our team will look at it.');
  return (await one<{ public_id: string }>(
    db, 'INSERT INTO chat_reports (conversation_id, reporter_user_id, reason) VALUES ($1, $2, $3) RETURNING public_id', [c.id, userId, reason],
  )).public_id;
}
