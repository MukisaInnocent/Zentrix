// Creates a staff account with two-step verification already on. Used to bootstrap the first admin in
// any environment (including a fresh live database before go-live sign-off). On AWS use infra/scripts/golive.ps1.
// Usage: npm run admin:create -- --username alice --email alice@example.com --phone +2567... --country UG --role admin
import { parseArgs } from 'node:util';
import { boot } from '../src/bootstrap.js';
import { createStaffAccount } from '../src/modules/golive/admin-tools.js';
import { createServices } from '../src/services.js';
import { promptSecret } from './prompt.js';

const { values } = parseArgs({
  options: {
    username: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' },
    country: { type: 'string', default: 'UG' }, role: { type: 'string', default: 'admin' },
  },
});
if (!values.username || !values.email || !values.phone) {
  console.error('Required: --username, --email, --phone (E.164, e.g. +256...). Optional: --country, --role.');
  process.exit(2);
}
const password = await promptSecret('Password for the new staff account: ', 'ADMIN_PASSWORD');

const { config, logger } = boot('zentrix-admin-create');
const services = createServices(config, logger);
try {
  const created = await createStaffAccount(services, {
    username: values.username, email: values.email, phone: values.phone, country: values.country, role: values.role, password,
  });
  console.log(`Created ${values.role} account ${values.username} (${created.publicId}).`);
  console.log('Add this to an authenticator app now; it is not shown again:');
  console.log(`  Secret: ${created.totpSecret}`);
  console.log(`  URL:    ${created.otpauthUrl}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 2;
} finally {
  await services.pool.end();
}
