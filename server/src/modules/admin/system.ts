import { Router } from 'express';
import { z } from 'zod';
import { maybeOne, one, rows } from '../../db/sql.js';
import { withTransaction } from '../../db/tx.js';
import { parse } from '../../http/validate.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { MoneyFormatError, toMinor } from '../../lib/money.js';
import type { Services } from '../../services.js';
import { audit } from '../audit/audit.js';
import { requireStaff } from '../auth/middleware.js';
import { countryConfigHistory, currentCountryConfig, getCountry } from '../countries/service.js';
import { isSettingKey, listSettings, setSetting } from '../settings/registry.js';

const AuditQuery = z.object({
  action: z.string().trim().max(80).optional(),
  target: z.string().trim().max(80).optional(),
  before: z.coerce.number().int().positive().optional(),
});
const SettingBody = z.strictObject({ value: z.unknown(), note: z.string().trim().max(300).optional() });
const Amount = z.string().trim().max(24);
const ConfigBody = z.strictObject({
  membershipFee: Amount,
  withdrawalMin: Amount,
  withdrawalMax: Amount,
  withdrawalDailyMax: Amount,
  withdrawalFeeBp: z.int().min(0).max(2000),
  withdrawalFeeMin: Amount,
  withdrawalApprovalThreshold: Amount,
  newAccountReviewDays: z.int().min(0).max(365),
  vatBp: z.int().min(0).max(5000),
  kycLevelForWithdrawal: z.int().min(0).max(3),
  engagementTasksEnabled: z.boolean(),
  termsVersion: z.string().trim().min(1).max(40),
  privacyVersion: z.string().trim().min(1).max(40),
  isPlaceholder: z.boolean(),
  note: z.string().trim().max(500).optional(),
});
const FlagsBody = z.strictObject({
  blocked: z.boolean().optional(),
  blockReason: z.string().trim().min(3).max(200).nullable().optional(),
  liveEnabled: z.boolean().optional(),
});
const ReviewBody = z.strictObject({ status: z.enum(['dismissed', 'confirmed']), note: z.string().trim().min(3).max(500) });

