import type { NextFunction, Request, Response } from 'express';
import { ipKeyGenerator, rateLimit, type ClientRateLimitInfo, type Options, type Store } from 'express-rate-limit';
import type { Pool } from '../db/pool.js';
import { sha256 } from '../lib/crypto.js';
import { tooManyRequests } from '../lib/errors.js';

// Counters live in Postgres so limits hold across several web instances (decision D14).
export class PgRateLimitStore implements Store {
  private windowMs = 60_000;
  constructor(private readonly pool: Pool, readonly prefix: string) {}

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const { rows } = await this.pool.query<{ hits: number; reset_at: Date }>(
      `INSERT INTO rate_limits (key, hits, reset_at) VALUES ($1, 1, now() + $2 * interval '1 millisecond')
       ON CONFLICT (key) DO UPDATE SET
         hits = CASE WHEN rate_limits.reset_at <= now() THEN 1 ELSE rate_limits.hits + 1 END,
         reset_at = CASE WHEN rate_limits.reset_at <= now() THEN now() + $2 * interval '1 millisecond' ELSE rate_limits.reset_at END
       RETURNING hits, reset_at`,
      [`${this.prefix}:${key}`, this.windowMs],
    );
    const row = rows[0];
    return { totalHits: row?.hits ?? 1, resetTime: row?.reset_at };
  }

  async decrement(key: string): Promise<void> {
    await this.pool.query('UPDATE rate_limits SET hits = greatest(hits - 1, 0) WHERE key = $1', [`${this.prefix}:${key}`]);
  }

  async resetKey(key: string): Promise<void> {
    await this.pool.query('DELETE FROM rate_limits WHERE key = $1', [`${this.prefix}:${key}`]);
  }
}

export interface LimitSpec {
  name: string;
  windowMs: number;
  limit: number;
  // Defaults to the client IP. Account keys are hashed so no personal data lands in rate_limits.
  key?: (req: Request) => string | undefined;
}

export const hashKey = (value: string) => sha256(value.trim().toLowerCase()).toString('hex').slice(0, 32);

export function limiter(pool: Pool, spec: LimitSpec) {
  return rateLimit({
    windowMs: spec.windowMs,
    limit: spec.limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    store: new PgRateLimitStore(pool, spec.name),
    keyGenerator: req => spec.key?.(req) ?? ipKeyGenerator(req.ip ?? 'unknown'),
    handler: (_req: Request, _res: Response, next: NextFunction) => next(tooManyRequests()),
  });
}
