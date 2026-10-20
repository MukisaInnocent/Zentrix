import { setTimeout as sleep } from 'node:timers/promises';
import { DB_ERRORS, pgErrorCode } from '../lib/errors.js';
import type { Pool, PoolClient } from './pool.js';

export type Isolation = 'read committed' | 'repeatable read' | 'serializable';

export interface TxOptions {
  isolation?: Isolation;
  maxRetries?: number;
}

// Runs fn in one transaction. SERIALIZABLE transactions retry on serialization failures and deadlocks
// with jittered backoff, so fn must not have side effects outside the database (decision D11).
export async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>, opts: TxOptions = {}): Promise<T> {
  const isolation = opts.isolation ?? 'read committed';
  const maxRetries = opts.maxRetries ?? (isolation === 'serializable' ? 8 : 0);
  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect();
    let broken: Error | undefined;
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${isolation.toUpperCase()}`);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        broken = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr));
      }
      const code = pgErrorCode(err);
      const retryable = code === DB_ERRORS.serializationFailure || code === DB_ERRORS.deadlockDetected;
      if (!retryable || attempt >= maxRetries) throw err;
    } finally {
      client.release(broken);
    }
    await sleep(Math.min(200, 5 * 2 ** attempt) + Math.random() * 10);
  }
}
