import { seedTestData } from '../seeds/test-data.js';
import { boot } from '../src/bootstrap.js';
import { assertStartupGates } from '../src/config/gates.js';
import { createServices } from '../src/services.js';

const { config, logger } = boot('zentrix-seed');
const services = createServices(config, logger);
try {
  await assertStartupGates(config, services.pool);
  const report = await seedTestData(services);
  console.log(report ? 'Seeded test data. Credentials were written to .data/seed-credentials.txt and the log above.' : 'Seed data already present.');
} finally {
  await services.pool.end();
}
