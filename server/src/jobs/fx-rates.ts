import { storeRates } from '../modules/fx/service.js';
import { payPendingReferralRewards } from '../modules/referrals/service.js';
import type { Job } from './runner.js';

// Every 6 hours: stores the latest exchange rates, then pays the referral rewards that were waiting for one
// (owner, 2026-10-28). The provider refreshes its rates once a day.
export const fxRatesJob: Job = {
  name: 'fxrates',
  schedule: '20 */6 * * *',
  runOnStart: true,
  async run(services) {
    if (!services.fx) {
      services.logger.warn('no exchange-rate source configured (FX_PROVIDER); rewards across currencies wait as pending');
      return;
    }
    const snapshot = await services.fx.latest();
    const stored = await storeRates(services.pool, snapshot);
    const paid = await payPendingReferralRewards(services.pool);
    services.logger.info({ source: snapshot.source, rateAt: snapshot.rateAt, stored, paid }, 'exchange rates refreshed');
  },
};
