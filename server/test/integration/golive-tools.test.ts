import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpCodeAt } from '../../src/modules/auth/totp.js';
import { createStaffAccount, hasActiveAdmin, signGoLiveItem } from '../../src/modules/golive/admin-tools.js';
import { goLiveStatus } from '../../src/modules/golive/service.js';
import { startTestApp, type TestApp } from '../helpers/app.js';

// Bootstrap of a fresh live database on AWS (owner, 2026-11-01): the migrate function creates the first admin and
// signs the go-live checklist with the same code as the npm scripts.
let app: TestApp;

beforeAll(async () => {
  app = await startTestApp();
});
afterAll(async () => {
  await app.close();
});

const staff = { username: 'Owner_Admin', email: 'owner_admin@zentrix.test', phone: '+256700777201', country: 'ug', role: 'admin', password: 'Long-enough-pass-42!' };

describe('go-live bootstrap tools', () => {
  it('creates an admin with two-step sign-in and refuses weak passwords and unknown roles', async () => {
    await expect(createStaffAccount(app.services, { ...staff, username: 'weak_admin', password: 'short' })).rejects.toThrow();
    await expect(createStaffAccount(app.services, { ...staff, username: 'odd_role', role: 'member' })).rejects.toThrow(/role must be one of/);
    const created = await createStaffAccount(app.services, staff);
    expect(created.totpSecret).toMatch(/^[A-Z2-7]+$/);
    expect(created.otpauthUrl).toContain('owner_admin');
    expect(await hasActiveAdmin(app.services.pool)).toBe(true);
  });

  it('signs and revokes an item only with the right password and a fresh authenticator code, and audits it', async () => {
    const secret = (await createStaffAccount(app.services, { ...staff, username: 'signer_admin', email: 'signer_admin@zentrix.test', phone: '+256700777202' })).totpSecret;
    const key = app.services.config.dataEncryptionKey;
    const item = (await goLiveStatus(app.services.pool))[0]!.key;
    const base = { command: 'sign' as const, item, username: 'signer_admin', password: staff.password };

    await expect(signGoLiveItem(app.services.pool, key, { ...base, password: 'Wrong-password-42!', code: totpCodeAt(secret, new Date()) })).rejects.toThrow(/wrong password/);
    await expect(signGoLiveItem(app.services.pool, key, { ...base, code: '000000' })).rejects.toThrow(/Wrong authenticator code/);
    await expect(signGoLiveItem(app.services.pool, key, { ...base, item: 'nope', code: totpCodeAt(secret, new Date()) })).rejects.toThrow(/Unknown item/);

    const code = totpCodeAt(secret, new Date());
    await signGoLiveItem(app.services.pool, key, { ...base, code, note: 'Backups restored on a copy' });
    expect((await goLiveStatus(app.services.pool)).find(i => i.key === item)?.signed).toBe(true);
    // The same code cannot be used twice.
    await expect(signGoLiveItem(app.services.pool, key, { ...base, command: 'revoke', code })).rejects.toThrow(/Wrong authenticator code/);

    const audits = await app.owner.query(`SELECT action, reason FROM audit_log WHERE target_type = 'go_live_item' AND target_id = $1`, [item]);
    expect(audits.rows).toEqual([{ action: 'golive.sign', reason: 'Backups restored on a copy' }]);
  });
});