export function systemRouter(services: Services): Router {
  const { pool, config } = services;
  const router = Router();

  router.get('/audit-log', requireStaff('compliance'), async (req, res) => {
    const q = parse(AuditQuery, req.query);
    const list = await rows(
      pool,
      `SELECT a.id, a.created_at, u.username AS actor, a.actor_roles, a.action, a.target_type, a.target_id, a.before, a.after, a.reason, a.ip, a.request_id
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
       WHERE ($1::text IS NULL OR a.action LIKE $1 || '%') AND ($2::text IS NULL OR a.target_id = $2) AND ($3::bigint IS NULL OR a.id < $3)
       ORDER BY a.id DESC LIMIT 50`,
      [q.action ?? null, q.target ?? null, q.before ?? null],
    );
    res.json({ entries: list });
  });

  router.get('/settings', requireStaff('admin'), async (_req, res) => {
    res.json({ settings: await listSettings(pool) });
  });

  router.put('/settings/:key', requireStaff('admin'), async (req, res) => {
    const key = String(req.params.key);
    if (!isSettingKey(key)) throw notFound('settings.unknown_key', 'Unknown setting.');
    const body = parse(SettingBody, req.body);
    const result = await withTransaction(pool, async db => {
      const before = await maybeOne<{ value: unknown }>(db, 'SELECT value FROM current_settings WHERE key = $1', [key]);
      const saved = await setSetting(db, key, body.value, req.auth!.userId, body.note ?? null);
      await audit(db, req, { action: 'settings.changed', targetType: 'setting', targetId: key, before: before?.value ?? null, after: saved.value, reason: body.note });
      return saved;
    });
    res.json(result);
  });

  router.get('/countries', requireStaff('compliance', 'finance'), async (_req, res) => {
    const list = await rows(
      pool,
      `SELECT c.code, c.name, c.currency_code, c.blocked, c.block_reason, c.live_enabled, cfg.version AS config_version, cfg.is_placeholder,
              cfg.membership_fee_minor::text, cfg.withdrawal_min_minor::text, cfg.withdrawal_max_minor::text, cfg.withdrawal_daily_max_minor::text,
              cfg.withdrawal_fee_bp, cfg.withdrawal_approval_threshold_minor::text,
              (SELECT count(*) FROM users u WHERE u.country_code = c.code)::int AS members
       FROM countries c LEFT JOIN current_country_configs cfg ON cfg.country_code = c.code ORDER BY c.name`,
    );
    res.json({ countries: list });
  });

  router.get('/countries/:code', requireStaff('compliance', 'finance'), async (req, res) => {
    const country = await getCountry(pool, String(req.params.code).toUpperCase());
    if (!country) throw notFound();
    res.json({ country, configHistory: await countryConfigHistory(pool, country.code) });
  });

  // Each edit is a new config version (append-only, section 5b). Amounts arrive as decimal strings in
  // major units and are converted exactly with the currency exponent.
  router.post('/countries/:code/config', requireStaff('admin'), async (req, res) => {
    const country = await getCountry(pool, String(req.params.code).toUpperCase());
    if (!country) throw notFound();
    const body = parse(ConfigBody, req.body);
    const { exponent } = await one<{ exponent: number }>(pool, 'SELECT exponent FROM currencies WHERE code = $1', [country.currencyCode]);
    const amounts = {} as Record<'membershipFee' | 'withdrawalMin' | 'withdrawalMax' | 'withdrawalDailyMax' | 'withdrawalFeeMin' | 'withdrawalApprovalThreshold', bigint>;
    for (const key of ['membershipFee', 'withdrawalMin', 'withdrawalMax', 'withdrawalDailyMax', 'withdrawalFeeMin', 'withdrawalApprovalThreshold'] as const) {
      try {
        amounts[key] = toMinor(body[key], exponent);
      } catch (err) {
        if (err instanceof MoneyFormatError) throw badRequest('validation_failed', err.message, { [key]: [err.message] });
        throw err;
      }
    }
    if (!(amounts.withdrawalMin <= amounts.withdrawalMax && amounts.withdrawalMax <= amounts.withdrawalDailyMax)) {
      const message = 'Limits must rise: minimum, then per-request maximum, then daily.';
      throw badRequest('validation_failed', message, { withdrawalMax: [message] });
    }
    if (amounts.membershipFee <= 0n || amounts.withdrawalMin <= 0n || amounts.withdrawalApprovalThreshold <= 0n) {
      throw badRequest('validation_failed', 'Fee, minimum and approval threshold must be above zero.', { membershipFee: ['Must be above zero.'] });
    }
    const saved = await withTransaction(pool, async db => {
      const before = await currentCountryConfig(db, country.code);
      const row = await one<{ version: number }>(
        db,
        `INSERT INTO country_configs (country_code, version, currency_code, membership_fee_minor, withdrawal_min_minor, withdrawal_max_minor,
           withdrawal_daily_max_minor, withdrawal_fee_bp, withdrawal_fee_min_minor,
           withdrawal_approval_threshold_minor, new_account_review_days, vat_bp, kyc_level_for_withdrawal, engagement_tasks_enabled,
           terms_version, privacy_version, is_placeholder, note, created_by)
         SELECT $1, coalesce(max(version), 0) + 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18
         FROM country_configs WHERE country_code = $1 RETURNING version`,
        [country.code, country.currencyCode, amounts.membershipFee, amounts.withdrawalMin, amounts.withdrawalMax,
          amounts.withdrawalDailyMax, body.withdrawalFeeBp, amounts.withdrawalFeeMin,
          amounts.withdrawalApprovalThreshold, body.newAccountReviewDays, body.vatBp, body.kycLevelForWithdrawal,
          body.engagementTasksEnabled, body.termsVersion, body.privacyVersion, body.isPlaceholder, body.note ?? null, req.auth!.userId],
      );
      const after = await currentCountryConfig(db, country.code);
      await audit(db, req, { action: 'country.config_changed', targetType: 'country', targetId: country.code, before, after, reason: body.note });
      return { version: row.version, config: after };
    });
    res.status(201).json(saved);
  });

  router.post('/countries/:code/flags', requireStaff('admin'), async (req, res) => {
    const country = await getCountry(pool, String(req.params.code).toUpperCase());
    if (!country) throw notFound();
    const body = parse(FlagsBody, req.body);
    const next = {
      blocked: body.blocked ?? country.blocked,
      liveEnabled: body.liveEnabled ?? country.liveEnabled,
      blockReason: body.blockReason === undefined ? undefined : body.blockReason,
    };
    if (next.blocked && next.liveEnabled) throw badRequest('country.blocked_live', 'A blocked country cannot be switched on for live mode.');
    await withTransaction(pool, async db => {
      const before = await one(db, 'SELECT blocked, block_reason, live_enabled FROM countries WHERE code = $1 FOR UPDATE', [country.code]);
      await db.query(
        `UPDATE countries SET blocked = $2, live_enabled = $3, block_reason = CASE WHEN $2 THEN coalesce($4, block_reason) ELSE NULL END WHERE code = $1`,
        [country.code, next.blocked, next.liveEnabled, next.blockReason ?? null],
      );
      const after = await one(db, 'SELECT blocked, block_reason, live_enabled FROM countries WHERE code = $1', [country.code]);
      await audit(db, req, { action: 'country.flags_changed', targetType: 'country', targetId: country.code, before, after });
    });
    res.json({ country: await getCountry(pool, country.code) });
  });

  router.get('/fraud-flags', requireStaff('compliance'), async (req, res) => {
    const { status } = parse(z.object({ status: z.enum(['open', 'dismissed', 'confirmed']).default('open') }), req.query);
    const list = await rows(
      pool,
      `SELECT f.id, f.kind, f.severity, f.details, f.status, f.created_at, f.review_note, u.public_id AS member_id, u.username
       FROM fraud_flags f JOIN users u ON u.id = f.user_id WHERE f.status = $1 ORDER BY f.created_at DESC LIMIT 100`,
      [status],
    );
    res.json({ flags: list });
  });

  router.post('/fraud-flags/:id/review', requireStaff('compliance'), async (req, res) => {
    const id = z.coerce.number().int().positive().safeParse(req.params.id);
    if (!id.success) throw notFound();
    const body = parse(ReviewBody, req.body);
    await withTransaction(pool, async db => {
      const flag = await maybeOne<{ status: string; user_id: string }>(db, 'SELECT status, user_id FROM fraud_flags WHERE id = $1 FOR UPDATE', [id.data]);
      if (!flag) throw notFound();
      if (flag.status !== 'open') throw badRequest('fraud.already_reviewed', 'This flag was already reviewed.');
      await db.query('UPDATE fraud_flags SET status = $2, review_note = $3, reviewed_by = $4, reviewed_at = now() WHERE id = $1', [id.data, body.status, body.note, req.auth!.userId]);
      await audit(db, req, { action: 'fraud_flag.reviewed', targetType: 'fraud_flag', targetId: String(id.data), before: { status: 'open' }, after: { status: body.status }, reason: body.note });
    });
    res.json({ ok: true });
  });

  // Test mode only: read the codes and links that would have been emailed or texted (decision D18).
  router.get('/outbox', requireStaff('support'), async (_req, res) => {
    if (config.appMode !== 'test') throw notFound();
    res.json({ messages: await rows(pool, 'SELECT id, channel, recipient, subject, body, created_at FROM dev_outbox ORDER BY id DESC LIMIT 50') });
  });

  router.get('/go-live', requireStaff('admin'), async (_req, res) => {
    res.json({ appMode: config.appMode, items: await rows(pool, 'SELECT key, label, signed, changed_at FROM go_live_status ORDER BY sort') });
  });

  return router;
}
