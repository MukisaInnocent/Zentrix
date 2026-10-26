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
// Successful health checks and static files (css, js, images, fonts) are logged at debug so the info log shows
// pages and API calls. Failures are always logged.
export function requestLogLevel(path: string, status: number): 'error' | 'warn' | 'info' | 'debug' {
  if (status >= 500) return 'error';
  if (status >= 400) return 'warn';
  if (path === '/healthz' || path === '/readyz') return 'debug';
  if (/\.(css|js|mjs|json|svg|png|jpe?g|webp|gif|ico|woff2?|map|txt)$/i.test(path)) return 'debug';
  return 'info';
}

export function requestLog(logger: Logger) {
  return (req: Request, res: Response, next: NextFunction) => {
    const start = process.hrtime.bigint();
    // The full path as requested. req.path is relative to the router that handled it, which turned
    // /api/wallet/summary into /summary by the time the response finished.
    const path = req.originalUrl.split('?')[0] ?? req.path;
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      logger[requestLogLevel(path, res.statusCode)](
        { reqId: req.id, method: req.method, path, status: res.statusCode, ms: Math.round(ms), user: req.auth?.publicId },
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
    const host = req.get('host');
    const sameHostOrigin = host ? `${req.protocol}://${host}` : undefined;
    const isAllowed = origin === undefined || origin === config.publicOrigin || config.extraOrigins.includes(origin) || origin === sameHostOrigin;
    if (!isAllowed) {
      if (config.appMode === 'test' && origin) {
        try {
          const { hostname } = new URL(origin);
          if (
            hostname === 'localhost' ||
            hostname === '127.0.0.1' ||
            hostname === '[::1]' ||
            /^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
            /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
            /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
            hostname.endsWith('.local')
          ) {
            return next();
          }
        } catch {
          // ignore parsing error
        }
      }
      return next(forbidden('csrf.origin', 'Cross-origin request blocked.'));
    }
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
