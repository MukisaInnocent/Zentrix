import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedTestData } from '../../seeds/test-data.js';
import { startTestApp, type TestApp } from '../helpers/app.js';

// The test seed (run on deploy by the migrate function) must keep working as the rules change.
let app: TestApp;

beforeAll(async () => {
  app = await startTestApp();
});
afterAll(async () => {
  await app.close();
});

describe('test seed', () => {
  it('creates the fake staff, members and payments once, quietly', async () => {
    const report = await seedTestData(app.services, { quiet: true });
    expect(report?.staff.map(s => s.username)).toContain('zx_admin');
    expect(report?.members.length).toBeGreaterThan(5);
    const withdrawals = await app.owner.query<{ amount_minor: string }>('SELECT amount_minor FROM withdrawals');
    expect(withdrawals.rows.map(r => r.amount_minor)).toEqual(['15000']);
    expect(await seedTestData(app.services, { quiet: true })).toBeNull();
  });
});
