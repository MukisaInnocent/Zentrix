import path from 'node:path';
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { pendingMigrations } from './db/migrate.js';
import { noStore, requestId, requestLog, sameOriginJson, securityHeaders } from './http/basics.js';
import { errorHandler } from './http/errors.js';
import { limiter } from './http/rate-limit.js';
import { notFound } from './lib/errors.js';
import { WEB_DIR } from './lib/paths.js';
import { adminRouter } from './modules/admin/routes.js';
import { csrfProtection, loadSession } from './modules/auth/middleware.js';
import { authRouter } from './modules/auth/routes.js';
import { metaRouter, referenceRouter } from './modules/countries/routes.js';
import { referralsRouter } from './modules/referrals/routes.js';
import { tasksRouter } from './modules/tasks/routes.js';
import { meRouter } from './modules/users/routes.js';
import { clientPaymentsRouter, vouchersRouter } from './modules/vouchers/routes.js';
import { walletRouter } from './modules/wallet/routes.js';
import type { Services } from './services.js';

export function createApp(services: Services): express.Express {
  const { config, logger, pool } = services;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(requestId());
  app.use(requestLog(logger));
  app.use(securityHeaders(config));

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.get('/readyz', async (_req, res) => {
    try {
      const pending = await pendingMigrations(pool);
      if (pending.length > 0) return void res.status(503).json({ status: 'pending_migrations' });
      res.json({ status: 'ready', mode: config.appMode });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });

  const api = Router();
  api.use(noStore);
  api.use(sameOriginJson(config));
  api.use(express.json({ limit: '32kb', type: 'application/json' }));
  api.use(limiter(pool, { name: 'api-ip', windowMs: 60_000, limit: 300 }));
  api.use(loadSession(services));
  api.use(csrfProtection());
  api.use('/auth', authRouter(services));
  api.use('/me', meRouter(services));
  api.use('/reference', referenceRouter(services));
  api.use('/meta', metaRouter(services));
  api.use('/admin', adminRouter(services));
  api.use('/wallet', walletRouter(services));
  api.use('/membership', walletRouter(services));
  api.use('/referrals', referralsRouter(services));
  api.use('/team', referralsRouter(services));
  api.use('/tasks', tasksRouter(services));
  api.use('/vouchers', vouchersRouter(services));
  api.use('/client-payments', clientPaymentsRouter(services));
  api.use((_req: Request, _res: Response, next: NextFunction) => next(notFound('api.not_found', 'API endpoint not found.')));
  app.use('/api', api);

  // Staff pages are static, but only staff sessions may load them (defence in depth; the API checks too).
  app.use('/admin', loadSession(services), (req: Request, res: Response, next: NextFunction) => {
    if (req.auth?.isStaff) return next();
    res.redirect(302, `/login.html?next=${encodeURIComponent(req.originalUrl)}`);
  });
  app.use(
    express.static(WEB_DIR, {
      extensions: ['html'],
      index: 'index.html',
      dotfiles: 'ignore',
      setHeaders: res => res.setHeader('Cache-Control', 'no-cache'),
    }),
  );
  app.use((req: Request, res: Response) => {
    if (req.method === 'GET' && req.accepts('html')) return void res.status(404).sendFile(path.join(WEB_DIR, '404.html'));
    res.status(404).json({ error: { code: 'not_found', message: 'Not found.' } });
  });
  app.use(errorHandler(logger));
  return app;
}
