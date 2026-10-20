import { createApp } from './app.js';
import { boot, migrateAndStamp } from './bootstrap.js';
import { assertStartupGates } from './config/gates.js';
import { startJobs } from './jobs/runner.js';
import { createServices } from './services.js';

async function main(): Promise<void> {
  const { config, logger } = boot('zentrix-api');
  if (config.migrateOnStart) {
    const applied = await migrateAndStamp(config, logger);
    logger.info({ applied }, 'migrations applied');
  }
  const services = createServices(config, logger);
  await assertStartupGates(config, services.pool);
  if (config.seedOnStart) {
    const { seedTestData } = await import('../seeds/test-data.js');
    await seedTestData(services);
  }

  const app = createApp(services);
  const server = app.listen(config.port, config.host, () => {
    logger.info({ port: config.port, mode: config.appMode }, config.appMode === 'test' ? 'Zentrix API listening (TEST MODE: no real money)' : 'Zentrix API listening');
  });
  const stopJobs = config.runJobsInWeb ? startJobs(services) : undefined;

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down');
    setTimeout(() => process.exit(1), 10_000).unref();
    server.close(() => {
      void (async () => {
        await stopJobs?.();
        await services.pool.end();
        process.exit(0);
      })();
    });
    server.closeIdleConnections();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  process.stderr.write(`Zentrix API failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
