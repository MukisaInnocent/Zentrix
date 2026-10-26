import type { PoolClient } from '../../db/pool.js';
import { maybeOne } from '../../db/sql.js';
import { randomCode, randomToken } from '../../lib/crypto.js';
import { AppError } from '../../lib/errors.js';
import type { Services } from '../../services.js';
import { createUserDirect } from '../users/create.js';
import { moneyTx } from '../ledger/idempotency.js';
import { confirmDeposit } from './deposits.js';
import { listChannels } from './common.js';
import { staffWithdrawalAction } from './withdrawals.js';

// Test mode only (TEST_AUTO_APPROVE, refused in live mode): activation payments and withdrawals pass by
// themselves so the site can be tried end to end without staff. Nothing is skipped in the ledger: the same
// confirm, approve and pay steps run, done by two system accounts so the two-person rule still holds.

const APPROVER = { username: 'zx_autopilot_a', phone: '+256700990001' };
const PAYER = { username: 'zx_autopilot_b', phone: '+256700990002' };

async function systemUser(db: PoolClient, services: Services, who: { username: string; phone: string }): Promise<number> {
  const found = await maybeOne<{ id: string }>(db, 'SELECT id FROM users WHERE username = $1', [who.username]);
  if (found) return Number(found.id);
  // A random password nobody knows: these accounts cannot sign in.
  const created = await createUserDirect(db, services.config.dataEncryptionKey, {
    username: who.username, email: `${who.username}@zentrix.test`, phone: who.phone, country: 'UG',
    password: randomToken(24), roles: ['admin', 'finance'], verified: true,
  });
  return created.id;
}

const enabled = (services: Services) => services.config.appMode === 'test' && services.config.testAutoApprove;

// Every country gets a test payment method, so a member anywhere can try activation.
export async function ensureTestChannel(services: Services, member: { countryCode: string; currency: string }): Promise<void> {
  if (!enabled(services)) return;
  await services.pool.query(
    `INSERT INTO payment_channels (code, name, country_code, currency_code, account_name, account_number, merchant_code, instructions)
     VALUES ($1, 'Test payment', $2, $3, 'PEXEREARN TEST', 'TEST', 'TEST', 'TEST MODE: payments pass automatically. Do not send real money.')
     ON CONFLICT (code) DO NOTHING`,
    [`test_auto_${member.countryCode.toLowerCase()}`, member.countryCode, member.currency],
  );
}

export async function autoConfirmDeposit(services: Services, depositId: string): Promise<boolean> {
  if (!enabled(services)) return false;
  try {
    await moneyTx(services.pool, async db => {
      const approver = await systemUser(db, services, APPROVER);
      const d = await maybeOne<{ claimed_amount_minor: string }>(db, `SELECT claimed_amount_minor FROM deposits WHERE public_id = $1 AND status = 'pending'`, [depositId]);
      if (d) await confirmDeposit(db, approver, depositId, BigInt(d.claimed_amount_minor), 'Test mode: confirmed automatically');
    });
    return true;
  } catch (err) {
    services.logger.error({ err, depositId }, 'test autopilot could not confirm a payment');
    return false;
  }
}

// Approves, starts and pays a withdrawal. It pays from the assigned channel, or another channel in the same
// currency that holds enough; if none does, the withdrawal stays approved for staff.
export async function autoPayWithdrawal(services: Services, withdrawalId: string, currency: string): Promise<boolean> {
  if (!enabled(services)) return false;
  const step = async (fn: (db: PoolClient, approver: number, payer: number) => Promise<unknown>) =>
    moneyTx(services.pool, async db => fn(db, await systemUser(db, services, APPROVER), await systemUser(db, services, PAYER)));
  try {
    await step((db, approver) => staffWithdrawalAction(db, withdrawalId, { action: 'approve', staffId: approver, roles: ['admin'], note: 'Test mode: approved automatically' }));
    await step((db, _a, payer) => staffWithdrawalAction(db, withdrawalId, { action: 'start', staffId: payer, roles: ['finance'], note: 'Test mode' }));
    const channels = (await listChannels(services.pool, { currency })).filter(c => c.payoutsEnabled);
    for (const channel of channels) {
      try {
        await step((db, _a, payer) => staffWithdrawalAction(db, withdrawalId, {
          action: 'paid', staffId: payer, roles: ['finance'], channel: channel.code, payoutTxnId: `AUTO-${randomCode(10)}`, note: 'Test mode: paid automatically',
        }));
        return true;
      } catch (err) {
        if (!(err instanceof AppError && err.code === 'withdrawal.channel_short')) throw err;
      }
    }
    services.logger.warn({ withdrawalId }, 'test autopilot found no channel with enough money; left for staff');
    return false;
  } catch (err) {
    services.logger.error({ err, withdrawalId }, 'test autopilot could not pay a withdrawal');
    return false;
  }
}
