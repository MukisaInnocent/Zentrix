import { Router, type Request } from 'express';
import { z } from 'zod';
import { maybeOne } from '../../db/sql.js';
import { withTransaction } from '../../db/tx.js';
import { limiter } from '../../http/rate-limit.js';
import { parse } from '../../http/validate.js';
import { notFound } from '../../lib/errors.js';
import type { Services } from '../../services.js';
import { audit } from '../audit/audit.js';
import { requireAuth, requireStaff } from '../auth/middleware.js';
import { idempotent } from '../ledger/idempotency.js';
import { moneyOverview, moveHouse, setCurrency, transfer, walletBalance } from './money.js';
import {
  acceptTerms, adjustBalance, auditTrail, cashout, exportCsv, flags, gameState, getSettings, history, listPlayers, listRequests, listRounds,
  live, placeBet, playerDetail, processRequest, reports, roundDetail, settingsView, transactions, termsStatus, updateSettings, verify,
} from './service.js';

// Aviator (owner's project, 2026-11-06; updated 2026-11-06, later). The same endpoints as the project's /api/game and
// /api/wallet, under /api/aviator, for every signed-in member; the project's admin dashboard is in the staff console
// under /api/admin/aviator (the site's staff accounts are used). Real money since 2026-11-19 (owner): bets, cash-outs
// and transfers move ledger money, so each needs an Idempotency-Key and runs SERIALIZABLE (idempotent()).
const Amount = z.strictObject({ amount: z.union([z.string(), z.number()]) });
const Terms = z.strictObject({ version: z.string().max(20) });
const BetId = z.strictObject({ bet_id: z.union([z.string(), z.number()]) });
const Action = z.strictObject({ action: z.enum(['approve', 'reject']) });
const Settings = z.strictObject({
  betting_seconds: z.number().optional(), crash_display_seconds: z.number().optional(), growth_rate: z.number().optional(),
  house_edge_percent: z.number().optional(), min_bet: z.union([z.string(), z.number()]).optional(),
  max_bet: z.union([z.string(), z.number()]).optional(),
  paused: z.boolean().optional(), pause_message: z.string().max(200).optional(),
  bankroll: z.union([z.string(), z.number(), z.null()]).optional(), bankroll_floor: z.union([z.string(), z.number()]).optional(),
});
const Currency = z.string().regex(/^[A-Z]{3}$/);
const CurrencySettings = z.strictObject({ enabled: z.boolean().optional(), floor: z.union([z.string(), z.number()]).optional() });
const HouseMove = z.strictObject({ currency: Currency, direction: z.enum(['fund', 'return']), amount: z.union([z.string(), z.number()]), reason: z.string().max(200) });
const Adjust = z.strictObject({ mode: z.enum(['add', 'subtract', 'set']), amount: z.union([z.string(), z.number()]), reason: z.string().max(200) });
const Id = z.uuid();
const q = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback);
const RoundId = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export function aviatorRouter(services: Services): Router {
  const { pool } = services;
  const router = Router();
  router.use(requireAuth);
  const me = (req: Request) => req.auth!.userId;
  const byUser = (req: Request) => `u${req.auth!.userId}`;

  router.get('/terms', async (req, res) => {
    res.json(await termsStatus(pool, me(req)));
  });
  router.post('/terms/accept', async (req, res) => {
    const { version } = parse(Terms, req.body);
    res.json(await withTransaction(pool, db => acceptTerms(db, me(req), version)));
  });
  router.get('/game/state', async (req, res) => {
    res.json(await gameState(pool, pool, me(req), services.now()));
  });
  router.get('/game/history', async (_req, res) => {
    res.json(await history(pool));
  });
  router.get('/game/verify/:id', async (req, res) => {
    const id = RoundId.safeParse(req.params.id);
    if (!id.success) throw notFound('aviator.no_round', 'Round not found');
    res.json(await verify(pool, id.data));
  });
  router.post('/game/bet', limiter(pool, { name: 'aviator-bet', windowMs: 60_000, limit: 30, key: byUser }), async (req, res) => {
    const { amount } = parse(Amount, req.body);
    const out = await idempotent(pool, req, 'aviator.bet', async db => ({ status: 200, body: await placeBet(db, me(req), amount, services.now()) }));
    res.status(out.status).json(out.body);
  });
  router.post('/game/cashout', async (req, res) => {
    const { bet_id } = parse(BetId, req.body);
    const out = await idempotent(pool, req, 'aviator.cashout', async db => {
      const result = await cashout(db, me(req), bet_id, services.now());
      if (result.crashed) return { status: 409, body: { error: { code: 'aviator.crashed', message: 'The round crashed before cashout' }, status: 'crashed' } };
      const { crashed: _c, ...body } = result;
      return { status: 200, body };
    });
    res.status(out.status).json(out.body);
  });

  router.get('/wallet/balance', async (req, res) => {
    res.json(await withTransaction(pool, db => walletBalance(db, me(req))));
  });
  // Real money (owner, 2026-11-19): deposit = money in from the deposit balance first, then the main balance;
  // withdraw = money out to the main balance, from which the member withdraws as usual.
  for (const [path, direction] of [['deposit', 'in'], ['withdraw', 'out']] as const) {
    router.post(`/wallet/${path}`, limiter(pool, { name: `aviator-${path}`, windowMs: 60 * 60_000, limit: 60, key: byUser }), async (req, res) => {
      const { amount } = parse(Amount, req.body);
      const out = await idempotent(pool, req, `aviator.transfer_${direction}`, async db => ({ status: 201, body: await transfer(db, me(req), direction, amount) }));
      res.status(out.status).json(out.body);
    });
  }
  router.get('/wallet/transactions', async (req, res) => {
    res.json(await transactions(pool, me(req)));
  });
  return router;
}

