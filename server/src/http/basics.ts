import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import type { Config } from '../config/env.js';
import { AppError, forbidden } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';

export function requestId() {
  return (req: Request, res: Response, next: NextFunction) => {
    const incoming = req.get('x-request-id');
    req.id = incoming && /^[A-Za-z0-9-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    res.setHeader('X-Request-Id', req.id);
    next();
  };
}

// One line per request: method, path (never the query string), status, duration, user. No bodies.
export function requestLog(logger: Logger) {
  return (req: Request, res: Response, next: NextFunction) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      logger[level](
        { reqId: req.id, method: req.method, path: req.path, status: res.statusCode, ms: Math.round(ms), user: req.auth?.publicId },
        'request',
      );
    });
    next();
  };
}

export function securityHeaders(config: Config) {
  const https = config.publicOrigin.startsWith('https://');
  const csp = helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        ...(https ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    strictTransportSecurity: https ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    crossOriginEmbedderPolicy: false,
  });
  return [
    csp,
    (_req: Request, res: Response, next: NextFunction) => {
      res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
      next();
    },
  ];
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
export const isUnsafe = (method: string) => UNSAFE.has(method);

// State-changing API calls must be JSON (browsers cannot send JSON cross-site without a CORS preflight,
// and no CORS is allowed) and must come from our own origin (section 11).
export function sameOriginJson(config: Config) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!isUnsafe(req.method)) return next();
    if (!req.is('application/json')) return next(new AppError(415, 'unsupported_media_type', 'Send JSON.'));
    const origin = req.get('origin');
    if (origin !== undefined && origin !== config.publicOrigin) return next(forbidden('csrf.origin', 'Cross-origin request blocked.'));
    if (origin === undefined && req.get('sec-fetch-site') === 'cross-site') {
      return next(forbidden('csrf.origin', 'Cross-origin request blocked.'));
    }
    next();
  };
}

export function noStore(_req: Request, res: Response, next: NextFunction) {
  res.setHeader('Cache-Control', 'no-store');
  next();
}
