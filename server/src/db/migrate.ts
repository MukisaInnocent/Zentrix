import { readdirSync } from 'node:fs';
import { runner } from 'node-pg-migrate';
import { MIGRATIONS_DIR } from '../lib/paths.js';
import type { Logger } from '../lib/logger.js';
import type { AppMode } from '../config/env.js';
import { sslOption, type Pool, type SslMode } from './pool.js';
import { maybeOne, rows } from './sql.js';

// Migrations run as the database owner (never through the restricted app role), all pending files in
// one transaction, under node-pg-migrate's advisory lock.
export async function runMigrations(opts: { url: string; ssl: SslMode; logger: Logger }): Promise<string[]> {
  const applied = await runner({
    databaseUrl: { connectionString: opts.url, ssl: sslOption(opts.ssl) },
    dir: MIGRATIONS_DIR,
    migrationsTable: 'pgmigrations',
    direction: 'up',
    count: Infinity,
    checkOrder: true,
    singleTransaction: true,
    log: (msg: string) => opts.logger.debug({ migrations: true }, msg),
  });
  return applied.map(m => m.name);
}

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .map(f => f.replace(/\.sql$/, ''))
    .sort();
}

export async function pendingMigrations(pool: Pool): Promise<string[]> {
  const done = new Set((await rows<{ name: string }>(pool, 'SELECT name FROM pgmigrations')).map(r => r.name));
  return migrationFiles().filter(f => !done.has(f));
}

// Records whether this database serves test or live (decision D19). The first stamp wins forever.
export async function stampDatabaseMode(pool: Pool, mode: AppMode): Promise<AppMode> {
  await pool.query('INSERT INTO system_meta (database_mode) VALUES ($1) ON CONFLICT (id) DO NOTHING', [mode]);
  const row = await maybeOne<{ database_mode: AppMode }>(pool, 'SELECT database_mode FROM system_meta');
  if (!row) throw new Error('system_meta has no row after stamping');
  return row.database_mode;
}

export async function databaseMode(pool: Pool): Promise<AppMode | null> {
  return (await maybeOne<{ database_mode: AppMode }>(pool, 'SELECT database_mode FROM system_meta'))?.database_mode ?? null;
}
