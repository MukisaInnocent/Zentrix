import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { newMemberInput, registerMember } from '../helpers/factories.js';

let app: TestApp;
beforeAll(async () => {
  app = await startTestApp();
});
afterAll(async () => {
  await app.close();
});

type Body = { error?: { code: string; requestId?: string } } & Record<string, unknown>;

describe('security headers', () => {
  it('sends a strict CSP and hardening headers, and never caches API responses', async () => {
    const res = await app.client().get('/api/meta');
    const csp = res.headers.get('content-security-policy') ?? '';
    for (const directive of ["default-src 'self'", "script-src 'self'", "style-src 'self'", "object-src 'none'", "frame-ancestors 'none'", "base-uri 'none'"]) {
      expect(csp).toContain(directive);
    }
    expect(csp).not.toContain('unsafe-inline');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('permissions-policy')).toContain('camera=()');
    expect(res.headers.get('x-powered-by')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('marks the session cookie HttpOnly and SameSite=Lax, and the CSRF cookie SameSite=Strict', async () => {
    const client = app.client();
    const res = await client.request('POST', '/api/auth/register', newMemberInput());
    const cookies = res.headers.getSetCookie();
    const session = cookies.find(c => c.startsWith('zx_session='))!;
    const csrf = cookies.find(c => c.startsWith('zx_csrf='))!;
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite=Lax/i);
    expect(csrf).not.toMatch(/HttpOnly/i);
    expect(csrf).toMatch(/SameSite=Strict/i);
  });
});

describe('request forgery and input handling', () => {
  it('requires the CSRF header on state-changing calls made with a session', async () => {
    const { client } = await registerMember(app);
    const missing = await client.post<Body>('/api/auth/sessions/revoke-others', {}, { 'x-csrf-token': '' });
    expect(missing.status).toBe(403);
    expect(missing.body.error?.code).toBe('csrf.invalid');
    const wrong = await client.post<Body>('/api/auth/sessions/revoke-others', {}, { 'x-csrf-token': 'A'.repeat(43) });
    expect(wrong.body.error?.code).toBe('csrf.invalid');
  });

  it('blocks foreign origins, cross-site fetches and non-JSON bodies', async () => {
    const client = app.client();
    expect((await client.post<Body>('/api/auth/login', { identifier: 'a', password: 'b' }, { origin: 'https://evil.example' })).body.error?.code).toBe('csrf.origin');
    const headless = await fetch(`${app.baseUrl}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, body: '{}',
    });
    expect(headless.status).toBe(403);
    expect((await client.post('/api/auth/login', 'identifier=a&password=b', { 'content-type': 'application/x-www-form-urlencoded' })).status).toBe(415);
  });

  it('answers malformed and oversized JSON with clear errors', async () => {
    const client = app.client();
    expect((await client.post<Body>('/api/auth/login', '{"identifier":', {})).body.error?.code).toBe('invalid_json');
    const big = JSON.stringify({ identifier: 'x'.repeat(40_000), password: 'y' });
    expect((await client.post<Body>('/api/auth/login', big)).status).toBe(413);
  });

  it('rate-limits sign-ups per IP and says so in standard headers', async () => {
    const client = app.client();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await client.post('/api/auth/register', newMemberInput())).status);
    expect(statuses.slice(0, 5).every(s => s === 201 || s === 409)).toBe(true);
    const limited = await client.post<Body>('/api/auth/register', newMemberInput());
    expect(limited.status).toBe(429);
    expect(limited.body.error?.code).toBe('rate_limited');
    expect(limited.headers.get('ratelimit-policy')).toBeTruthy();
  });

  it('hides internals: unknown API routes give JSON 404 and errors carry a request id', async () => {
    const res = await app.client().get<Body>('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('api.not_found');
    expect(res.body.error?.requestId).toBeTruthy();
  });
});

describe('operations endpoints', () => {
  it('reports health and readiness', async () => {
    expect((await app.client().get('/healthz')).body).toEqual({ status: 'ok' });
    expect((await app.client().get('/readyz')).body).toEqual({ status: 'ready', mode: 'test' });
  });

  it('tells the browser it is in test mode', async () => {
    expect((await app.client().get<{ testMode: boolean }>('/api/meta')).body.testMode).toBe(true);
  });
});
