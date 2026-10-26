import { boot } from '../bootstrap.js';
import { assertStartupGates } from '../config/gates.js';
import { JOBS, runExclusive } from '../jobs/runner.js';
import { createServices, type Services } from '../services.js';

// AWS Lambda entry for scheduled jobs. EventBridge Scheduler invokes it with { "job": "<name>" } on the schedule
// set in Terraform (the node-cron schedules in jobs/runner.ts apply only to the local worker). Runs inside the VPC.
let services: Services | undefined;

export async function handler(event: { job?: string }): Promise<{ job: string; ran: boolean }> {
  const job = JOBS.find(j => j.name === event.job);
  if (!job) throw new Error(`Unknown job "${String(event.job)}". Known jobs: ${JOBS.map(j => j.name).join(', ')}.`);
  if (!services) {
    const { config, logger } = boot('pexa-jobs');
    const created = createServices(config, logger);
    await assertStartupGates(config, created.pool);
    services = created;
  }
  const ran = await runExclusive(services, job);
  // runExclusive logs a failure and returns false; failing the invocation lets the error alarm see it.
  if (!ran) throw new Error(`Job ${job.name} did not complete (failed, or another run holds its lock).`);
  return { job: job.name, ran };
}
