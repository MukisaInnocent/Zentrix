// Go-live checklist (section 0, decision D20). Live mode refuses to start until every item is signed, so
// sign-off happens here, against the live database, by an admin proving password + TOTP. On AWS the database is
// private: use infra/scripts/golive.ps1, which runs the same steps through the migrate function.
// Usage: npm run golive -- status | sign <item> | revoke <item>   (--username admin --note "...")
import { parseArgs } from 'node:util';
import { boot } from '../src/bootstrap.js';
import { signGoLiveItem } from '../src/modules/golive/admin-tools.js';
import { goLiveStatus } from '../src/modules/golive/service.js';
import { createPool } from '../src/db/pool.js';
import { promptLine, promptSecret } from './prompt.js';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { username: { type: 'string' }, note: { type: 'string' } } });
const [command = 'status', item] = positionals;
const { config, logger } = boot('zentrix-golive');
const pool = createPool({ url: config.databaseUrl, ssl: config.databaseSsl, max: 2, appRole: config.databaseAppRole, logger });
try {
  const items = await goLiveStatus(pool);
  if (command === 'status') {
    for (const i of items) console.log(`${i.signed ? '[x]' : '[ ]'} ${i.key.padEnd(18)} ${i.label}`);
    console.log(items.every(i => i.signed) ? 'All items signed: live mode may start.' : 'Live mode will refuse to start until every item is signed.');
  } else if ((command === 'sign' || command === 'revoke') && item && items.some(i => i.key === item)) {
    if (!values.username) throw new Error('--username is required');
    const password = await promptSecret('Admin password: ', 'GOLIVE_PASSWORD');
    const code = process.env.GOLIVE_TOTP ?? (await promptLine('Authenticator code: '));
    await signGoLiveItem(pool, config.dataEncryptionKey, { command, item, username: values.username, password, code, note: values.note ?? null });
    console.log(`${command === 'sign' ? 'Signed' : 'Revoked'} ${item}.`);
  } else {
    console.error(`Usage: npm run golive -- status | sign <item> | revoke <item> --username <admin>
Items: ${items.map(i => i.key).join(', ')}`);
    process.exitCode = 2;
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  await pool.end();
}
