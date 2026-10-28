import { boot } from '../bootstrap.js';
import { assertStartupGates } from '../config/gates.js';
import { JOBS, runExclusive } from '../jobs/runner.js';
import { createServices, type Services } from '../services.js';

// AWS Lambda entry for scheduled jobs. EventBridge Scheduler invokes it with { "job": "<name>" } on the schedule
// set in Terraform (the node-cron schedules in jobs/runner.ts apply only to the local worker). Runs inside the VPC.
// New exchange rates written to S3 under fx/ (S3 notification) run the `fxrates` job.
let services: Services | undefined;

interface JobEvent {
  job?: string;
  Records?: { s3?: { object?: { key?: string } } }[];
}

export async function handler(event: JobEvent): Promise<{ job: string; ran: boolean }> {
  const name = event.Records?.some(r => r.s3?.object?.key?.startsWith('fx/')) ? 'fxrates' : event.job;
  const job = JOBS.find(j => j.name === name);
  if (!job) throw new Error(`Unknown job "${String(name)}". Known jobs: ${JOBS.map(j => j.name).join(', ')}.`);
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