// Staff console: the project's admin dashboard. Admins change settings and balances; finance and support look.
export function aviatorAdminRouter(services: Services): Router {
  const { pool } = services;
  const router = Router();
  const VIEW = requireStaff('admin', 'support', 'finance');
  const EDIT = requireStaff('admin');

  router.get('/reports', VIEW, async (req, res) => {
    const days = Math.min(365, Math.max(1, Number.parseInt(q(req.query.days, '30'), 10) || 30));
    res.json(await reports(pool, days));
  });
  router.get('/live', VIEW, async (_req, res) => {
    res.json(await live(pool, services.now()));
  });
  router.get('/rounds', VIEW, async (req, res) => {
    const limit = Math.min(200, Math.max(1, Number.parseInt(q(req.query.limit, '50'), 10) || 50));
    res.json({ rounds: await listRounds(pool, limit) });
  });
  router.get('/rounds/:id', VIEW, async (req, res) => {
    const id = RoundId.safeParse(req.params.id);
    if (!id.success) throw notFound();
    res.json(await roundDetail(pool, id.data));
  });
  router.get('/players', VIEW, async (req, res) => {
    res.json({ players: await listPlayers(pool, q(req.query.q).trim().slice(0, 40)) });
  });
  const userOf = async (raw: unknown) => {
    const id = Id.safeParse(raw);
    if (!id.success) throw notFound();
    const user = await maybeOne<{ id: string }>(pool, 'SELECT id FROM users WHERE public_id = $1', [id.data]);
    if (!user) throw notFound();
    return { id: Number(user.id), publicId: id.data };
  };
  router.get('/players/:id', VIEW, async (req, res) => {
    res.json(await playerDetail(pool, (await userOf(req.params.id)).id));
  });
  router.post('/players/:id/balance', EDIT, async (req, res) => {
    const user = await userOf(req.params.id);
    const { mode, amount, reason } = parse(Adjust, req.body);
    const done = await withTransaction(pool, async db => {
      const result = await adjustBalance(db, req.auth!.userId, user.id, mode, amount, reason);
      await audit(db, req, { action: 'aviator.balance_adjust', targetType: 'user', targetId: user.publicId, before: { balance: result.before }, after: { balance: result.after, mode, amount: result.amount }, reason: result.reason });
      return result;
    });
    res.json({ message: `Balance updated to ${done.after.toFixed(2)}`, balance: done.after });
  });
  router.get('/transactions', VIEW, async (_req, res) => {
    res.json({ requests: await listRequests(pool) });
  });
  // Kept from before credits applied at once: older pending requests can still be approved or rejected.
  router.get('/requests', VIEW, async (_req, res) => {
    res.json({ requests: await listRequests(pool) });
  });
  router.post('/requests/:id/process', requireStaff('admin', 'finance'), async (req, res) => {
    const id = Id.safeParse(req.params.id);
    if (!id.success) throw notFound();
    const { action } = parse(Action, req.body);
    const result = await withTransaction(pool, async db => {
      const done = await processRequest(db, req.auth!.userId, id.data, action);
      await audit(db, req, { action: `aviator.request_${done.status}`, targetType: 'aviator_request', targetId: id.data, after: done });
      return done;
    });
    res.json({ message: `Request ${result.status} successfully`, request: result });
  });
  // Real money: the house money and floor per currency, money moved in and out, stakes, payouts and the company's
  // result (owner, 2026-11-19). Admins switch a currency on, set its floor and move house money.
  router.get('/money', VIEW, async (_req, res) => {
    res.json(await moneyOverview(pool));
  });
  router.put('/currencies/:code', EDIT, async (req, res) => {
    const code = Currency.safeParse(req.params.code);
    if (!code.success) throw notFound();
    const input = parse(CurrencySettings, req.body);
    const done = await withTransaction(pool, async db => {
      const result = await setCurrency(db, req.auth!.userId, code.data, input);
      await audit(db, req, { action: 'aviator.currency_update', targetType: 'aviator_currency', targetId: code.data, before: result.before ?? {}, after: result.after });
      return result;
    });
    res.json({ message: 'Saved', currency: done.after });
  });
  router.post('/house', EDIT, async (req, res) => {
    const input = parse(HouseMove, req.body);
    const out = await idempotent(pool, req, 'aviator.house', async db => {
      const result = await moveHouse(db, req.auth!.userId, input.currency, input.direction, input.amount, input.reason);
      await audit(db, req, { action: `aviator.house_${input.direction}`, targetType: 'aviator_house', targetId: input.currency, before: { house: result.before }, after: { house: result.after, amount: result.amount }, reason: result.reason });
      return { status: 200, body: { message: input.direction === 'fund' ? 'House money added' : 'House money returned to revenue', ...result } };
    });
    res.status(out.status).json(out.body);
  });
  router.get('/flags', VIEW, async (_req, res) => {
    res.json(await flags(pool));
  });
  router.get('/settings', VIEW, async (_req, res) => {
    res.json(settingsView(await getSettings(pool)));
  });
  router.put('/settings', EDIT, async (req, res) => {
    const input = parse(Settings, req.body);
    const result = await withTransaction(pool, async db => {
      const done = await updateSettings(db, req.auth!.userId, input);
      if (done.changed.length) {
        const pick = (v: Record<string, unknown>) => Object.fromEntries(done.changed.map(k => [k, v[k]]));
        await audit(db, req, { action: 'aviator.settings_update', targetType: 'aviator_settings', targetId: '1', before: pick(done.before), after: pick(done.after) });
      }
      return done;
    });
    res.json({ message: result.changed.length ? 'Settings saved' : 'No changes', settings: result.after });
  });
  router.get('/audit', VIEW, async (_req, res) => {
    res.json({ entries: await auditTrail(pool) });
  });
  router.get('/export/:kind', EDIT, async (req, res) => {
    const kind = String(req.params.kind).replace(/\.csv$/, '');
    const out = await withTransaction(pool, async db => {
      const file = await exportCsv(db, kind);
      if (file) await audit(db, req, { action: 'aviator.export', targetType: 'aviator_export', targetId: kind, after: { rows: file.rows } });
      return file;
    });
    if (!out) throw notFound('aviator.no_export', 'Unknown export');
    const stamp = services.now().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="aviator-${kind}-${stamp}.csv"`, 'Cache-Control': 'no-store' });
    res.send(out.csv);
  });
  return router;
}
