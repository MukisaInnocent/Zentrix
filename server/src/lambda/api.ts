import serverless from 'serverless-http';
import { createApp } from '../app.js';
import { boot } from '../bootstrap.js';
import { assertStartupGates } from '../config/gates.js';
import { createServices } from '../services.js';

// AWS Lambda entry for the API (API Gateway HTTP API, payload format 2.0). It wraps the same Express app the
// local Node server runs (main.ts), built once per warm container. Runs inside the VPC, next to Aurora.
type Handler = (event: object, context: object) => Promise<object>;

let ready: Promise<Handler> | undefined;

async function start(): Promise<Handler> {
  const { config, logger } = boot('pexa-api');
  const services = createServices(config, logger);
  await assertStartupGates(config, services.pool);
  const { ensureSuperadmin } = await import('../modules/auth/superadmin.js');
  await ensureSuperadmin(services);
  return serverless(createApp(services), { binary: ['image/*', 'font/*', 'application/pdf', 'application/octet-stream'] });
}

export const handler: Handler = async (event, context) => {
  // A failed start (for example the database still resuming) is retried on the next request.
  ready ??= start().catch((err: unknown) => {
    ready = undefined;
    throw err;
  });
  return (await ready)(event, context);
};
