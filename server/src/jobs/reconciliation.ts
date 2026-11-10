import { runReconciliation } from '../modules/payments/reconciliation.js';
import { payPendingReferralRewards } from '../modules/referrals/service.js';
import type { Job } from './runner.js';

// The balance check every 5 minutes (rule 6): solvency per currency, ledger balance and drift, stuck payments.
export const reconciliationJob: Job = {
  name: 'reconciliation',
  schedule: '*/5 * * * *',
  async run(services) {
    // Referral rewards waiting because platform revenue was short are paid once staff have added money (owner,
    // 2026-11-10), without waiting for the next exchange-rate snapshot.
    const paid = await payPendingReferralRewards(services.pool);
    if (paid > 0) services.logger.info({ paid }, 'waiting referral rewards paid');
    const { id, report } = await runReconciliation(services.pool, null);
    if (!report.ok) services.logger.error({ run: id }, 'balance check failed; withdrawals paused where needed');
  },
};
