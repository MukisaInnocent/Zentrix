import cron from 'node-cron';
import type { Services } from '../services.js';
import { announcementsJob } from './announcements.js';
import { cleanupJob } from './cleanup.js';
import { fxRatesJob } from './fx-rates.js';
import { reconciliationJob } from './reconciliation.js';

export interface Job {
  name: string;
  schedule: string;
  // Also run once when the worker starts (for data the app needs before the first scheduled run).
  runOnStart?: boolean;
  run(services: Services): Promise<void>;
}

export const JOBS: Job[] = [cleanupJob, reconciliationJob, fxRatesJob, announcementsJob];

// Runs a job only if no other process holds its advisory lock, so several workers never double-run it.
export async function runExclusive(services: Services, job: Job): Promise<boolean> {
  const client = await services.pool.connect();
  const lockKey = `zentrix-job:${job.name}`;
  try {
    const { rows } = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [lockKey]);
    if (!rows[0]?.ok) return false;
    try {
      const started = Date.now();
      await job.run(services);
      services.logger.info({ job: job.name, ms: Date.now() - started }, 'job finished');
      return true;
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]);
    }
  } catch (err) {
    services.logger.error({ err, job: job.name }, 'job failed');
    return false;
  } finally {
    client.release();
  }
}

export function startJobs(services: Services): () => Promise<void> {
  const tasks = JOBS.map(job =>
    cron.schedule(job.schedule, () => runExclusive(services, job), { name: job.name, noOverlap: true, timezone: 'UTC' }),
  );
  for (const job of JOBS) if (job.runOnStart) void runExclusive(services, job);
  services.logger.info({ jobs: JOBS.map(j => j.name) }, 'jobs scheduled');
  return async () => {
    for (const task of tasks) await task.stop();
  };
}
