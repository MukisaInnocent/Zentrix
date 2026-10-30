import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { livepayTrialReset } from '../../src/modules/admin/trial-reset.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { createStaff, registerMember } from '../helpers/factories.js';

// Staging LivePay trial reset (owner, 2026-10-30): only the LivePay method stays; non-staff members are frozen.
let app: TestApp;

beforeAll(async () => {
  app = await startTestApp();
});
afterAll(async () => {
  await app.close();
});

describe('LivePay trial reset', () => {
  it('archives manual methods, adds LivePay, freezes members only, and is safe to run twice', async () => {
    await app.owner.query(
      `INSERT INTO payment_channels (code, name, country_code, currency_code, account_name, account_number) VALUES ('mtn_ug', 'MTN', 'UG', 'UGX', 'PEXE', '0770000000')`,
    );
    const member = await registerMember(app);
    const staff = await createStaff(app, ['finance']);
    const report = await livepayTrialReset(app.services.pool, { accountNumber: 'LP2610300054' });
    expect(report.livepayChannel).toBe('livepay_ug');
    expect(report.archivedChannels).toContain('mtn_ug');
    expect(report.frozenMembers).toBeGreaterThanOrEqual(1);

    // The frozen member's sessions are revoked; a member who registers now sees only LivePay.
    expect((await member.client.get('/api/payments/channels')).status).toBe(401);
    const fresh = await registerMember(app);
    const channels = (await fresh.client.get<{ channels: { code: string }[] }>('/api/payments/channels')).body.channels;
    expect(channels.map(c => c.code)).toEqual(['livepay_ug']);
    const users = await app.owner.query<{ username: string; status: string }>('SELECT username, status FROM users WHERE username = ANY($1)', [[member.input.username, staff.username]]);
    expect(Object.fromEntries(users.rows.map(u => [u.username, u.status]))).toEqual({ [member.input.username]: 'frozen', [staff.username]: 'active' });
    const audit = await app.owner.query(`SELECT action FROM audit_log WHERE reason LIKE 'Staging LivePay trial reset%' ORDER BY id`);
    expect(audit.rows.map(r => r.action).filter(a => a !== 'member.released')).toEqual(['channel.created', 'channel.removed', 'member.freeze']);

    // The frozen account gave up its phone and email: the same person can register again.
    const back = await registerMember(app, { phone: member.input.phone, email: member.input.email });
    expect(back.user.phone).toBe(member.input.phone);
    expect(report.releasedAccounts).toBeGreaterThanOrEqual(1);
    const kept = await app.owner.query(`SELECT before->>'phone' AS phone FROM audit_log WHERE action = 'member.released' AND before->>'phone' = $1`, [member.input.phone]);
    expect(kept.rowCount).toBe(1);

    // A second run changes nothing else.
    const again = await livepayTrialReset(app.services.pool, { accountNumber: 'LP2610300054' });
    expect(again).toMatchObject({ livepayChannel: 'livepay_ug', archivedChannels: [] });
    expect(again.frozenMembers).toBe(2); // the two members who registered since
    expect(again.releasedAccounts).toBe(2);
  });
});
