import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { newMemberInput } from '../helpers/factories.js';

// A custom domain becomes PUBLIC_ORIGIN while the temporary CloudFront link stays usable through EXTRA_ORIGINS.
let app: TestApp;

beforeAll(async () => {
  app = await startTestApp({ EXTRA_ORIGINS: 'https://temporary.cloudfront.example' });
});
afterAll(async () => {
  await app.close();
});

const register = (origin: string) => fetch(`${app.baseUrl}/api/auth/register`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(newMemberInput()),
});

describe('allowed site addresses', () => {
  it('accepts requests from an extra origin and still refuses other sites', async () => {
    expect((await register('https://temporary.cloudfront.example')).status).toBe(201);
    expect((await register('https://evil.example')).status).toBe(403);
  });
});
