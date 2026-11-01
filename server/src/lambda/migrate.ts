import { boot, migrateAndStamp } from '../bootstrap.js';
import { createServices } from '../services.js';

// AWS Lambda entry the deploy pipeline invokes (the database is private, so GitHub Actions cannot reach it):
//   { "action": "migrate" }  applies pending migrations as the database owner and checks the mode stamp;
//   { "action": "seed" }     adds the fake test data, only in test mode on a test database.
//   { "action": "livepay-trial-reset", "accountNumber": "LP..." }  staging LivePay trial (owner, 2026-10-30): keeps
//                            only the LivePay method and freezes every non-staff member. Test mode only.
//   { "action": "golive-status" }  the go-live checklist (section 0, D20).
//   { "action": "admin-create", username, email, phone, country, password }  the first admin on a fresh database
//                            (refused once an active admin exists); returns its authenticator secret, once.
//   { "action": "golive-sign" | "golive-revoke", item, username, password, code, note }  an admin signs an item.
// infra/scripts/golive.ps1 sends the bootstrap commands; their passwords are never logged. Runs inside the VPC.
interface MigrateEvent {
  action?: string; accountNumber?: string;
  username?: string; email?: string; phone?: string; country?: string; password?: string; item?: string; code?: string; note?: string;
}

export async function handler(event: MigrateEvent): Promise<Record<string, unknown>> {
  const { config, logger } = boot('pexa-migrate');
  if (event.action === 'golive-status' || event.action === 'admin-create' || event.action === 'golive-sign' || event.action === 'golive-revoke') {
    const services = createServices(config, logger);
    try {
      const tools = await import('../modules/golive/admin-tools.js');
      if (event.action === 'admin-create') {
        if (await tools.hasActiveAdmin(services.pool)) throw new Error('An admin already exists; add staff from the staff console.');
        const created = await tools.createStaffAccount(services, {
          username: event.username ?? '', email: event.email ?? '', phone: event.phone ?? '', country: event.country ?? 'UG', role: 'admin', password: event.password ?? '',
        });
        logger.info({ publicId: created.publicId }, 'first admin created');
        return { action: 'admin-create', ...created };
      }
      if (event.action !== 'golive-status') {
        const command = event.action === 'golive-sign' ? 'sign' : 'revoke';
        await tools.signGoLiveItem(services.pool, config.dataEncryptionKey, {
          command, item: event.item ?? '', username: event.username ?? '', password: event.password ?? '', code: event.code ?? '', note: event.note || null,
        });
        logger.info({ item: event.item, command }, 'go-live item changed');
      }
      const { goLiveStatus } = await import('../modules/golive/service.js');
      return { action: event.action, items: await goLiveStatus(services.pool) };
    } finally {
      await services.pool.end();
    }
  }
  if (event.action === 'migrate') {
    const applied = await migrateAndStamp(config, logger);
    logger.info({ applied }, 'migrations applied');
    return { action: 'migrate', applied };
  }
  if (event.action === 'seed') {
    if (config.appMode !== 'test') throw new Error('Seeding is refused outside test mode.');
    const services = createServices(config, logger);
    try {
      const { seedTestData } = await import('../../seeds/test-data.js');
      const report = await seedTestData(services, { quiet: true });
      return { action: 'seed', created: report !== null, staff: report?.staff.map(s => s.username) ?? [], members: report?.members.length ?? 0 };
    } finally {
      await services.pool.end();
    }
  }
  if (event.action === 'livepay-trial-reset') {
    if (config.appMode !== 'test') throw new Error('The LivePay trial reset is refused outside test mode.');
    const services = createServices(config, logger);
    try {
      const { livepayTrialReset } = await import('../modules/admin/trial-reset.js');
      const report = await livepayTrialReset(services.pool, { accountNumber: event.accountNumber ?? '' });
      logger.info(report, 'LivePay trial reset done');
      return { action: 'livepay-trial-reset', ...report };
    } finally {
      await services.pool.end();
    }
  }
  throw new Error('Pass an action: migrate, seed, livepay-trial-reset, golive-status, admin-create, golive-sign or golive-revoke.');
}
