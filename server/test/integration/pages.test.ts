import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app.js';

// The public pages load, and staff pages send signed-out visitors to sign in.
let app: TestApp;

beforeAll(async () => {
  app = await startTestApp();
});
afterAll(async () => {
  await app.close();
});

const page = (path: string) => fetch(app.baseUrl + path, { redirect: 'manual' });

describe('pages', () => {
  it('serves the landing, sign-in and password reset pages', async () => {
    for (const path of ['/', '/login', '/forgot-password', '/reset-password', '/register']) {
      const res = await page(path);
      expect([path, res.status, res.headers.get('content-type')?.split(';')[0]]).toEqual([path, 200, 'text/html']);
    }
    const landing = await (await page('/')).text();
    for (const id of ['id="services"', 'id="pricing"', 'id="guides"', 'id="contact"']) expect(landing).toContain(id);
    // No excluded features on the landing page (rule 3.4).
    expect(landing.toLowerCase()).not.toMatch(/betting|aviator|fixed bets|forex bots/);
    expect(await (await page('/login')).text()).toContain('href="/forgot-password"');
  });

  it('moves old .html links to the clean address and keeps the query (owner, 2026-11-08)', async () => {
    for (const [from, to] of [['/register.html?ref=peter', '/register?ref=peter'], ['/index.html', '/'], ['/referrals.html?level=2&view=overview', '/referrals?level=2&view=overview'], ['//evil.example/x.html', '/evil.example/x']] as [string, string][]) {
      const res = await page(from);
      expect([from, res.status, res.headers.get('location')]).toEqual([from, 301, to]);
    }
  });

  it('sends signed-out visitors from staff pages to sign in', async () => {
    for (const path of ['/admin/payment-methods', '/admin/outbox', '/admin/countries']) {
      const res = await page(path);
      expect([path, res.status, res.headers.get('location')?.startsWith('/login?next=')]).toEqual([path, 302, true]);
    }
  });
});
