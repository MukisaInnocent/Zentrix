import pg from 'pg';
import type { Logger } from '../lib/logger.js';

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
export type SslMode = 'disable' | 'require' | 'verify';

export function sslOption(mode: SslMode): pg.ClientConfig['ssl'] {
  if (mode === 'disable') return false;
  if (mode === 'require') return { rejectUnauthorized: false };
  return { rejectUnauthorized: true };
}

export interface PoolOptions {
  url: string;
  ssl: SslMode;
  max: number;
  appRole: string | null;
  logger: Logger;
  connectTimeoutMs?: number;
  applicationName?: string;
}

// The restricted role is applied as a startup parameter, so a missing or ungranted role fails the
// connection instead of silently running with owner rights (decision D10).
export function createPool(opts: PoolOptions): Pool {
  const startup = ['-c statement_timeout=15000', '-c idle_in_transaction_session_timeout=30000'];
  if (opts.appRole) startup.push(`-c role=${opts.appRole}`);
  const pool = new pg.Pool({
    connectionString: opts.url,
    ssl: sslOption(opts.ssl),
    max: opts.max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: opts.connectTimeoutMs ?? 10_000,
    application_name: opts.applicationName ?? 'zentrix',
    options: startup.join(' '),
  });
  pool.on('error', err => opts.logger.error({ err }, 'idle database client error'));
  return pool;
}
