// Creates a staff account with two-step verification already on. Used to bootstrap the first admin in
// any environment (including a fresh live database before go-live sign-off).
// Usage: npm run admin:create -- --username alice --email alice@example.com --phone +2567... --country UG --role admin
import { parseArgs } from 'node:util';
import { boot } from '../src/bootstrap.js';
import { withTransaction } from '../src/db/tx.js';
import { STAFF_ROLES, type Role } from '../src/modules/auth/context.js';
import { passwordProblems } from '../src/modules/auth/passwords.js';
import { newTotpSecret, otpauthUrl } from '../src/modules/auth/totp.js';
import { createUserDirect } from '../src/modules/users/create.js';
import { createServices } from '../src/services.js';
import { promptSecret } from './prompt.js';

const { values } = parseArgs({
  options: {
    username: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' },
    country: { type: 'string', default: 'UG' }, role: { type: 'string', default: 'admin' }, dob: { type: 'string', default: '1990-01-01' },
  },
});
if (!values.username || !values.email || !values.phone) {
  console.error('Required: --username, --email, --phone (E.164, e.g. +256...). Optional: --country, --role, --dob.');
  process.exit(2);
}
if (!(STAFF_ROLES as readonly string[]).includes(values.role)) {
  console.error(`--role must be one of: ${STAFF_ROLES.join(', ')}`);
  process.exit(2);
}
const password = await promptSecret('Password for the new staff account: ', 'ADMIN_PASSWORD');
const problems = passwordProblems(password, { username: values.username, email: values.email });
if (problems.length > 0) {
  console.error(problems.join(' '));
  process.exit(2);
}

const { config, logger } = boot('zentrix-admin-create');
const services = createServices(config, logger);
try {
  const totpSecret = newTotpSecret();
  const user = await withTransaction(services.pool, db =>
    createUserDirect(db, config.dataEncryptionKey, {
      username: values.username!.toLowerCase(), email: values.email!, phone: values.phone!, country: values.country.toUpperCase(),
      dateOfBirth: values.dob, password, roles: [values.role as Role, 'member'], verified: true, totpSecret,
    }),
  );
  console.log(`Created ${values.role} account ${values.username} (${user.publicId}).`);
  console.log('Add this to an authenticator app now; it is not shown again:');
  console.log(`  Secret: ${totpSecret}`);
  console.log(`  URL:    ${otpauthUrl(totpSecret, values.username)}`);
} finally {
  await services.pool.end();
}
