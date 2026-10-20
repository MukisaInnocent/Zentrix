import { boot } from './bootstrap.js';
import { assertStartupGates } from './config/gates.js';
import { startJobs } from './jobs/runner.js';
import { createServices } from './services.js';

async function main(): Promise<void> {
  const { config, logger } = boot('zentrix-worker');
  const services = createServices(config, logger);
  await assertStartupGates(config, services.pool);
  const stopJobs = startJobs(services);
  const shutdown = (signal: string) => {
    logger.info({ signal }, 'worker shutting down');
    void (async () => {
      await stopJobs();
      await services.pool.end();
      process.exit(0);
    })();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  process.stderr.write(`Zentrix worker failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
