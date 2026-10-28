import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { rows } from '../../db/sql.js';
import { clearAuthCookies, setAuthCookies } from '../../http/cookies.js';
import { hashKey, limiter } from '../../http/rate-limit.js';
import { parse } from '../../http/validate.js';
import { notFound, unauthorized } from '../../lib/errors.js';
import type { Services } from '../../services.js';
import { notifySignIn } from '../notifications/notify.js';
import { loadProfile } from '../users/profile.js';
import { login, loginWithMfa } from './login.js';
import { requireAuth } from './middleware.js';
import { changePassword, requestPasswordReset, resetPassword } from './password.js';
import { register, type RequestMeta } from './register.js';
import { csrfTokenFor, revokeSession, revokeUserSessions, SESSION_POLICY, TOKEN_PATTERN, type IssuedSession } from './sessions.js';
import { disableTotp, enableTotp, regenerateRecoveryCodes, setupTotp, totpStatus, verifySessionTotp } from './totp-service.js';
import { issueEmailVerification, issuePhoneCode, sendEmailVerification, sendPhoneCode, verifyEmailToken, verifyPhoneCode } from './verification.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export function authRouter(services: Services): Router {
  const { pool, config } = services;
  const router = Router();
  const meta = (req: Request): RequestMeta => ({ ip: req.ip, userAgent: req.get('user-agent'), geoCountry: services.geoip.countryOf(req) });
  const byUser = (req: Request) => (req.auth ? `u${req.auth.userId}` : undefined);
  const bodyField = (name: string) => (req: Request) => {
    const value = (req.body as Record<string, unknown> | undefined)?.[name];
    return typeof value === 'string' && value.length > 0 ? hashKey(value) : undefined;
  };

  async function startSession(req: Request, res: Response, issued: IssuedSession, userId: number, extra: object = {}) {
    if (req.auth) await revokeSession(pool, req.auth.sessionId, 'replaced_by_login');
    setAuthCookies(res, config, issued.token, issued.csrfToken, issued.maxAgeMs);
    res.json({ user: await loadProfile(pool, userId), ...extra });
  }

  router.post('/register', limiter(pool, { name: 'register', windowMs: HOUR, limit: 5 }), async (req, res) => {
    const result = await register(services, req.body, meta(req));
    res.status(201);
    await startSession(req, res, result.session, result.userId);
  });

  router.post(
    '/login',
    limiter(pool, { name: 'login-ip', windowMs: 15 * MINUTE, limit: 20 }),
    limiter(pool, { name: 'login-id', windowMs: 15 * MINUTE, limit: 10, key: bodyField('identifier') }),
    async (req, res) => {
      const result = await login(services, req.body, meta(req));
      if (result.kind === 'mfa') return void res.json({ mfaRequired: true, challengeToken: result.challengeToken, emailSent: result.emailSent });
      await notifySignIn(services, result.userId, req.ip, req.get('user-agent'));
      await startSession(req, res, result.session, result.userId, { mfaEnrollmentRequired: result.mfaEnrollmentRequired });
    },
  );

  router.post('/login/mfa', limiter(pool, { name: 'login-mfa', windowMs: 15 * MINUTE, limit: 10 }), async (req, res) => {
    const result = await loginWithMfa(services, req.body, meta(req));
    await notifySignIn(services, result.userId, req.ip, req.get('user-agent'));
    await startSession(req, res, result.session, result.userId);
  });

  router.post('/logout', async (req, res) => {
    if (req.auth) await revokeSession(pool, req.auth.sessionId, 'logout');
    clearAuthCookies(res, config);
    res.json({ ok: true });
  });

  router.post('/verify/email', limiter(pool, { name: 'verify-email', windowMs: HOUR, limit: 20 }), async (req, res) => {
    const { token } = parse(z.strictObject({ token: z.string().regex(TOKEN_PATTERN) }), req.body);
    await verifyEmailToken(services, token);
    res.json({ ok: true });
  });

  router.post('/verify/email/resend', requireAuth, limiter(pool, { name: 'verify-email-resend', windowMs: HOUR, limit: 3, key: byUser }), async (req, res) => {
    const auth = req.auth!;
    const profile = await loadProfile(pool, auth.userId);
    if (!profile || profile.emailVerified) return void res.json({ ok: true, alreadyVerified: true });
    const token = await issueEmailVerification(pool, auth.userId, profile.email, services.now());
    await sendEmailVerification(services, profile.email, token);
    res.json({ ok: true });
  });

  router.post('/verify/phone', requireAuth, limiter(pool, { name: 'verify-phone', windowMs: HOUR, limit: 10, key: byUser }), async (req, res) => {
    const { code } = parse(z.strictObject({ code: z.string().trim().max(10) }), req.body);
    await verifyPhoneCode(services, req.auth!.userId, code);
    res.json({ ok: true });
  });

  router.post('/verify/phone/resend', requireAuth, limiter(pool, { name: 'verify-phone-resend', windowMs: HOUR, limit: 3, key: byUser }), async (req, res) => {
    const auth = req.auth!;
    const profile = await loadProfile(pool, auth.userId);
    if (!profile || profile.phoneVerified) return void res.json({ ok: true, alreadyVerified: true });
    const code = await issuePhoneCode(pool, config.dataEncryptionKey, auth.userId, profile.phone, services.now());
    await sendPhoneCode(services, profile.phone, code);
    res.json({ ok: true });
  });

  router.post(
    '/password/forgot',
    limiter(pool, { name: 'forgot-ip', windowMs: HOUR, limit: 5 }),
    limiter(pool, { name: 'forgot-email', windowMs: HOUR, limit: 3, key: bodyField('email') }),
    async (req, res) => {
      await requestPasswordReset(services, req.body, req.ip);
      res.status(202).json({ ok: true });
    },
  );

  router.post('/password/reset', limiter(pool, { name: 'reset', windowMs: HOUR, limit: 10 }), async (req, res) => {
    await resetPassword(services, req.body);
    clearAuthCookies(res, config);
    res.json({ ok: true });
  });

  router.post('/password/change', requireAuth, limiter(pool, { name: 'change-password', windowMs: HOUR, limit: 5, key: byUser }), async (req, res) => {
    await changePassword(services, req.auth!.userId, req.auth!.sessionId, req.body);
    res.json({ ok: true });
  });

  router.get('/totp', requireAuth, async (req, res) => {
    res.json(await totpStatus(pool, req.auth!.userId));
  });

  router.post('/totp/setup', requireAuth, limiter(pool, { name: 'totp-setup', windowMs: HOUR, limit: 10, key: byUser }), async (req, res) => {
    res.json(await setupTotp(services, req.auth!));
  });

  const totpLimit = limiter(pool, { name: 'totp-code', windowMs: 15 * MINUTE, limit: 10, key: byUser });
  const refreshCookies = (res: Response, req: Request, token: string | null) => {
    if (token) setAuthCookies(res, config, token, csrfTokenFor(config.csrfSecret, req.auth!.sessionId), remainingMs(req));
  };
  const remainingMs = (req: Request) => (req.auth!.isStaff ? SESSION_POLICY.staff.absoluteMs : SESSION_POLICY.member.absoluteMs);

  router.post('/totp/enable', requireAuth, totpLimit, async (req, res) => {
    const { recoveryCodes, token } = await enableTotp(services, req.auth!, req.body);
    refreshCookies(res, req, token);
    res.json({ ok: true, recoveryCodes });
  });

  router.post('/totp/verify', requireAuth, totpLimit, async (req, res) => {
    refreshCookies(res, req, await verifySessionTotp(services, req.auth!, req.body));
    res.json({ ok: true });
  });

  router.post('/totp/disable', requireAuth, totpLimit, async (req, res) => {
    await disableTotp(services, req.auth!, req.body);
    res.json({ ok: true });
  });

  router.post('/totp/recovery-codes', requireAuth, totpLimit, async (req, res) => {
    res.json({ recoveryCodes: await regenerateRecoveryCodes(services, req.auth!, req.body) });
  });

  router.get('/sessions', requireAuth, async (req, res) => {
    const list = await rows<{ id: string; created_at: Date; last_seen_at: Date; ip: string | null; user_agent: string | null }>(
      pool,
      `SELECT id, created_at, last_seen_at, ip, user_agent FROM sessions
       WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() AND idle_expires_at > now()
       ORDER BY last_seen_at DESC`,
      [req.auth!.userId],
    );
    res.json({
      sessions: list.map(s => ({
        id: s.id, createdAt: s.created_at, lastSeenAt: s.last_seen_at, ip: s.ip, userAgent: s.user_agent,
        current: Number(s.id) === req.auth!.sessionId,
      })),
    });
  });

  router.delete('/sessions/:id', requireAuth, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id)) throw notFound();
    // Ownership check: members can only revoke their own sessions (no IDOR).
    const result = await pool.query(
      `UPDATE sessions SET revoked_at = now(), revoke_reason = 'revoked_by_user' WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [id, req.auth!.userId],
    );
    if (result.rowCount !== 1) throw notFound();
    if (id === req.auth!.sessionId) clearAuthCookies(res, config);
    res.json({ ok: true });
  });

  router.post('/sessions/revoke-others', requireAuth, async (req, res) => {
    if (!req.auth) throw unauthorized();
    res.json({ revoked: await revokeUserSessions(pool, req.auth.userId, 'revoked_by_user', req.auth.sessionId) });
  });

  return router;
}
