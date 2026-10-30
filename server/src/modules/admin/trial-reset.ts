import type { Pool } from '../../db/pool.js';
import { maybeOne, rows } from '../../db/sql.js';
import { withTransaction } from '../../db/tx.js';
import { audit } from '../audit/audit.js';

// Staging LivePay trial (owner, 2026-10-30): "remove all the other methods, only show LivePay, freeze the other users
// so I can test again". Test mode only; run through the migrate function ({ "action": "livepay-trial-reset" }).
// Nothing is deleted: other payment methods are archived (an admin can restore them) and members are frozen (an admin
// can unfreeze them). Staff, superadmin and the zx_ system accounts are left alone. Each step writes the audit log.

export interface TrialResetReport {
  livepayChannel: string;
  archivedChannels: string[];
  frozenMembers: number;
}

const REASON = 'Staging LivePay trial reset (owner, 2026-10-30)';

export async function livepayTrialReset(pool: Pool, input: { accountNumber: string }): Promise<TrialResetReport> {
  if (!/^[A-Za-z0-9]{4,40}$/.test(input.accountNumber)) throw new Error('Pass the LivePay account number (LP...).');
  return withTransaction(pool, async db => {
    // The LivePay method for Uganda, created if it is missing, switched on if it is off.
    let channel = await maybeOne<{ code: string }>(
      db, `SELECT code FROM payment_channels WHERE provider = 'livepay' AND country_code = 'UG' ORDER BY id LIMIT 1`,
    );
    if (!channel) {
      channel = await maybeOne<{ code: string }>(
        db,
        `INSERT INTO payment_channels (code, name, country_code, currency_code, account_name, account_number, instructions, provider)
         VALUES ('livepay_ug', 'Mobile money (LivePay)', 'UG', 'UGX', 'PEXEREARN', $1, 'MTN or Airtel. Approve the prompt on your phone.', 'livepay')
         RETURNING code`,
        [input.accountNumber],
      );
      await audit(db, null, { action: 'channel.created', targetType: 'payment_channel', targetId: 'livepay_ug', after: { provider: 'livepay' }, reason: REASON });
    }
    const code = channel!.code;
    await db.query(
      `UPDATE payment_channels SET removed_at = NULL, deposits_enabled = true, payouts_enabled = true WHERE code = $1`, [code],
    );

    const archived = await rows<{ code: string }>(
      db,
      `UPDATE payment_channels SET removed_at = now(), deposits_enabled = false, payouts_enabled = false
       WHERE provider IS NULL AND removed_at IS NULL RETURNING code`,
    );
    if (archived.length > 0) {
      await audit(db, null, { action: 'channel.removed', targetType: 'payment_channel', targetId: 'all-manual', after: { archived: archived.map(c => c.code) }, reason: REASON });
    }

    const frozen = await rows<{ id: string; public_id: string }>(
      db,
      `UPDATE users u SET status = 'frozen', status_reason = $1
       WHERE u.status = 'active' AND u.username <> 'superadmin' AND u.username NOT LIKE 'zx\\_%'
         AND NOT EXISTS (SELECT 1 FROM user_roles r JOIN roles ro ON ro.name = r.role WHERE r.user_id = u.id AND ro.is_staff)
       RETURNING u.id, u.public_id`,
      [REASON],
    );
    if (frozen.length > 0) {
      await db.query(`UPDATE sessions SET revoked_at = now(), revoke_reason = 'frozen' WHERE user_id = ANY($1::bigint[]) AND revoked_at IS NULL`, [frozen.map(f => f.id)]);
      await audit(db, null, { action: 'member.freeze', targetType: 'user', targetId: 'all-members', after: { status: 'frozen', count: frozen.length, users: frozen.map(f => f.public_id) }, reason: REASON });
    }
    return { livepayChannel: code, archivedChannels: archived.map(c => c.code), frozenMembers: frozen.length };
  });
}
