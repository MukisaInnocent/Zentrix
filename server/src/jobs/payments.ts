import { pollProviderRequests } from '../modules/payments/provider.js';
import type { Job } from './runner.js';

// Every minute: reads the status of provider (LivePay) requests that got no answer for a while, within LivePay's
// rate limit. Webhooks are the main path; this catches lost webhooks, timeouts and the AWS handoff.
export const paymentsJob: Job = {
  name: 'payments',
  schedule: '* * * * *',
  async run(services) {
    const { checked } = await pollProviderRequests(services);
    if (checked > 0) services.logger.info({ checked }, 'provider requests checked');
  },
};
