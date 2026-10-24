import { runReconciliation } from '../modules/payments/reconciliation.js';
import type { Job } from './runner.js';

// The balance check every 5 minutes (rule 6): solvency per currency, ledger balance and drift, stuck payments.
export const reconciliationJob: Job = {
  name: 'reconciliation',
  schedule: '*/5 * * * *',
  async run(services) {
    const { id, report } = await runReconciliation(services.pool, null);
    if (!report.ok) services.logger.error({ run: id }, 'balance check failed; withdrawals paused where needed');
  },
};
