import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app.js';
import type { TestClient } from '../helpers/client.js';
import { createStaff, loginStaff, PASSWORD, registerMember, type Member } from '../helpers/factories.js';

// A member changes their password, email or phone only after an admin unlocks that one change.
let app: TestApp;
let adminClient: TestClient;
let supportClient: TestClient;

type Body = Record<string, unknown> & { error?: { code: string; fields?: Record<string, string[]> }; expiresAt?: string };
const verification = 'Checked national ID over a video call with the member';

beforeAll(async () => {
  app = await startTestApp();
  adminClient = await loginStaff(app, await createStaff(app, ['admin']));
  supportClient = await loginStaff(app, await createStaff(app, ['support']));
});
afterAll(async () => {
  await app.close();
});

const unlock = (member: Member, kind: string, client = adminClient) =>
  client.post<Body>(`/api/admin/members/${member.user.id}/unlock`, { kind, verification });

describe('unlocking a change', () => {
  it('is an admin-only action that records how the member was verified', async () => {
    const member = await registerMember(app);
    expect((await unlock(member, 'password', supportClient)).status).toBe(403);
    expect((await adminClient.post(`/api/admin/members/${member.user.id}/unlock`, { kind: 'password', verification: 'ok' })).status).toBe(400);
    expect((await adminClient.post(`/api/admin/members/${member.user.id}/unlock`, { kind: 'username', verification })).status).toBe(400);
    expect((await unlock(member, 'password')).status).toBe(200);
    const audit = await app.owner.query(`SELECT reason FROM audit_log WHERE action = 'member.change_unlocked' AND target_id = $1`, [member.user.id]);
    expect(audit.rows).toEqual([{ reason: verification }]);
    const status = await member.client.get<{ unlocked: Record<string, string> }>('/api/me/changes');
    expect(Object.keys(status.body.unlocked)).toEqual(['password']);
  });
});

describe('password', () => {
  it('changes once after an unlock, with the current password, and signs other devices out', async () => {
    const member = await registerMember(app);
    const other = app.client();
    await other.post('/api/auth/login', { identifier: member.input.username, password: PASSWORD });
    const change = { currentPassword: PASSWORD, newPassword: 'fresh-passphrase-77' };
    expect((await member.client.post<Body>('/api/auth/password/change', change)).body.error?.code).toBe('change.locked');
    await unlock(member, 'password');
    expect((await member.client.post('/api/auth/password/change', { ...change, currentPassword: 'not-it-at-all' })).status).toBe(403);
    expect((await member.client.post('/api/auth/password/change', change)).status).toBe(200);
    expect((await other.get('/api/me')).status).toBe(401);
    expect((await member.client.get('/api/me')).status).toBe(200);
    // The unlock was used up.
    expect((await member.client.post<Body>('/api/auth/password/change', { currentPassword: 'fresh-passphrase-77', newPassword: 'another-passphrase-88' })).body.error?.code).toBe('change.locked');
    expect((await app.client().post('/api/auth/login', { identifier: member.input.username, password: 'fresh-passphrase-77' })).status).toBe(200);
  });

  it('does not work after the unlock has expired', async () => {
    const member = await registerMember(app);
    await unlock(member, 'password');
    await app.owner.query(`UPDATE profile_change_grants SET expires_at = now() - interval '1 minute' WHERE user_id = (SELECT id FROM users WHERE public_id = $1)`, [member.user.id]);
    expect((await member.client.post<Body>('/api/auth/password/change', { currentPassword: PASSWORD, newPassword: 'fresh-passphrase-77' })).body.error?.code).toBe('change.locked');
  });

  it('is unlocked per member, not for everyone', async () => {
    const a = await registerMember(app);
    const b = await registerMember(app);
    await unlock(a, 'password');
    expect((await b.client.post<Body>('/api/auth/password/change', { currentPassword: PASSWORD, newPassword: 'fresh-passphrase-77' })).body.error?.code).toBe('change.locked');
  });
});

describe('email', () => {
  it('changes only after an unlock, needs the password and a free address, and tells the old address', async () => {
    const member = await registerMember(app);
    const other = await registerMember(app);
    const newEmail = `new_${member.input.username}@zentrix.test`;
    expect((await member.client.post<Body>('/api/me/email', { newEmail, password: PASSWORD })).body.error?.code).toBe('change.locked');
    await unlock(member, 'email');
    expect((await member.client.post('/api/me/email', { newEmail, password: 'wrong-password-1' })).status).toBe(403);
    expect((await member.client.post<Body>('/api/me/email', { newEmail: other.input.email, password: PASSWORD })).status).toBe(409);
    expect((await member.client.post('/api/me/email', { newEmail, password: PASSWORD })).status).toBe(200);
    expect(((await member.client.get<Body>('/api/me')).body.user as Body).email).toBe(newEmail);
    await new Promise(r => setTimeout(r, 300));
    expect((await app.outbox(member.input.email)).some(m => m.subject === 'Your Pexerearn email address was changed')).toBe(true);
    expect((await member.client.post<Body>('/api/me/email', { newEmail: `again_${newEmail}`, password: PASSWORD })).body.error?.code).toBe('change.locked');
  });
});

describe('phone', () => {
  it('changes only after an unlock, needs the country code, locks withdrawals for 48 hours and is audited', async () => {
    const member = await registerMember(app);
    const newPhone = `+25677${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
    expect((await member.client.post<Body>('/api/me/phone', { newPhone, password: PASSWORD })).body.error?.code).toBe('change.locked');
    await unlock(member, 'phone');
    expect((await member.client.post<Body>('/api/me/phone', { newPhone: '0777123456', password: PASSWORD })).body.error?.fields?.newPhone).toBeDefined();
    expect((await member.client.post<Body>('/api/me/phone', { newPhone: '+254712345678', password: PASSWORD })).body.error?.fields?.newPhone).toBeDefined();
    const res = await member.client.post<{ withdrawalsLockedUntil: string }>('/api/me/phone', { newPhone, password: PASSWORD });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const hours = (new Date(res.body.withdrawalsLockedUntil).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(47);
    const me = (await member.client.get<Body>('/api/me')).body.user as Body;
    expect([me.phone, me.phoneVerified]).toEqual([newPhone, true]);
    const audit = await app.owner.query<{ before: { phone: string }; after: { phone: string } }>(`SELECT before, after FROM audit_log WHERE action = 'member.phone_changed' AND target_id = $1`, [member.user.id]);
    expect([audit.rows[0]?.before.phone, audit.rows[0]?.after.phone]).toEqual([member.input.phone, newPhone]);
  });
});
