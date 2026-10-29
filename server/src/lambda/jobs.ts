import { DeleteObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { boot } from '../bootstrap.js';
import { assertStartupGates } from '../config/gates.js';
import { JOBS, runExclusive } from '../jobs/runner.js';
import { applyOutcome } from '../modules/payments/provider.js';
import { PAYGATE_RESULTS, type ProviderOutcome } from '../providers/livepay.js';
import { createServices, type Services } from '../services.js';

// AWS Lambda entry for scheduled jobs. EventBridge Scheduler invokes it with { "job": "<name>" } on the schedule
// set in Terraform (the node-cron schedules in jobs/runner.ts apply only to the local worker). Runs inside the VPC.
// New exchange rates written to S3 under fx/ (S3 notification) run the `fxrates` job. Provider outcomes written by
// the paygate function under paygate/results/ are applied here (`payresults`), then deleted.
let services: Services | undefined;
const s3 = new S3Client({});

interface JobEvent {
  job?: string;
  Records?: { s3?: { bucket?: { name?: string }; object?: { key?: string } } }[];
}

async function ready(): Promise<Services> {
  if (!services) {
    const { config, logger } = boot('pexa-jobs');
    const created = createServices(config, logger);
    await assertStartupGates(config, created.pool);
    services = created;
  }
  return services;
}

export async function handler(event: JobEvent): Promise<{ job: string; ran: boolean }> {
  const results = (event.Records ?? []).filter(r => r.s3?.object?.key?.startsWith(PAYGATE_RESULTS));
  if (results.length > 0) {
    const s = await ready();
    for (const r of results) {
      const bucket = r.s3!.bucket!.name!;
      const key = decodeURIComponent(r.s3!.object!.key!.replace(/\+/g, ' '));
      const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const outcomes = JSON.parse(await object.Body!.transformToString()) as ProviderOutcome[];
      // A failure throws, so the S3 notification retries it; applying an outcome twice changes nothing.
      for (const outcome of outcomes) await applyOutcome(s, outcome);
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    }
    return { job: 'payresults', ran: true };
  }
  const name = event.Records?.some(r => r.s3?.object?.key?.startsWith('fx/')) ? 'fxrates' : event.job;
  const job = JOBS.find(j => j.name === name);
  if (!job) throw new Error(`Unknown job "${String(name)}". Known jobs: ${JOBS.map(j => j.name).join(', ')}.`);
  const ran = await runExclusive(await ready(), job);
  // runExclusive logs a failure and returns false; failing the invocation lets the error alarm see it.
  if (!ran) throw new Error(`Job ${job.name} did not complete (failed, or another run holds its lock).`);
  return { job: job.name, ran };
}
