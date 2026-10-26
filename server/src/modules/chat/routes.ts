import { Router, type Request } from 'express';
import { z } from 'zod';
import { withTransaction } from '../../db/tx.js';
import { limiter } from '../../http/rate-limit.js';
import { parse } from '../../http/validate.js';
import { badRequest } from '../../lib/errors.js';
import type { Services } from '../../services.js';
import { requireActivated, requireAuth } from '../auth/middleware.js';
import { block, listBlocked, listContacts, listConversations, matchForeign, openInviteConversation, readConversation, report, sendMessage, unblock } from './service.js';

const Username = z.strictObject({ username: z.string().trim().min(3, { error: 'Enter a username.' }).max(40) });
const MessageBody = z.strictObject({ body: z.string().trim().min(1, { error: 'Write a message.' }).max(1000, { error: 'Keep messages under 1,000 characters.' }) });
const ReportBody = z.strictObject({ reason: z.string().trim().min(5, { error: 'Say briefly what is wrong.' }).max(500) });
const AfterQuery = z.object({ after: z.coerce.number().int().min(0).default(0) });
const Uuid = z.uuid();

function conversationId(value: unknown): string {
  const id = Uuid.safeParse(value);
  if (!id.success) throw badRequest('validation_failed', 'Unknown chat.');
  return id.data;
}

// Member chat: invite contacts and random matches with members in other countries. See service.ts.
export function chatRouter(services: Services): Router {
  const { pool } = services;
  const router = Router();
  router.use(requireAuth, requireActivated(services));
  const byUser = (req: Request) => `u${req.auth!.userId}`;
  const me = (req: Request) => req.auth!.userId;

  router.get('/contacts', async (req, res) => {
    res.json({ contacts: await listContacts(pool, me(req)) });
  });

  router.get('/conversations', async (req, res) => {
    res.json({ conversations: await listConversations(pool, me(req)) });
  });

  router.post('/conversations', async (req, res) => {
    const { username } = parse(Username, req.body);
    const id = await withTransaction(pool, db => openInviteConversation(db, me(req), username));
    res.status(201).json({ conversation: { id } });
  });

  router.post('/match', limiter(pool, { name: 'chat-match', windowMs: 60 * 60_000, limit: 20, key: byUser }), async (req, res) => {
    const match = await withTransaction(pool, db => matchForeign(db, me(req)));
    res.status(201).json({ conversation: { id: match.conversationId, username: match.username, country: match.country } });
  });

  router.get('/conversations/:id', async (req, res) => {
    const { after } = parse(AfterQuery, req.query);
    res.json(await withTransaction(pool, db => readConversation(db, me(req), conversationId(req.params.id), after)));
  });

  router.post('/conversations/:id/messages', limiter(pool, { name: 'chat-message', windowMs: 60_000, limit: 30, key: byUser }), async (req, res) => {
    const { body } = parse(MessageBody, req.body);
    const message = await withTransaction(pool, db => sendMessage(db, me(req), conversationId(req.params.id), body));
    res.status(201).json({ message });
  });

  router.post('/conversations/:id/report', limiter(pool, { name: 'chat-report', windowMs: 60 * 60_000, limit: 10, key: byUser }), async (req, res) => {
    const { reason } = parse(ReportBody, req.body);
    const id = await withTransaction(pool, db => report(db, me(req), conversationId(req.params.id), reason));
    res.status(201).json({ report: { id } });
  });

  router.get('/blocks', async (req, res) => {
    res.json({ blocked: await listBlocked(pool, me(req)) });
  });

  router.post('/blocks', async (req, res) => {
    const { username } = parse(Username, req.body);
    await withTransaction(pool, db => block(db, me(req), username));
    res.status(201).json({ ok: true });
  });

  router.delete('/blocks/:username', async (req, res) => {
    const { username } = parse(Username, { username: req.params.username });
    await withTransaction(pool, db => unblock(db, me(req), username));
    res.json({ ok: true });
  });

  return router;
}
