import { existsSync } from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { loadConfig, type Config } from './config/env.js';
import { runMigrations, stampDatabaseMode } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { createLogger, type Logger } from './lib/logger.js';
import { ROOT_DIR } from './lib/paths.js';

// Loads .env when present (local development only; platforms inject real environment variables).
export function loadEnvFile(): void {
  const file = path.join(ROOT_DIR, '.env');
  if (existsSync(file)) dotenv.config({ path: file, quiet: true });
}

export function boot(service: string): { config: Config; logger: Logger } {
  loadEnvFile();
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel, mode: config.appMode, service });
  return { config, logger };
}

// Migrations and the mode stamp run as the database owner, never through the restricted app role.
export async function migrateAndStamp(config: Config, logger: Logger): Promise<string[]> {
  const applied = await runMigrations({ url: config.databaseUrl, ssl: config.databaseSsl, logger });
  const owner = createPool({ url: config.databaseUrl, ssl: config.databaseSsl, max: 1, appRole: null, logger });
  try {
    const stamped = await stampDatabaseMode(owner, config.appMode);
    if (stamped !== config.appMode) throw new Error(`Database is stamped ${stamped}; refusing to use it in ${config.appMode} mode.`);
  } finally {
    await owner.end();
  }
  return applied;
}
