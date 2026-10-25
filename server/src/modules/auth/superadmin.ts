import { maybeOne } from '../../db/sql.js';
import { withTransaction } from '../../db/tx.js';
import type { Services } from '../../services.js';
import { createUserDirect } from '../users/create.js';
import { STAFF_ROLES } from './context.js';
import { hashPassword } from './passwords.js';

// Test mode only (owner, 2026-10-25): an easy staff login for trying the site. When TEST_SUPERADMIN_PASSWORD is
// set, the account `superadmin` exists with every staff role and that password, and signs in without the second
// step. Live mode refuses to start while the variable is set (config/env.ts).
export const SUPERADMIN_USERNAME = 'superadmin';

export const superadminEnabled = (services: Services) =>
  services.config.appMode === 'test' && services.config.testSuperadminPassword !== null;

export async function ensureSuperadmin(services: Services): Promise<void> {
  const password = services.config.testSuperadminPassword;
  if (services.config.appMode !== 'test' || !password) return;
  const hash = await hashPassword(password);
  await withTransaction(services.pool, async db => {
    const found = await maybeOne<{ id: string }>(db, 'SELECT id FROM users WHERE username = $1', [SUPERADMIN_USERNAME]);
    const roles = [...STAFF_ROLES, 'member' as const];
    if (!found) {
      await createUserDirect(db, services.config.dataEncryptionKey, {
        username: SUPERADMIN_USERNAME, email: 'superadmin@zentrix.test',
        phone: '+256700990000', country: 'UG', password, roles, verified: true,
      });
      return;
    }
    // Keep the password and roles in step with the environment on every start.
    await db.query('UPDATE users SET password_hash = $2, failed_login_count = 0, locked_until = NULL WHERE id = $1', [found.id, hash]);
    for (const role of roles) await db.query('INSERT INTO user_roles (user_id, role) VALUES ($1, $2) ON CONFLICT DO NOTHING', [found.id, role]);
  });
  services.logger.warn({ username: SUPERADMIN_USERNAME }, 'TEST MODE: super admin login is on (TEST_SUPERADMIN_PASSWORD)');
}
