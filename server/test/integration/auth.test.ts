import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { linkToken, newMemberInput, PASSWORD, registerMember, smsCode, uniquePhoneUG } from '../helpers/factories.js';

let app: TestApp;
beforeAll(async () => {
  app = await startTestApp();
});
afterAll(async () => {
  await app.close();
});

type Body = Record<string, unknown> & { error?: { code: string; fields?: Record<string, string[]> }; user?: Record<string, unknown> };

describe('registration', () => {
  it('creates a member, signs them in and sets session and CSRF cookies', async () => {
    const { client, input, user } = await registerMember(app);
    expect(user).toMatchObject({ username: input.username, email: input.email, currency: 'UGX', status: 'active', emailVerified: false, phoneVerified: false, roles: ['member'], isStaff: false });
    expect(user.referralCode).toMatch(/^[A-Z2-9]{8}$/);
    expect(client.cookies.has('zx_session')).toBe(true);
    expect(client.cookies.has('zx_csrf')).toBe(true);
    const me = await client.get<Body>('/api/me');
    expect(me.status).toBe(200);
    expect(me.body.user?.username).toBe(input.username);
    const consents = await app.owner.query(`SELECT kind FROM consents c JOIN users u ON u.id = c.user_id WHERE u.username = $1 ORDER BY kind`, [input.username]);
    expect(consents.rows.map(r => r.kind)).toEqual(['privacy', 'terms']);
  });

  it('refuses local-format or wrong-country phones, weak passwords, blocked countries, a date of birth and unknown fields', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ dateOfBirth: '2000-01-01' }, '_form'],
      [{ phone: '12345' }, 'phone'],
      [{ phone: '0700123456' }, 'phone'],
      [{ phone: '+254712345678' }, 'phone'],
      [{ password: 'password123' }, 'password'],
      [{ country: 'KP', phone: '+850191234567' }, 'country'],
      [{ referralCode: 'nobody_has_this' }, 'referralCode'],
      [{ acceptTerms: false }, 'acceptTerms'],
      [{ isAdmin: true }, '_form'],
    ];
    for (const [overrides, fieldName] of cases) {
      // A fresh client (and IP) per case: the sign-up limit is 5 per hour per IP.
      const res = await app.client().post<Body>('/api/auth/register', newMemberInput(overrides));
      expect(res.status, fieldName).toBe(400);
      expect(Object.keys(res.body.error?.fields ?? {}), fieldName).toContain(fieldName);
    }
  });

  it('reports a taken username but keeps email and phone conflicts generic', async () => {
    const { input } = await registerMember(app);
    const client = app.client();
    const sameUsername = await client.post<Body>('/api/auth/register', newMemberInput({ username: input.username }));
    expect(sameUsername.status).toBe(409);
    expect(sameUsername.body.error?.code).toBe('auth.username_taken');
    const sameEmail = await client.post<Body>('/api/auth/register', newMemberInput({ email: input.email }));
    const samePhone = await client.post<Body>('/api/auth/register', newMemberInput({ phone: input.phone }));
    expect(sameEmail.body.error?.code).toBe('auth.registration_conflict');
    expect(samePhone.body.error?.code).toBe('auth.registration_conflict');
  });

  it('attaches a direct referrer from their username, with or without an @', async () => {
    const referrer = await registerMember(app);
    const { user } = await registerMember(app, { referralCode: referrer.user.username });
    expect(user.referrer).toEqual({ username: referrer.user.username });
    const second = await registerMember(app, { referralCode: `@${referrer.user.username.toUpperCase()}` });
    expect(second.user.referrer).toEqual({ username: referrer.user.username });
  });

  it('accepts a number that starts with the country code, with or without the plus', async () => {
    const input = newMemberInput();
    const withoutPlus = await app.client().post<Body>('/api/auth/register', { ...input, phone: input.phone.replace('+', '') });
    expect(withoutPlus.status, JSON.stringify(withoutPlus.body)).toBe(201);
    expect(withoutPlus.body.user?.phone).toBe(input.phone);
  });

  it('lets every open country register in its own currency and refuses the blocked ones', async () => {
    const list = await app.client().get<{ countries: { code: string; currency: string; dialCode: string }[] }>('/api/reference/countries');
    const codes = list.body.countries.map(c => c.code);
    expect(list.body.countries.length).toBeGreaterThan(150);
    expect(codes).toEqual(expect.arrayContaining(['UG', 'KE', 'JP', 'BR', 'GB', 'US', 'IN', 'ZA', 'FR']));
    expect(codes).not.toContain('KP');
    const jp = list.body.countries.find(c => c.code === 'JP')!;
    expect([jp.currency, jp.dialCode]).toEqual(['JPY', '81']);
    const res = await app.client().post<Body>('/api/auth/register', newMemberInput({ country: 'JP', phone: '+819012345678' }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.user).toMatchObject({ currency: 'JPY', country: { code: 'JP' } });
    // Every open country has a placeholder activation fee, or an admin must set one.
    const missing = await app.owner.query(`SELECT c.code FROM countries c JOIN currencies k ON k.code = c.currency_code WHERE NOT c.blocked AND NOT EXISTS (SELECT 1 FROM current_country_configs x WHERE x.country_code = c.code) ORDER BY c.code`);
    expect(missing.rows.length).toBeLessThan(20);
  });

  it('guesses the country from the browser time zone and never offers a blocked one', async () => {
    const detect = (tz: string) => app.client().get<{ country: string | null }>(`/api/reference/detect?tz=${encodeURIComponent(tz)}`);
    expect((await detect('Africa/Kampala')).body.country).toBe('UG');
    expect((await detect('Asia/Tokyo')).body.country).toBe('JP');
    expect((await detect('Nowhere/Land')).body.country).toBeNull();
    expect((await detect('Asia/Pyongyang')).body.country).toBeNull();
  });

  it('flags phone-country and IP-country mismatches for review instead of blocking', async () => {
    const client = app.client();
    const input = newMemberInput();
    const res = await client.post<Body>('/api/auth/register', input, { 'x-test-geo-country': 'KE' });
    expect(res.status).toBe(201);
    const flags = await app.owner.query(`SELECT kind FROM fraud_flags f JOIN users u ON u.id = f.user_id WHERE u.username = $1 ORDER BY kind`, [input.username]);
    expect(flags.rows.map(r => r.kind)).toEqual(['ip_country_mismatch']);
  });
});

