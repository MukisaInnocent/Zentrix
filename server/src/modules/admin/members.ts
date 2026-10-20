import { Router, type Request } from 'express';
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/max';
import { z } from 'zod';
import { maybeOne, one, rows } from '../../db/sql.js';
import { withTransaction } from '../../db/tx.js';
import { parse } from '../../http/validate.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import type { Services } from '../../services.js';
import { audit } from '../audit/audit.js';
import { requireStaff } from '../auth/middleware.js';
import { revokeUserSessions } from '../auth/sessions.js';
import { loadProfile } from '../users/profile.js';

const Uuid = z.uuid();
const ReasonSchema = z.strictObject({ reason: z.string().trim().min(5).max(500) });
const PhoneSchema = z.strictObject({
  phone: z.string().trim().min(4).max(32),
  verification: z.string().trim().min(10, { error: 'Describe how you verified the member\'s identity.' }).max(500),
});
const RoleSchema = z.strictObject({ role: z.enum(['member', 'advertiser', 'support', 'reviewer', 'finance', 'compliance', 'admin']), grant: z.boolean() });
const ListQuery = z.object({ q: z.string().trim().max(100).optional(), page: z.coerce.number().int().min(1).max(10_000).default(1) });

const PAGE = 25;
const WITHDRAWAL_LOCK_MS = 48 * 3_600_000;

async function memberId(services: Services, publicId: unknown): Promise<number> {
  const id = Uuid.safeParse(publicId);
  if (!id.success) throw notFound();
  const row = await maybeOne<{ id: string }>(services.pool, 'SELECT id FROM users WHERE public_id = $1', [id.data]);
  if (!row) throw notFound();
  return Number(row.id);
}

function notSelf(req: Request, userId: number): void {
  if (req.auth?.userId === userId) throw forbidden('admin.self_action', 'Another staff member must do this for your own account.');
}

