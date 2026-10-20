import type { QueryResultRow } from 'pg';
import type { Pool, PoolClient } from './pool.js';

export type Db = Pool | PoolClient;

export async function rows<R extends QueryResultRow>(db: Db, text: string, values: unknown[] = []): Promise<R[]> {
  return (await db.query<R>(text, values)).rows;
}

export async function maybeOne<R extends QueryResultRow>(db: Db, text: string, values: unknown[] = []): Promise<R | null> {
  const result = await rows<R>(db, text, values);
  if (result.length > 1) throw new Error(`Expected at most one row, got ${result.length}`);
  return result[0] ?? null;
}

export async function one<R extends QueryResultRow>(db: Db, text: string, values: unknown[] = []): Promise<R> {
  const result = await rows<R>(db, text, values);
  if (result.length !== 1 || result[0] === undefined) throw new Error(`Expected one row, got ${result.length}`);
  return result[0];
}
