import type { NextFunction, Request, Response } from 'express';
import { maybeOne } from '../../db/sql.js';
import { clearAuthCookies, cookieNames, readCookie, setAuthCookies } from '../../http/cookies.js';
import { isUnsafe } from '../../http/basics.js';
import { safeEqual } from '../../lib/crypto.js';
import { forbidden, unauthorized } from '../../lib/errors.js';
import type { Services } from '../../services.js';
import type { StaffRole } from './context.js';
import { findSession, rotateSession, SESSION_POLICY, TOKEN_PATTERN, touchSession } from './sessions.js';

// Attaches req.auth when the session cookie is valid; refreshes the idle timer and rotates the token on
// schedule. An invalid cookie is cleared; routes that need a session answer 401.
export function loadSession(services: Services) {
  const { config, pool } = services;
  const names = cookieNames(config);
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = readCookie(req, names.session);
    if (token === undefined) return next();
    if (!TOKEN_PATTERN.test(token)) {
      clearAuthCookies(res, config);
      return next();
    }
    const now = services.now();
    const found = await findSession(pool, config.csrfSecret, token, now);
    if (!found) {
      clearAuthCookies(res, config);
      return next();
    }
    req.auth = found.context;
    if (!found.matchedCurrent) return next();
    const policy = found.context.isStaff ? SESSION_POLICY.staff : SESSION_POLICY.member;
    if (now.getTime() - found.rotatedAt.getTime() > policy.rotateMs) {
      const fresh = await rotateSession(pool, found.context.sessionId, now);
      if (fresh) setAuthCookies(res, config, fresh, found.context.csrfToken, found.expiresAt.getTime() - now.getTime());
    } else if (now.getTime() - found.lastSeenAt.getTime() > SESSION_POLICY.touchMs) {
      await touchSession(pool, found.context.sessionId, found.context.isStaff, now);
    }
    next();
  };
}

// Double-submit CSRF token bound to the session (decision D12). Required on every state-changing call
// made with a session.
export function csrfProtection() {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!isUnsafe(req.method) || !req.auth) return next();
    const header = req.get('x-csrf-token') ?? '';
    if (!safeEqual(Buffer.from(header), Buffer.from(req.auth.csrfToken))) {
      return next(forbidden('csrf.invalid', 'Your session check failed. Refresh the page and try again.'));
    }
    next();
  };
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  next(req.auth ? undefined : unauthorized());
}

// Staff tools need one of the listed roles (admin always qualifies) and a TOTP-verified session.
export function requireStaff(...allowed: StaffRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const auth = req.auth;
    if (!auth) return next(unauthorized());
    if (!auth.roles.some(r => r === 'admin' || (allowed as string[]).includes(r))) return next(forbidden());
    if (!auth.mfaVerified) {
      return next(forbidden('auth.mfa_required', 'Confirm your authenticator code to use staff tools.'));
    }
    next();
  };
}

// Members use the site only after their activation fee is confirmed (owner, 2026-10-25). Staff are not gated.
export function requireActivated(services: Services) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (!req.auth) return next(unauthorized());
      if (req.auth.isStaff) return next();
      const active = await maybeOne(services.pool, 'SELECT 1 FROM memberships WHERE user_id = $1', [req.auth.userId]);
      next(active ? undefined : forbidden('activation.required', 'Pay the activation fee to use this.'));
    } catch (err) {
      next(err);
    }
  };
}
