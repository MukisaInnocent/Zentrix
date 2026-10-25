import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureSuperadmin } from '../../src/modules/auth/superadmin.js';
import { startTestApp, type TestApp } from '../helpers/app.js';

// TEST_SUPERADMIN_PASSWORD (test mode only): an easy staff login with no second step.
let app: TestApp;
const PASSWORD = 'SuperAdmin-Test-2026';

beforeAll(async () => {
  app = await startTestApp({ TEST_SUPERADMIN_PASSWORD: PASSWORD });
  await ensureSuperadmin(app.services);
});
afterAll(async () => {
  await app.close();
});

describe('test super admin', () => {
  it('signs in with the password alone and reaches every part of the staff console', async () => {
    const client = app.client();
    const res = await client.post<Record<string, unknown>>('/api/auth/login', { identifier: 'superadmin', password: PASSWORD });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.mfaRequired).toBeUndefined();
    for (const path of ['/api/admin/payments/overview', '/api/admin/payments/balances', '/api/admin/audit-log', '/api/admin/members']) {
      expect([path, (await client.get(path)).status]).toEqual([path, 200]);
    }
    expect((await app.client().post('/api/auth/login', { identifier: 'superadmin', password: 'wrong-password-123' })).status).toBe(401);
  });

  it('keeps its password in step with the environment on each start', async () => {
    await app.owner.query(`UPDATE users SET password_hash = 'x' WHERE username = 'superadmin'`);
    await ensureSuperadmin(app.services);
    expect((await app.client().post('/api/auth/login', { identifier: 'superadmin', password: PASSWORD })).status).toBe(200);
  });
});
