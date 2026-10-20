import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app.js';
import type { TestClient } from '../helpers/client.js';
import { createStaff, loginStaff, registerMember, uniquePhoneUG, type Staff } from '../helpers/factories.js';

let app: TestApp;
let admin: Staff;
let adminClient: TestClient;
let compliance: Staff;
let complianceClient: TestClient;
let supportClient: TestClient;

beforeAll(async () => {
  app = await startTestApp();
  admin = await createStaff(app, ['admin']);
  adminClient = await loginStaff(app, admin);
  compliance = await createStaff(app, ['compliance']);
  complianceClient = await loginStaff(app, compliance);
  supportClient = await loginStaff(app, await createStaff(app, ['support']));
});
afterAll(async () => {
  await app.close();
});

type Body = Record<string, unknown> & { error?: { code: string; fields?: Record<string, string[]> } };
const auditRows = async (action: string, targetId: string) =>
  (await app.owner.query('SELECT actor_user_id, before, after, reason FROM audit_log WHERE action = $1 AND target_id = $2', [action, targetId])).rows;

describe('member administration', () => {
  it('searches members for support staff and audits every detail view', async () => {
    const member = await registerMember(app);
    const found = await supportClient.get<{ members: { id: string }[] }>(`/api/admin/members?q=${member.input.username}`);
    expect(found.body.members.map(m => m.id)).toEqual([member.user.id]);
    expect((await supportClient.get(`/api/admin/members/${member.user.id}`)).status).toBe(200);
    expect(await auditRows('member.viewed', member.user.id)).toHaveLength(1);
    expect((await supportClient.get('/api/admin/members/not-a-uuid')).status).toBe(404);
  });

  it('freezes and unfreezes with a reason, records before and after, and never on one\'s own account', async () => {
    const member = await registerMember(app);
    expect((await supportClient.post(`/api/admin/members/${member.user.id}/freeze`, { reason: 'Suspicious activity' })).status).toBe(403);
    expect((await complianceClient.post(`/api/admin/members/${member.user.id}/freeze`, { reason: 'x' })).status).toBe(400);
    expect((await complianceClient.post(`/api/admin/members/${member.user.id}/freeze`, { reason: 'Suspicious activity' })).status).toBe(200);
    expect(((await member.client.get('/api/me')).body as { user: { status: string } }).user.status).toBe('frozen');
    const [row] = await auditRows('member.freeze', member.user.id);
    expect(row).toMatchObject({ actor_user_id: String(compliance.userId), before: { status: 'active' }, after: { status: 'frozen' }, reason: 'Suspicious activity' });
    expect((await complianceClient.post(`/api/admin/members/${member.user.id}/unfreeze`, { reason: 'Reviewed, all fine' })).status).toBe(200);
    expect((await complianceClient.post<Body>(`/api/admin/members/${compliance.publicId}/freeze`, { reason: 'Testing myself' })).body.error?.code).toBe('admin.self_action');
  });

  it('lets only admins change a phone number, locks withdrawals for 48 hours and signs the member out', async () => {
    const member = await registerMember(app);
    const newPhone = uniquePhoneUG();
    const body = { phone: newPhone, verification: 'Checked national ID in a video call' };
    expect((await complianceClient.post(`/api/admin/members/${member.user.id}/phone`, body)).status).toBe(403);
    expect((await adminClient.post(`/api/admin/members/${member.user.id}/phone`, { ...body, phone: '12' })).status).toBe(400);
    const res = await adminClient.post<{ withdrawalsLockedUntil: string }>(`/api/admin/members/${member.user.id}/phone`, body);
    expect(res.status).toBe(200);
    const lockHours = (new Date(res.body.withdrawalsLockedUntil).getTime() - Date.now()) / 3_600_000;
    expect(lockHours).toBeGreaterThan(47.9);
    expect(lockHours).toBeLessThan(48.1);
    expect((await member.client.get('/api/me')).status).toBe(401);
    const [row] = await auditRows('member.phone_changed', member.user.id);
    expect(row?.before).toEqual({ phone: member.user.phone });
    expect(row?.after).toMatchObject({ phone: newPhone });
  });
});

