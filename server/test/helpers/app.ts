import { randomBytes, randomInt } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { createLogger } from '../../src/lib/logger.js';
import { createServices, type Services } from '../../src/services.js';
import { createTestDatabase } from './db.js';
import { TestClient, TEST_ORIGIN } from './client.js';

export interface TestApp {
  baseUrl: string;
  services: Services;
  owner: pg.Pool;
  client(): TestClient;
  setNow(date: Date | null): void;
  outbox(recipient: string): Promise<{ channel: string; subject: string | null; body: string }[]>;
  close(): Promise<void>;
}

// Boots the real Express app on a fresh database, running as the restricted zentrix_app role.
export async function startTestApp(env: Record<string, string> = {}): Promise<TestApp> {
  const db = await createTestDatabase();
  const config = loadConfig({
    APP_MODE: 'test', NODE_ENV: 'test', DATABASE_URL: db.url, DATABASE_APP_ROLE: 'zentrix_app', DATABASE_POOL_MAX: '5',
    CSRF_SECRET: randomBytes(32).toString('hex'), DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    PUBLIC_ORIGIN: TEST_ORIGIN, COOKIE_SECURE: 'false', LOG_LEVEL: 'silent', GEOIP_PROVIDER: 'test-header', TRUST_PROXY: '1',
    ...env,
  });
  let clock: Date | null = null;
  const services = createServices(config, createLogger({ level: 'silent', mode: 'test' }), { now: () => clock ?? new Date() });
  const server = createApp(services).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const owner = new pg.Pool({ connectionString: db.url, max: 2 });
  return {
    baseUrl,
    services,
    owner,
    client: () => new TestClient(baseUrl, `10.${randomInt(0, 255)}.${randomInt(0, 255)}.${randomInt(1, 254)}`),
    setNow: date => {
      clock = date;
    },
    outbox: async recipient =>
      (await owner.query('SELECT channel, subject, body FROM dev_outbox WHERE recipient = $1 ORDER BY id DESC', [recipient])).rows,
    close: async () => {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await services.pool.end();
      await owner.end();
      await db.drop();
    },
  };
}