describe('verification', () => {
  it('verifies email through the emailed link, once', async () => {
    const { client, input } = await registerMember(app);
    const [mail] = await app.outbox(input.email);
    const token = linkToken(mail!.body, 'email');
    const anon = app.client();
    expect((await anon.post('/api/auth/verify/email', { token })).status).toBe(200);
    expect((await anon.post('/api/auth/verify/email', { token })).status).toBe(400);
    expect((await client.get<Body>('/api/me')).body.user?.emailVerified).toBe(true);
  });

  it('verifies the phone with the texted code and counts wrong attempts', async () => {
    const { client, user } = await registerMember(app);
    const [sms] = await app.outbox(user.phone);
    const code = smsCode(sms!.body);
    const wrong = code === '000000' ? '111111' : '000000';
    expect((await client.post('/api/auth/verify/phone', { code: wrong })).status).toBe(400);
    expect((await client.post('/api/auth/verify/phone', { code })).status).toBe(200);
    expect((await client.get<Body>('/api/me')).body.user?.phoneVerified).toBe(true);
  });
});

describe('login and sessions', () => {
  it('signs in by username, email or phone, with one generic error for every failure', async () => {
    const { input } = await registerMember(app);
    for (const identifier of [input.username, input.email.toUpperCase(), input.phone]) {
      expect((await app.client().post('/api/auth/login', { identifier, password: PASSWORD })).status).toBe(200);
    }
    const wrong = await app.client().post<Body>('/api/auth/login', { identifier: input.username, password: 'wrong-password-123' });
    const unknown = await app.client().post<Body>('/api/auth/login', { identifier: 'nobody_here_42', password: 'wrong-password-123' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    const pick = (b: Body) => ({ code: b.error?.code, message: (b.error as { message?: string } | undefined)?.message });
    expect(pick(wrong.body)).toEqual(pick(unknown.body));
    expect(pick(wrong.body).code).toBe('auth.invalid_credentials');
  });

  it('locks the account for 15 minutes after 10 failed attempts, on top of the per-account throttle', async () => {
    const { input } = await registerMember(app);
    for (let i = 0; i < 10; i++) {
      await app.client().post('/api/auth/login', { identifier: input.email, password: `wrong-password-${i}` });
    }
    // The 11th attempt is throttled by the per-identifier rate limit...
    expect((await app.client().post('/api/auth/login', { identifier: input.email, password: PASSWORD })).status).toBe(429);
    const locked = await app.owner.query('SELECT locked_until FROM users WHERE email = $1', [input.email]);
    expect(locked.rows[0].locked_until).toBeInstanceOf(Date);
    // ...and once the throttle window is gone, the account lockout still refuses the right password.
    await app.owner.query('DELETE FROM rate_limits');
    expect((await app.client().post('/api/auth/login', { identifier: input.email, password: PASSWORD })).status).toBe(401);
    await app.owner.query('DELETE FROM rate_limits');
    app.setNow(new Date(Date.now() + 16 * 60_000));
    expect((await app.client().post('/api/auth/login', { identifier: input.email, password: PASSWORD })).status).toBe(200);
    app.setNow(null);
  });

  it('logs out by revoking the session server-side', async () => {
    const { client } = await registerMember(app);
    const stolen = new Map(client.cookies);
    expect((await client.post('/api/auth/logout')).status).toBe(200);
    expect((await client.get('/api/me')).status).toBe(401);
    const replay = app.client();
    stolen.forEach((v, k) => replay.cookies.set(k, v));
    expect((await replay.get('/api/me')).status).toBe(401);
  });

  it('lists and revokes only the member\'s own sessions', async () => {
    const { client, input } = await registerMember(app);
    const laptop = app.client();
    await laptop.post('/api/auth/login', { identifier: input.username, password: PASSWORD });
    const list = await client.get<{ sessions: { id: string; current: boolean }[] }>('/api/auth/sessions');
    expect(list.body.sessions).toHaveLength(2);
    const other = await registerMember(app);
    const otherSessions = await other.client.get<{ sessions: { id: string }[] }>('/api/auth/sessions');
    expect((await client.delete(`/api/auth/sessions/${otherSessions.body.sessions[0]!.id}`)).status).toBe(404);
    expect((await other.client.get('/api/me')).status).toBe(200);
    expect((await client.post('/api/auth/sessions/revoke-others')).body).toEqual({ revoked: 1 });
    expect((await laptop.get('/api/me')).status).toBe(401);
    expect((await client.get('/api/me')).status).toBe(200);
  });
});

describe('password reset and change', () => {
  it('answers the same for unknown emails and resets with a single-use link that ends all sessions', async () => {
    const { client, input } = await registerMember(app);
    const anon = app.client();
    expect((await anon.post('/api/auth/password/forgot', { email: 'nobody@zentrix.test' })).status).toBe(202);
    expect((await anon.post('/api/auth/password/forgot', { email: input.email })).status).toBe(202);
    const mail = (await app.outbox(input.email)).find(m => m.subject?.includes('Reset'));
    const token = linkToken(mail!.body, 'token');
    expect((await anon.post('/api/auth/password/reset', { token, password: 'a-brand-new-passphrase' })).status).toBe(200);
    expect((await anon.post('/api/auth/password/reset', { token, password: 'another-new-passphrase' })).status).toBe(400);
    expect((await client.get('/api/me')).status).toBe(401);
    expect((await app.client().post('/api/auth/login', { identifier: input.username, password: 'a-brand-new-passphrase' })).status).toBe(200);
  });

  it('refuses a password change until an admin has unlocked it', async () => {
    const { client } = await registerMember(app);
    const res = await client.post<Body>('/api/auth/password/change', { currentPassword: PASSWORD, newPassword: 'fresh-passphrase-77' });
    expect(res.status).toBe(403);
    expect(res.body.error?.code).toBe('change.locked');
  });
});

describe('profile', () => {
  it('lets members change time zone but not phone, username or country', async () => {
    const { client } = await registerMember(app);
    expect((await client.patch<Body>('/api/me', { timezone: 'Africa/Nairobi' })).body.user?.timezone).toBe('Africa/Nairobi');
    expect((await client.patch('/api/me', { phone: uniquePhoneUG() })).status).toBe(400);
    expect((await client.patch('/api/me', { country: 'KE' })).status).toBe(400);
    expect((await client.patch('/api/me', { timezone: 'Mars/Olympus' })).status).toBe(400);
  });
});