describe('settings and country configuration', () => {
  it('versions settings, validates values and audits changes', async () => {
    const list = await adminClient.get<{ settings: { key: string; version: number }[] }>('/api/admin/settings');
    expect(list.body.settings.map(s => s.key)).toContain('support.contact');
    const value = { email: 'help@zentrix.test', phone: '+256 700 111 222', hours: 'Daily 08:00 to 20:00 EAT' };
    expect((await adminClient.put('/api/admin/settings/support.contact', { value: { ...value, email: 'nope' } })).status).toBe(400);
    expect((await adminClient.put<{ version: number }>('/api/admin/settings/support.contact', { value, note: 'Real hours' })).body.version).toBe(1);
    expect((await adminClient.put<{ version: number }>('/api/admin/settings/support.contact', { value, note: 'Again' })).body.version).toBe(2);
    expect((await adminClient.put('/api/admin/settings/no.such.key', { value: 1 })).status).toBe(404);
    expect(((await app.client().get('/api/meta')).body as { support: unknown }).support).toEqual(value);
    expect(await auditRows('settings.changed', 'support.contact')).toHaveLength(2);
  });

  const config = {
    membershipFee: '1.500', withdrawalMin: '0.300', withdrawalMax: '150.000', withdrawalDailyMax: '300.000', withdrawalMonthlyMax: '1500.000',
    withdrawalFeeBp: 50, withdrawalFeeMin: '0', withdrawalApprovalThreshold: '30.000', newAccountReviewDays: 14, vatBp: 0,
    kycLevelForWithdrawal: 0, engagementTasksEnabled: false, termsVersion: '2026-10-v1', privacyVersion: '2026-10-v1', isPlaceholder: true,
  };

  it('stores config amounts exactly in minor units using the currency exponent', async () => {
    const res = await adminClient.post<{ version: number }>('/api/admin/countries/KW/config', config);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const row = (await app.owner.query(`SELECT membership_fee_minor, withdrawal_min_minor FROM current_country_configs WHERE country_code = 'KW'`)).rows[0];
    expect(row).toEqual({ membership_fee_minor: '1500', withdrawal_min_minor: '300' });
    const pub = await app.client().get<{ config: { membershipFee: unknown } }>('/api/reference/config/KW');
    expect(pub.body.config.membershipFee).toEqual({ amountMinor: '1500', currency: 'KWD' });
  });

  it('rejects extra decimals and limits that do not rise', async () => {
    expect((await adminClient.post<Body>('/api/admin/countries/KW/config', { ...config, membershipFee: '1.5001' })).body.error?.fields).toHaveProperty('membershipFee');
    expect((await adminClient.post<Body>('/api/admin/countries/JP/config', { ...config, membershipFee: '750.5' })).status).toBe(400);
    expect((await adminClient.post<Body>('/api/admin/countries/KW/config', { ...config, withdrawalMin: '200.000' })).body.error?.fields).toHaveProperty('withdrawalMax');
  });

  it('blocks or opens countries with an audit record, never both at once', async () => {
    expect((await adminClient.post('/api/admin/countries/FR/flags', { blocked: true, blockReason: 'Testing the blocklist' })).status).toBe(200);
    const countries = await app.client().get<{ countries: { code: string }[] }>('/api/reference/countries');
    expect(countries.body.countries.some(c => c.code === 'FR')).toBe(false);
    expect((await adminClient.post<Body>('/api/admin/countries/FR/flags', { liveEnabled: true })).body.error?.code).toBe('country.blocked_live');
    expect((await adminClient.post('/api/admin/countries/FR/flags', { blocked: false })).status).toBe(200);
    expect(await auditRows('country.flags_changed', 'FR')).toHaveLength(2);
  });
});

describe('review queues and test tools', () => {
  it('reviews a fraud flag once', async () => {
    const client = app.client();
    await client.post('/api/auth/register', { ...(await import('../helpers/factories.js')).newMemberInput({ phone: '+254712000111' }) });
    const open = await complianceClient.get<{ flags: { id: string; kind: string }[] }>('/api/admin/fraud-flags');
    const flag = open.body.flags.find(f => f.kind === 'phone_country_mismatch')!;
    expect((await complianceClient.post(`/api/admin/fraud-flags/${flag.id}/review`, { status: 'dismissed', note: 'Kenyan SIM, lives in Kampala' })).status).toBe(200);
    expect((await complianceClient.post(`/api/admin/fraud-flags/${flag.id}/review`, { status: 'confirmed', note: 'Second look' })).status).toBe(400);
  });

  it('shows the dev outbox in test mode and the unsigned go-live checklist', async () => {
    const member = await registerMember(app);
    const outbox = await supportClient.get<{ messages: { recipient: string }[] }>('/api/admin/outbox');
    expect(outbox.body.messages.some(m => m.recipient === member.input.email)).toBe(true);
    const golive = await adminClient.get<{ items: { signed: boolean | null }[] }>('/api/admin/go-live');
    expect(golive.body.items).toHaveLength(7);
    expect(golive.body.items.every(i => !i.signed)).toBe(true);
  });
});
