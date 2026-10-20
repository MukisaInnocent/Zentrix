import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { inject } from 'vitest';
import { TEMPLATE_DB, withDatabase } from './urls.js';

export interface TestDatabase {
  name: string;
  url: string;
  drop(): Promise<void>;
}

async function adminQuery(sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: inject('pgAdminUrl') });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

// A fresh, fully migrated database cloned from the template. Each test file gets its own.
export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `zx_t_${process.pid}_${randomBytes(4).toString('hex')}`;
  for (let attempt = 0; ; attempt++) {
    try {
      await adminQuery(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DB}`);
      break;
    } catch (err) {
      // Two files cloning at the same instant can collide on the template; retry briefly.
      if (attempt >= 20 || !String(err).includes('being accessed by other users')) throw err;
      await new Promise(r => setTimeout(r, 100 + Math.random() * 200));
    }
  }
  const url = withDatabase(inject('pgAdminUrl'), name);
  return {
    name,
    url,
    drop: () => adminQuery(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`),
  };
}
