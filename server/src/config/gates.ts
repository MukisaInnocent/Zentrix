import { databaseMode, pendingMigrations } from '../db/migrate.js';
import type { Pool } from '../db/pool.js';
import { goLiveStatus } from '../modules/golive/service.js';
import { ConfigError, type Config } from './env.js';

// Start-up gates that need the database (section 0, decision D19 and D20). Both the web and worker
// processes call this before serving anything.
export async function assertStartupGates(config: Config, pool: Pool): Promise<void> {
  const pending = await pendingMigrations(pool).catch(() => ['(migrations table missing)']);
  if (pending.length > 0) throw new ConfigError(`Database has pending migrations: ${pending.join(', ')}. Run npm run migrate.`);
  const mode = await databaseMode(pool);
  if (mode === null) throw new ConfigError('Database has no mode stamp. Run npm run migrate.');
  if (mode !== config.appMode) {
    throw new ConfigError(`This database is stamped "${mode}" but APP_MODE is "${config.appMode}". A ${config.appMode} server refuses it.`);
  }
  if (config.appMode === 'live') {
    const unsigned = (await goLiveStatus(pool)).filter(i => !i.signed);
    if (unsigned.length > 0) {
      throw new ConfigError(`Live mode refuses to start until the go-live checklist is signed off. Unsigned: ${unsigned.map(i => i.key).join(', ')}.`);
    }
  }
}
