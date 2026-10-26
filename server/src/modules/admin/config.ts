import { Router } from 'express';
import { z } from 'zod';
import { maybeOne, rows } from '../../db/sql.js';
import { withTransaction } from '../../db/tx.js';
import { parse } from '../../http/validate.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { MoneyFormatError, toMinor } from '../../lib/money.js';
import type { Services } from '../../services.js';
import { audit } from '../audit/audit.js';
import { requireStaff } from '../auth/middleware.js';
import { chargeBands } from '../payments/withdrawals.js';

// Staff editing of system variables that live outside settings and country configs: the withdrawal charge table
// per currency, and the voucher list. Every change is audited with its before and after.
const Currency = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/);
const Amount = z.string().trim().min(1).max(24);
const ChargesBody = z.strictObject({
  bands: z.array(z.strictObject({ upTo: Amount, charge: Amount })).max(50),
  note: z.string().trim().min(3, { error: 'Say why the charges change.' }).max(300),
});
const VoucherQuery = z.object({
  status: z.enum(['all', 'active', 'redeemed', 'cancelled']).default('all'),
  q: z.string().trim().max(40).optional(),
});

const LeaderboardQuery = z.object({ period: z.enum(['all', '30d', '7d']).default('all') });

const like = (q: string | undefined) => (q ? `%${q.replace(/[%_\\]/g, '\\$&')}%` : null);

export function configAdminRouter(services: Services): Router {
  const { pool } = services;
  const router = Router();

  router.get('/withdrawal-charges/:currency', requireStaff('finance', 'compliance'), async (req, res) => {
    const currency = parse(Currency, req.params.currency);
    res.json({ currency, bands: await chargeBands(pool, currency) });
  });

  // Replaces the whole table for a currency. Bands are listed by their upper limit, each strictly above the last;
  // an empty list means the currency pays its country's minimum fee as the charge.
  router.put('/withdrawal-charges/:currency', requireStaff('admin'), async (req, res) => {
    const currency = parse(Currency, req.params.currency);
    const body = parse(ChargesBody, req.body);
    const cur = await maybeOne<{ exponent: number }>(pool, 'SELECT exponent FROM currencies WHERE code = $1', [currency]);
    if (!cur) throw notFound('currency.unknown', 'Unknown currency.');
    const bands = body.bands.map((b, i) => {
      try {
        return { upTo: toMinor(b.upTo, cur.exponent), charge: toMinor(b.charge, cur.exponent) };
      } catch (err) {
        if (err instanceof MoneyFormatError) throw badRequest('validation_failed', `Row ${i + 1}: ${err.message}`, { bands: [`Row ${i + 1}: ${err.message}`] });
        throw err;
      }
    });
    bands.forEach((b, i) => {
      const fail = (message: string) => badRequest('validation_failed', `Row ${i + 1}: ${message}`, { bands: [`Row ${i + 1}: ${message}`] });
      if (b.upTo <= 0n) throw fail('the limit must be above zero.');
      if (b.charge < 0n) throw fail('the charge cannot be negative.');
      if (i > 0 && b.upTo <= bands[i - 1]!.upTo) throw fail('each limit must be higher than the one before.');
    });
    const result = await withTransaction(pool, async db => {
      const before = await chargeBands(db, currency);
      await db.query('DELETE FROM withdrawal_charges WHERE currency_code = $1', [currency]);
      for (const b of bands) {
        await db.query('INSERT INTO withdrawal_charges (currency_code, up_to_minor, charge_minor) VALUES ($1, $2, $3)', [currency, b.upTo.toString(), b.charge.toString()]);
      }
      const after = await chargeBands(db, currency);
      await audit(db, req, { action: 'withdrawal_charges.changed', targetType: 'currency', targetId: currency, before, after, reason: body.note });
      return after;
    });
    res.json({ currency, bands: result });
  });

  router.get('/vouchers', requireStaff('support', 'finance', 'compliance'), async (req, res) => {
    const q = parse(VoucherQuery, req.query);
    const list = await rows<{ code: string; amount_minor: string; currency_code: string; status: string; created_at: Date; redeemed_at: Date | null; creator: string; used_by: string | null }>(
      pool,
      `SELECT v.code, v.amount_minor, v.currency_code, v.status, v.created_at, v.redeemed_at, c.username AS creator, r.username AS used_by
       FROM vouchers v JOIN users c ON c.id = v.creator_user_id LEFT JOIN users r ON r.id = v.redeemed_by_user_id
       WHERE ($1 = 'all' OR v.status = $1) AND ($2::text IS NULL OR v.code ILIKE $2 OR c.username ILIKE $2 OR r.username ILIKE $2)
       ORDER BY v.created_at DESC LIMIT 200`,
      [q.status, like(q.q)],
    );
    res.json({
      vouchers: list.map(v => ({
        code: v.code, amountMinor: v.amount_minor, currency: v.currency_code, status: v.status === 'redeemed' ? 'used' : v.status,
        createdAt: v.created_at, usedAt: v.redeemed_at, creator: v.creator, usedBy: v.used_by,
      })),
    });
  });

  // Staff-only referral report (owner, 2026-10-26): members ranked by the people they invited directly who
  // activated. Staff and system accounts (including superadmin) are left out. Members never see it, and it pays
  // no prize (rule 3.3: no member-facing contests or leaderboards ranked by recruiting).
  router.get('/leaderboard/referrals', requireStaff('support', 'finance', 'compliance'), async (req, res) => {
    const { period } = parse(LeaderboardQuery, req.query);
    const since = period === '30d' ? "now() - interval '30 days'" : period === '7d' ? "now() - interval '7 days'" : "'-infinity'::timestamptz";
    const list = await rows<{ username: string; phone_e164: string | null; country_code: string; currency_code: string; invited: string; activated: string; rewards: string }>(
      pool,
      `SELECT u.username, u.phone_e164, u.country_code, u.currency_code,
              count(i.id) FILTER (WHERE i.created_at > ${since}) AS invited,
              count(m.user_id) FILTER (WHERE m.activated_at > ${since}) AS activated,
              coalesce((SELECT sum(r.amount_minor) FROM referral_rewards r WHERE r.referrer_user_id = u.id AND r.status = 'credited' AND r.created_at > ${since}), 0)::text AS rewards
       FROM users u
       JOIN users i ON i.referred_by_user_id = u.id
       LEFT JOIN memberships m ON m.user_id = i.id
       WHERE u.anonymized_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM user_roles ur JOIN roles ro ON ro.name = ur.role WHERE ur.user_id = u.id AND ro.is_staff)
       GROUP BY u.id
       HAVING count(i.id) FILTER (WHERE i.created_at > ${since}) > 0
       ORDER BY activated DESC, invited DESC, rewards DESC, u.username
       LIMIT 100`,
    );
    res.json({
      period,
      leaders: list.map((l, i) => ({
        rank: i + 1, username: l.username, phone: l.phone_e164, country: l.country_code, invited: Number(l.invited), activated: Number(l.activated),
        rewardsMinor: l.rewards, currency: l.currency_code,
      })),
    });
  });

  return router;
}
