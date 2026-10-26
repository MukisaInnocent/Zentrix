import serverless from 'serverless-http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { TEST_ORIGIN } from '../helpers/client.js';
import { newMemberInput } from '../helpers/factories.js';

// The Express app behind API Gateway (HTTP API, payload format 2.0) through serverless-http, as on AWS Lambda.
let app: TestApp;
type Handler = (event: object, context: object) => Promise<{ statusCode: number; headers?: Record<string, string>; cookies?: string[]; body: string }>;
let handler: Handler;

beforeAll(async () => {
  app = await startTestApp();
  handler = serverless(createApp(app.services)) as unknown as Handler;
});
afterAll(async () => {
  await app.close();
});

function httpEvent(method: string, path: string, opts: { body?: unknown; cookies?: string[]; headers?: Record<string, string> } = {}) {
  const [rawPath, rawQueryString = ''] = path.split('?');
  return {
    version: '2.0', routeKey: '$default', rawPath, rawQueryString, cookies: opts.cookies,
    headers: { host: 'abc123.execute-api.eu-west-1.amazonaws.com', 'x-forwarded-for': '198.51.100.7', 'content-type': 'application/json', origin: TEST_ORIGIN, ...opts.headers },
    requestContext: { http: { method, path: rawPath, sourceIp: '198.51.100.7', protocol: 'HTTP/1.1', userAgent: 'vitest' }, requestId: 'test', stage: '$default' },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body), isBase64Encoded: false,
  };
}

describe('API on Lambda', () => {
  it('answers health checks and serves pages', async () => {
    const health = await handler(httpEvent('GET', '/healthz'), {});
    expect([health.statusCode, JSON.parse(health.body)]).toEqual([200, { status: 'ok' }]);
    const page = await handler(httpEvent('GET', '/login.html'), {});
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('forgot-password.html');
  });

  it('registers a member and keeps the session cookie and CSRF checks working', async () => {
    const res = await handler(httpEvent('POST', '/api/auth/register', { body: newMemberInput() }), {});
    expect(res.statusCode, res.body).toBe(201);
    const cookies = (res.cookies ?? []).map(c => c.split(';')[0]!);
    expect(cookies.some(c => c.includes('zx_session'))).toBe(true);
    const me = await handler(httpEvent('GET', '/api/me', { cookies }), {});
    expect(me.statusCode).toBe(200);
    // A state-changing request without the CSRF token is refused.
    const noCsrf = await handler(httpEvent('POST', '/api/auth/logout', { cookies, body: {} }), {});
    expect(noCsrf.statusCode).toBe(403);
    // Another site's origin is refused.
    const foreign = await handler(httpEvent('POST', '/api/auth/register', { body: newMemberInput(), headers: { origin: 'https://evil.example' } }), {});
    expect(foreign.statusCode).toBe(403);
  });
});
