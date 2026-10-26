import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { totpCodeAt } from '../../src/modules/auth/totp.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import type { TestClient } from '../helpers/client.js';
import { createStaff, loginStaff, PASSWORD, registerMember } from '../helpers/factories.js';

let app: TestApp;
beforeAll(async () => {
  app = await startTestApp();
});
afterAll(async () => {
  await app.close();
});
afterEach(() => app.setNow(null));

type Body = Record<string, unknown> & { error?: { code: string } };
const step = (n: number) => new Date((Math.floor(Date.now() / 30_000) + n) * 30_000 + 1_000);

async function enrol(client: TestClient, at: Date): Promise<{ secret: string; recoveryCodes: string[] }> {
  const setup = await client.post<{ secret: string; otpauthUrl: string; qrSvg: string }>('/api/auth/totp/setup');
  expect(setup.status).toBe(200);
  expect(setup.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\/Pexerearn:/);
  expect(setup.body.qrSvg).toContain('<svg');
  app.setNow(at);
  expect((await client.post('/api/auth/totp/enable', { code: '000000' === totpCodeAt(setup.body.secret, at) ? '111111' : '000000' })).status).toBe(400);
  const enabled = await client.post<{ recoveryCodes: string[] }>('/api/auth/totp/enable', { code: totpCodeAt(setup.body.secret, at) });
  expect(enabled.status).toBe(200);
  return { secret: setup.body.secret, recoveryCodes: enabled.body.recoveryCodes };
}

describe('member two-step verification', () => {
  it('enrols, then requires a fresh code at login and refuses replays', async () => {
    const { client, input } = await registerMember(app);
    const { secret, recoveryCodes } = await enrol(client, step(1));
    expect(recoveryCodes).toHaveLength(10);
    expect((await client.get<{ enabled: boolean }>('/api/auth/totp')).body).toMatchObject({ enabled: true, recoveryCodesLeft: 10 });

    const fresh = app.client();
    const first = await fresh.post<{ mfaRequired: boolean; challengeToken: string }>('/api/auth/login', { identifier: input.username, password: PASSWORD });
    expect(first.body.mfaRequired).toBe(true);
    expect(fresh.cookies.has('zx_session')).toBe(false);
    // The code used for enrolment (step 1) cannot be replayed; the next step works.
    app.setNow(step(1));
    expect((await fresh.post<Body>('/api/auth/login/mfa', { challengeToken: first.body.challengeToken, code: totpCodeAt(secret, step(1)) })).body.error?.code).toBe('auth.mfa_invalid');
    app.setNow(step(2));
    expect((await fresh.post('/api/auth/login/mfa', { challengeToken: first.body.challengeToken, code: totpCodeAt(secret, step(2)) })).status).toBe(200);
    expect((await fresh.get('/api/me')).status).toBe(200);
  });

  it('accepts each recovery code once', async () => {
    const { client, input } = await registerMember(app);
    const { recoveryCodes } = await enrol(client, step(1));
    const code = recoveryCodes[0]!;
    const login = async () => {
      const c = app.client();
      const first = await c.post<{ challengeToken: string }>('/api/auth/login', { identifier: input.username, password: PASSWORD });
      return c.post('/api/auth/login/mfa', { challengeToken: first.body.challengeToken, code: code.toLowerCase() });
    };
    expect((await login()).status).toBe(200);
    expect((await login()).status).toBe(401);
  });

  it('expires the challenge after five minutes or five wrong codes', async () => {
    const { client, input } = await registerMember(app);
    const { secret } = await enrol(client, step(1));
    const c = app.client();
    const first = await c.post<{ challengeToken: string }>('/api/auth/login', { identifier: input.username, password: PASSWORD });
    for (let i = 0; i < 5; i++) await c.post('/api/auth/login/mfa', { challengeToken: first.body.challengeToken, code: '999999' });
    app.setNow(step(3));
    expect((await c.post<Body>('/api/auth/login/mfa', { challengeToken: first.body.challengeToken, code: totpCodeAt(secret, step(3)) })).body.error?.code).toBe('auth.mfa_expired');
    app.setNow(null);
    const second = await c.post<{ challengeToken: string }>('/api/auth/login', { identifier: input.username, password: PASSWORD });
    app.setNow(new Date(Date.now() + 6 * 60_000));
    const late = await c.post<Body>('/api/auth/login/mfa', { challengeToken: second.body.challengeToken, code: totpCodeAt(secret, new Date(Date.now() + 6 * 60_000)) });
    expect(late.body.error?.code).toBe('auth.mfa_expired');
  });

  it('lets a member turn it off with password and code', async () => {
    const { client, input } = await registerMember(app);
    const { secret } = await enrol(client, step(1));
    app.setNow(step(2));
    expect((await client.post('/api/auth/totp/disable', { password: PASSWORD, code: totpCodeAt(secret, step(2)) })).status).toBe(200);
    const again = await app.client().post<Body>('/api/auth/login', { identifier: input.username, password: PASSWORD });
    expect(again.body.mfaRequired).toBeUndefined();
    expect(again.status).toBe(200);
  });
});

