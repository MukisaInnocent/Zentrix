// Go-live checklist (section 0, decision D20). Live mode refuses to start until every item is signed, so
// sign-off happens here, against the live database, by an admin proving password + TOTP.
// Usage: npm run golive -- status | sign <item> | revoke <item>   (--username admin --note "...")
import { parseArgs } from 'node:util';
import { boot } from '../src/bootstrap.js';
import { maybeOne } from '../src/db/sql.js';
import { withTransaction } from '../src/db/tx.js';
import { verifyPassword } from '../src/modules/auth/passwords.js';
import { openTotpSecret, verifyTotp } from '../src/modules/auth/totp.js';
import { goLiveStatus, recordSignoff } from '../src/modules/golive/service.js';
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
    const admin = await maybeOne<{ id: string; password_hash: string; secret_ciphertext: Buffer | null; last_used_step: string | null }>(
      pool,
      `SELECT u.id, u.password_hash, t.secret_ciphertext, t.last_used_step FROM users u
       JOIN user_roles r ON r.user_id = u.id AND r.role = 'admin'
       LEFT JOIN totp_credentials t ON t.user_id = u.id AND t.enabled_at IS NOT NULL
       WHERE u.username = $1 AND u.status = 'active'`,
      [values.username.toLowerCase()],
    );
    const password = await promptSecret('Admin password: ', 'GOLIVE_PASSWORD');
    const code = process.env.GOLIVE_TOTP ?? (await promptLine('Authenticator code: '));
    if (!admin || !admin.secret_ciphertext || !(await verifyPassword(admin.password_hash, password))) throw new Error('Not an admin with two-step verification, or wrong password.');
    const step = verifyTotp(openTotpSecret(config.dataEncryptionKey, admin.secret_ciphertext), code, admin.last_used_step === null ? null : Number(admin.last_used_step), new Date());
    if (step === null) throw new Error('Wrong authenticator code.');
    await withTransaction(pool, async db => {
      await db.query('UPDATE totp_credentials SET last_used_step = $2 WHERE user_id = $1', [admin.id, step]);
      await recordSignoff(db, item, Number(admin.id), command, values.note ?? null);
      await db.query(`INSERT INTO audit_log (actor_user_id, actor_roles, action, target_type, target_id, reason) VALUES ($1, '{admin}', $2, 'go_live_item', $3, $4)`, [
        admin.id, `golive.${command}`, item, values.note ?? null,
      ]);
    });
    console.log(`${command === 'sign' ? 'Signed' : 'Revoked'} ${item}.`);
  } else {
    console.error(`Usage: npm run golive -- status | sign <item> | revoke <item> --username <admin>\nItems: ${items.map(i => i.key).join(', ')}`);
    process.exitCode = 2;
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  await pool.end();
}
