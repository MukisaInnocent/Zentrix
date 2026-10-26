import { boot, migrateAndStamp } from '../bootstrap.js';
import { createServices } from '../services.js';

// AWS Lambda entry the deploy pipeline invokes (the database is private, so GitHub Actions cannot reach it):
//   { "action": "migrate" }  applies pending migrations as the database owner and checks the mode stamp;
//   { "action": "seed" }     adds the fake test data, only in test mode on a test database.
// It returns no secrets, so the pipeline can print the result. Runs inside the VPC.
export async function handler(event: { action?: string }): Promise<Record<string, unknown>> {
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
  throw new Error('Pass { "action": "migrate" } or { "action": "seed" }.');
}
