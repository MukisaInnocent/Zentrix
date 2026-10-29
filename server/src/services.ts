import type { Config } from './config/env.js';
import { createPool, type Pool } from './db/pool.js';
import type { Logger } from './lib/logger.js';
import { createFxSource, type FxSource } from './providers/fx.js';
import { createGeoIp, type GeoIp } from './providers/geoip.js';
import { createGateway, type PaymentGateway } from './providers/livepay.js';
import { createMailer, type Mailer } from './providers/mail.js';
import { createSmsSender, type SmsSender } from './providers/sms.js';

// Everything a request handler or job needs, created once per process and passed explicitly.
export interface Services {
  config: Config;
  logger: Logger;
  pool: Pool;
  mailer: Mailer;
  sms: SmsSender;
  geoip: GeoIp;
  fx: FxSource | null;
  // Mobile-money provider (LivePay or the simulator); null when payments are manual only.
  payments: PaymentGateway | null;
  now: () => Date;
}

export function createServices(config: Config, logger: Logger, overrides: Partial<Services> = {}): Services {
  const pool =
    overrides.pool ??
    createPool({
      url: config.databaseUrl,
      ssl: config.databaseSsl,
      max: config.databasePoolMax,
      appRole: config.databaseAppRole,
      logger,
      connectTimeoutMs: config.databaseConnectTimeoutMs,
    });
  return {
    config,
    logger,
    pool,
    mailer: overrides.mailer ?? createMailer(config, pool),
    sms: overrides.sms ?? createSmsSender(config, pool),
    geoip: overrides.geoip ?? createGeoIp(config),
    fx: overrides.fx !== undefined ? overrides.fx : createFxSource(config),
    payments: overrides.payments !== undefined ? overrides.payments : createGateway(config),
    now: overrides.now ?? (() => new Date()),
  };
}