describe('staff access', () => {
  it('refuses admin APIs to members and to staff sessions without a verified authenticator', async () => {
    const member = await registerMember(app);
    expect((await member.client.get<Body>('/api/admin/members')).body.error?.code).toBe('auth.forbidden');

    const staff = await createStaff(app, ['support'], { totp: false });
    const c = app.client();
    const login = await c.post<Body>('/api/auth/login', { identifier: staff.username, password: PASSWORD });
    expect(login.body.mfaEnrollmentRequired).toBe(true);
    expect((await c.get<Body>('/api/admin/members')).body.error?.code).toBe('auth.mfa_required');
    await enrol(c, step(1));
    expect((await c.get('/api/admin/members')).status).toBe(200);
    app.setNow(step(2));
    expect((await c.post<Body>('/api/auth/totp/disable', { password: PASSWORD, code: '123456' })).body.error?.code).toBe('totp.required_for_staff');
  });

  it('signs a user out everywhere when their roles change', async () => {
    const admin = await createStaff(app, ['admin']);
    const adminClient = await loginStaff(app, admin);
    const member = await registerMember(app);
    expect((await adminClient.post(`/api/admin/members/${member.user.id}/roles`, { role: 'support', grant: true })).status).toBe(200);
    expect((await member.client.get('/api/me')).status).toBe(401);
  });
});

describe('session lifetime', () => {
  it('rotates the token after 12 hours and honours the old one only for a short grace period', async () => {
    const { client } = await registerMember(app);
    const oldToken = client.cookies.get('zx_session')!;
    const later = new Date(Date.now() + 13 * 3_600_000);
    app.setNow(later);
    expect((await client.get('/api/me')).status).toBe(200);
    const newToken = client.cookies.get('zx_session')!;
    expect(newToken).not.toBe(oldToken);
    const old = app.client();
    old.cookies.set('zx_session', oldToken);
    expect((await old.get('/api/me')).status).toBe(200);
    app.setNow(new Date(later.getTime() + 2 * 60_000));
    const stale = app.client();
    stale.cookies.set('zx_session', oldToken);
    expect((await stale.get('/api/me')).status).toBe(401);
    expect((await client.get('/api/me')).status).toBe(200);
  });

  it('ends idle member sessions after 24 hours and staff sessions after 12 hours in total', async () => {
    const { client } = await registerMember(app);
    app.setNow(new Date(Date.now() + 25 * 3_600_000));
    expect((await client.get('/api/me')).status).toBe(401);
    app.setNow(null);
    const staff = await createStaff(app, ['support']);
    const staffClient = await loginStaff(app, staff);
    for (let h = 1; h <= 12; h++) {
      app.setNow(new Date(Date.now() + h * 25 * 60_000));
      await staffClient.get('/api/me');
    }
    app.setNow(new Date(Date.now() + 13 * 3_600_000));
    expect((await staffClient.get('/api/me')).status).toBe(401);
  });
});

describe('emailed sign-in codes', () => {
  it('emails a single-use 6-digit code at the second step and accepts it instead of the authenticator code', async () => {
    const staff = await createStaff(app, ['admin']);
    const email = (await app.owner.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [staff.userId])).rows[0]!.email;
    const client = app.client();
    const first = await client.post<{ challengeToken: string; emailSent: boolean }>('/api/auth/login', { identifier: staff.username, password: staff.password });
    expect(first.body.emailSent).toBe(true);
    const mail = (await app.outbox(email)).find(m => m.subject === 'Your Pexerearn sign-in code');
    const code = /code is ([0-9]{6})/.exec(mail?.body ?? '')?.[1];
    expect(code).toBeDefined();
    const wrong = code === '000000' ? '111111' : '000000';
    expect((await client.post<Body>('/api/auth/login/mfa', { challengeToken: first.body.challengeToken, code: wrong })).body.error?.code).toBe('auth.mfa_invalid');
    const ok = await client.post('/api/auth/login/mfa', { challengeToken: first.body.challengeToken, code });
    expect(ok.status).toBe(200);
    expect((await client.get('/api/admin/payments/overview')).status).toBe(200);
    expect((await app.client().post<Body>('/api/auth/login/mfa', { challengeToken: first.body.challengeToken, code })).body.error?.code).toBe('auth.mfa_expired');
  });
});