export function membersRouter(services: Services): Router {
  const { pool } = services;
  const router = Router();

  router.get('/', requireStaff('support', 'compliance', 'finance'), async (req, res) => {
    const { q, page } = parse(ListQuery, req.query);
    const term = q ? q.toLowerCase() : null;
    const list = await rows<{
      public_id: string; username: string; email: string; phone_e164: string; country_code: string; status: string;
      created_at: Date; email_verified: boolean; phone_verified: boolean; open_flags: string; roles: string[];
    }>(
      pool,
      `SELECT u.public_id, u.username, u.email, u.phone_e164, u.country_code, u.status, u.created_at,
              u.email_verified_at IS NOT NULL AS email_verified, u.phone_verified_at IS NOT NULL AS phone_verified,
              (SELECT count(*) FROM fraud_flags f WHERE f.user_id = u.id AND f.status = 'open') AS open_flags,
              coalesce((SELECT array_agg(role ORDER BY role) FROM user_roles r WHERE r.user_id = u.id), '{}') AS roles
       FROM users u
       WHERE u.anonymized_at IS NULL AND ($1::text IS NULL OR u.username LIKE $1 || '%' OR u.email LIKE $1 || '%' OR u.phone_e164 LIKE '%' || $1 || '%')
       ORDER BY u.created_at DESC LIMIT $2 OFFSET $3`,
      [term, PAGE + 1, (page - 1) * PAGE],
    );
    res.json({
      page,
      hasMore: list.length > PAGE,
      members: list.slice(0, PAGE).map(m => ({
        id: m.public_id, username: m.username, email: m.email, phone: m.phone_e164, country: m.country_code, status: m.status,
        createdAt: m.created_at, emailVerified: m.email_verified, phoneVerified: m.phone_verified,
        openFlags: Number(m.open_flags), roles: m.roles,
      })),
    });
  });

  router.get('/:id', requireStaff('support', 'compliance', 'finance'), async (req, res) => {
    const userId = await memberId(services, req.params.id);
    const profile = await loadProfile(pool, userId);
    if (!profile) throw notFound();
    const [extra, events, flags, trail] = await Promise.all([
      one<{ status_reason: string | null; withdrawals_locked_until: Date | null; locked_until: Date | null; active_sessions: string }>(
        pool,
        `SELECT status_reason, withdrawals_locked_until, locked_until,
                (SELECT count(*) FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > now()) AS active_sessions
         FROM users u WHERE id = $1`,
        [userId],
      ),
      rows(pool, 'SELECT kind, ip, created_at FROM auth_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20', [userId]),
      rows(pool, 'SELECT id, kind, severity, details, status, created_at FROM fraud_flags WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [userId]),
      rows(pool, `SELECT action, reason, created_at FROM audit_log WHERE target_type = 'user' AND target_id = $1 ORDER BY id DESC LIMIT 20`, [profile.id]),
    ]);
    await audit(pool, req, { action: 'member.viewed', targetType: 'user', targetId: profile.id });
    res.json({
      member: { ...profile, statusReason: extra.status_reason, withdrawalsLockedUntil: extra.withdrawals_locked_until, loginLockedUntil: extra.locked_until, activeSessions: Number(extra.active_sessions) },
      authEvents: events,
      fraudFlags: flags,
      auditTrail: trail,
    });
  });

  for (const action of ['freeze', 'unfreeze'] as const) {
    router.post(`/:id/${action}`, requireStaff('compliance'), async (req, res) => {
      const userId = await memberId(services, req.params.id);
      notSelf(req, userId);
      const { reason } = parse(ReasonSchema, req.body);
      const target = action === 'freeze' ? 'frozen' : 'active';
      await withTransaction(pool, async db => {
        const before = await one<{ public_id: string; status: string }>(db, 'SELECT public_id, status FROM users WHERE id = $1 FOR UPDATE', [userId]);
        if (before.status === 'closed') throw badRequest('admin.member_closed', 'This account is closed.');
        await db.query('UPDATE users SET status = $2, status_reason = $3 WHERE id = $1', [userId, target, reason]);
        await audit(db, req, { action: `member.${action}`, targetType: 'user', targetId: before.public_id, before: { status: before.status }, after: { status: target }, reason });
      });
      res.json({ ok: true });
    });
  }

  // Only an admin changes a member's phone, after verifying identity; withdrawals lock for 48 hours (section 10).
  router.post('/:id/phone', requireStaff('admin'), async (req, res) => {
    const userId = await memberId(services, req.params.id);
    notSelf(req, userId);
    const input = parse(PhoneSchema, req.body);
    const member = await one<{ country_code: string }>(pool, 'SELECT country_code FROM users WHERE id = $1', [userId]);
    const phone = parsePhoneNumberFromString(input.phone, member.country_code as CountryCode);
    if (!phone?.isValid()) throw badRequest('validation_failed', 'Enter a valid mobile number.', { phone: ['Enter a valid mobile number.'] });
    const lockUntil = new Date(services.now().getTime() + WITHDRAWAL_LOCK_MS);
    await withTransaction(pool, async db => {
      const before = await one<{ public_id: string; phone_e164: string }>(db, 'SELECT public_id, phone_e164 FROM users WHERE id = $1 FOR UPDATE', [userId]);
      await db.query(`SELECT set_config('zentrix.admin_change', 'on', true)`);
      await db.query('UPDATE users SET phone_e164 = $2, phone_verified_at = now(), withdrawals_locked_until = $3 WHERE id = $1', [userId, phone.number, lockUntil]);
      await revokeUserSessions(db, userId, 'phone_changed_by_admin');
      await audit(db, req, {
        action: 'member.phone_changed', targetType: 'user', targetId: before.public_id,
        before: { phone: before.phone_e164 }, after: { phone: phone.number, withdrawalsLockedUntil: lockUntil.toISOString() },
        reason: input.verification,
      });
    });
    res.json({ ok: true, withdrawalsLockedUntil: lockUntil });
  });

  router.post('/:id/roles', requireStaff('admin'), async (req, res) => {
    const userId = await memberId(services, req.params.id);
    notSelf(req, userId);
    const { role, grant } = parse(RoleSchema, req.body);
    await withTransaction(pool, async db => {
      const target = await one<{ public_id: string }>(db, 'SELECT public_id FROM users WHERE id = $1', [userId]);
      const changed = grant
        ? await db.query('INSERT INTO user_roles (user_id, role, granted_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [userId, role, req.auth!.userId])
        : await db.query('DELETE FROM user_roles WHERE user_id = $1 AND role = $2', [userId, role]);
      if (changed.rowCount === 1) {
        await revokeUserSessions(db, userId, 'roles_changed');
        await audit(db, req, { action: grant ? 'member.role_granted' : 'member.role_revoked', targetType: 'user', targetId: target.public_id, after: { role } });
      }
    });
    res.json({ ok: true });
  });

  return router;
}
