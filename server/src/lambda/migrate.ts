import { boot, migrateAndStamp } from '../bootstrap.js';
import { createServices } from '../services.js';

// AWS Lambda entry the deploy pipeline invokes (the database is private, so GitHub Actions cannot reach it):
//   { "action": "migrate" }  applies pending migrations as the database owner and checks the mode stamp;
//   { "action": "seed" }     adds the fake test data, only in test mode on a test database.
//   { "action": "livepay-trial-reset", "accountNumber": "LP..." }  staging LivePay trial (owner, 2026-10-30): keeps
//                            only the LivePay method and freezes every non-staff member. Test mode only.
// It returns no secrets, so the pipeline can print the result. Runs inside the VPC.
export async function handler(event: { action?: string; accountNumber?: string }): Promise<Record<string, unknown>> {
  const { config, logger } = boot('pexa-migrate');
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
  throw new Error('Pass { "action": "migrate" }, { "action": "seed" } or { "action": "livepay-trial-reset", "accountNumber": "LP..." }.');
}
