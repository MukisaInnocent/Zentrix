import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../../db/sql.js';
import { maybeOne, one, rows } from '../../db/sql.js';
import { withTransaction } from '../../db/tx.js';
import { parse } from '../../http/validate.js';
import { notFound } from '../../lib/errors.js';
import type { Services } from '../../services.js';
import { audit } from '../audit/audit.js';
import { requireActivated, requireAuth, requireStaff } from '../auth/middleware.js';

// Betting tips (owner, 2026-11-06): admins post football tips and later mark the result; activated members read
// them. Tips only: nothing is staked or paid on the site. Every change is audited.

interface TipRow {
  public_id: string; league: string; home_team: string; away_team: string; kickoff_at: Date; tip: string; odds: string | null;
  note: string; result: string; score: string; published: boolean; created_at: Date; removed_at: Date | null;
}
const COLUMNS = 'public_id, league, home_team, away_team, kickoff_at, tip, odds::text AS odds, note, result, score, published, created_at, removed_at';

const memberView = (t: TipRow) => ({
  id: t.public_id, league: t.league, homeTeam: t.home_team, awayTeam: t.away_team, kickoffAt: t.kickoff_at, tip: t.tip, odds: t.odds,
  note: t.note, result: t.result, score: t.score,
});
const staffView = (t: TipRow) => ({ ...memberView(t), published: t.published, createdAt: t.created_at, removedAt: t.removed_at });

const TipBody = z.strictObject({
  league: z.string().trim().max(80).default(''),
  homeTeam: z.string().trim().min(1).max(80),
  awayTeam: z.string().trim().min(1).max(80),
  kickoffAt: z.iso.datetime({ offset: true, error: 'Give the kick-off date and time.' }),
  tip: z.string().trim().min(1, { error: 'Write the tip, for example "Home win" or "Over 2.5 goals".' }).max(80),
  odds: z.string().trim().regex(/^\d{1,5}(\.\d{1,2})?$/, { error: 'Odds like 1.85.' }).nullable().optional(),
  note: z.string().trim().max(300).default(''),
  result: z.enum(['pending', 'won', 'lost', 'void']).default('pending'),
  score: z.string().trim().max(20).default(''),
  published: z.boolean().default(true),
});
const Id = z.uuid();
const tipId = (value: unknown) => {
  const id = Id.safeParse(value);
  if (!id.success) throw notFound();
  return id.data;
};

async function lockTip(db: Db, id: string): Promise<TipRow> {
  const row = await maybeOne<TipRow>(db, `SELECT ${COLUMNS} FROM betting_tips WHERE public_id = $1 FOR UPDATE`, [id]);
  if (!row) throw notFound();
  return row;
}

// Members: upcoming tips first, then the last 14 days of results.
export function tipsRouter(services: Services): Router {
  const router = Router();
  router.use(requireAuth, requireActivated(services));
  router.get('/', async (_req, res) => {
    const list = await rows<TipRow>(
      services.pool,
      `SELECT ${COLUMNS} FROM betting_tips
       WHERE published AND removed_at IS NULL AND kickoff_at > now() - interval '14 days'
       ORDER BY (result = 'pending') DESC, CASE WHEN result = 'pending' THEN kickoff_at END ASC, kickoff_at DESC LIMIT 200`,
    );
    res.json({ tips: list.map(memberView) });
  });
  return router;
}

export function tipsAdminRouter(services: Services): Router {
  const { pool } = services;
  const router = Router();

  router.get('/', requireStaff('admin', 'support'), async (req, res) => {
    const removed = req.query.removed === '1';
    const list = await rows<TipRow>(pool, `SELECT ${COLUMNS} FROM betting_tips WHERE ($1 OR removed_at IS NULL) ORDER BY kickoff_at DESC LIMIT 300`, [removed]);
    res.json({ tips: list.map(staffView) });
  });

  const values = (b: z.infer<typeof TipBody>) => [b.league, b.homeTeam, b.awayTeam, b.kickoffAt, b.tip, b.odds ?? null, b.note, b.result, b.score, b.published];

  router.post('/', requireStaff('admin'), async (req, res) => {
    const body = parse(TipBody, req.body);
    const tip = await withTransaction(pool, async db => {
      const row = await one<TipRow>(
        db,
        `INSERT INTO betting_tips (league, home_team, away_team, kickoff_at, tip, odds, note, result, score, published, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING ${COLUMNS}`,
        [...values(body), req.auth!.userId],
      );
      await audit(db, req, { action: 'tip.created', targetType: 'betting_tip', targetId: row.public_id, after: staffView(row) });
      return staffView(row);
    });
    res.status(201).json({ tip });
  });

  router.put('/:id', requireStaff('admin'), async (req, res) => {
    const id = tipId(req.params.id);
    const body = parse(TipBody, req.body);
    const tip = await withTransaction(pool, async db => {
      const before = await lockTip(db, id);
      const row = await one<TipRow>(
        db,
        `UPDATE betting_tips SET league = $2, home_team = $3, away_team = $4, kickoff_at = $5, tip = $6, odds = $7, note = $8, result = $9,
           score = $10, published = $11 WHERE public_id = $1 RETURNING ${COLUMNS}`,
        [id, ...values(body)],
      );
      await audit(db, req, { action: 'tip.updated', targetType: 'betting_tip', targetId: id, before: staffView(before), after: staffView(row) });
      return staffView(row);
    });
    res.json({ tip });
  });

  for (const action of ['remove', 'restore'] as const) {
    router.post(`/:id/${action}`, requireStaff('admin'), async (req, res) => {
      const id = tipId(req.params.id);
      const tip = await withTransaction(pool, async db => {
        const before = await lockTip(db, id);
        const row = await one<TipRow>(
          db, `UPDATE betting_tips SET removed_at = ${action === 'remove' ? 'coalesce(removed_at, now())' : 'NULL'} WHERE public_id = $1 RETURNING ${COLUMNS}`, [id],
        );
        await audit(db, req, { action: `tip.${action === 'remove' ? 'removed' : 'restored'}`, targetType: 'betting_tip', targetId: id, before: staffView(before), after: staffView(row) });
        return staffView(row);
      });
      res.json({ tip });
    });
  }
  return router;
}
