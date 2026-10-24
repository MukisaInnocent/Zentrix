import type { Request } from 'express';
import type { Pool, PoolClient } from '../../db/pool.js';
import { maybeOne } from '../../db/sql.js';
import { withTransaction } from '../../db/tx.js';
import { sha256 } from '../../lib/crypto.js';
import { badRequest, conflict, DB_ERRORS, pgErrorCode } from '../../lib/errors.js';

export interface StoredResponse {
  status: number;
  body: Record<string, unknown>;
}

const KEY = /^[A-Za-z0-9_-]{16,80}$/;

// Money operations: SERIALIZABLE, retried on serialization failures and deadlocks (decision D11).
export const moneyTx = <T>(pool: Pool, fn: (db: PoolClient) => Promise<T>) => withTransaction(pool, fn, { isolation: 'serializable' });

// Every money-moving POST carries an Idempotency-Key. The response is stored in the same transaction as the
// money change, so a replay returns it unchanged and a crash cannot leave a half-recorded result. Errors are
// not stored: nothing moved, so the same key may be retried.
export async function idempotent(pool: Pool, req: Request, scope: string, fn: (db: PoolClient) => Promise<StoredResponse>): Promise<StoredResponse> {
  const key = req.get('idempotency-key') ?? '';
  if (!KEY.test(key)) throw badRequest('idempotency.missing', 'This request needs an Idempotency-Key header.');
  const userId = req.auth!.userId;
  const hash = sha256(`${scope}\n${JSON.stringify(req.body ?? {})}`).toString('hex');
  for (let attempt = 0; ; attempt++) {
    try {
      return await moneyTx(pool, async db => {
        const prior = await maybeOne<{ scope: string; request_hash: string; response_status: number; response_body: Record<string, unknown> }>(
          db, 'SELECT scope, request_hash, response_status, response_body FROM idempotency_keys WHERE user_id = $1 AND key = $2', [userId, key],
        );
        if (prior) {
          if (prior.scope !== scope || prior.request_hash !== hash) {
            throw conflict('idempotency.mismatch', 'This Idempotency-Key was already used for a different request.');
          }
          return { status: prior.response_status, body: prior.response_body };
        }
        const result = await fn(db);
        await db.query(
          'INSERT INTO idempotency_keys (user_id, key, scope, request_hash, response_status, response_body) VALUES ($1, $2, $3, $4, $5, $6)',
          [userId, key, scope, hash, result.status, JSON.stringify(result.body)],
        );
        return result;
      });
    } catch (err) {
      // Two identical requests raced and the other one committed first: read its stored response.
      if (attempt === 0 && pgErrorCode(err) === DB_ERRORS.uniqueViolation) continue;
      throw err;
    }
  }
}
