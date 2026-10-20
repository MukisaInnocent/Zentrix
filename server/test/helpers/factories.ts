import { randomInt } from 'node:crypto';
import { expect } from 'vitest';
import { withTransaction } from '../../src/db/tx.js';
import type { Role } from '../../src/modules/auth/context.js';
import { newTotpSecret, totpCodeAt } from '../../src/modules/auth/totp.js';
import { createUserDirect } from '../../src/modules/users/create.js';
import type { TestApp } from './app.js';
import type { TestClient } from './client.js';

export const PASSWORD = 'correct-horse-battery-9';

export const uniquePhoneUG = () => `+25670${String(randomInt(0, 10_000_000)).padStart(7, '0')}`;

export function newMemberInput(overrides: Record<string, unknown> = {}) {
  const tag = `${Date.now().toString(36)}${randomInt(0, 46_656).toString(36)}`;
  return {
    username: `m_${tag}`.slice(0, 30),
    email: `m_${tag}@zentrix.test`,
    password: PASSWORD,
    country: 'UG',
    phone: uniquePhoneUG(),
    dateOfBirth: '1995-05-05',
    timezone: 'Africa/Kampala',
    acceptTerms: true,
    acceptPrivacy: true,
    ...overrides,
  };
}

export interface Member {
  client: TestClient;
  input: ReturnType<typeof newMemberInput>;
  user: { id: string; username: string; referralCode: string; email: string; phone: string; referrer: { username: string } | null };
}

export async function registerMember(app: TestApp, overrides: Record<string, unknown> = {}): Promise<Member> {
  const client = app.client();
  const input = newMemberInput(overrides);
  const res = await client.post<{ user: Member['user'] }>('/api/auth/register', input);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { client, input, user: res.body.user };
}

export interface Staff {
  username: string;
  password: string;
  totpSecret: string | null;
  publicId: string;
  userId: number;
}

export async function createStaff(app: TestApp, roles: Role[], opts: { totp?: boolean } = {}): Promise<Staff> {
  const input = newMemberInput();
  const totpSecret = opts.totp === false ? null : newTotpSecret();
  const created = await withTransaction(app.owner, db =>
    createUserDirect(db, app.services.config.dataEncryptionKey, {
      username: input.username, email: input.email, phone: input.phone, country: 'UG', dateOfBirth: '1990-01-01',
      password: PASSWORD, roles: [...roles, 'member'], verified: true, ...(totpSecret ? { totpSecret } : {}),
    }),
  );
  return { username: input.username, password: PASSWORD, totpSecret, publicId: created.publicId, userId: created.id };
}

// Signs a staff member in through both steps. The test clock moves just past the account's last used TOTP
// step, because codes cannot be replayed.
export async function loginStaff(app: TestApp, staff: Staff): Promise<TestClient> {
  const client = app.client();
  const first = await client.post<{ mfaRequired?: boolean; challengeToken?: string }>('/api/auth/login', {
    identifier: staff.username, password: staff.password,
  });
  expect(first.status, JSON.stringify(first.body)).toBe(200);
  if (!staff.totpSecret) return client;
  expect(first.body.mfaRequired).toBe(true);
  const { rows } = await app.owner.query<{ last_used_step: string | null }>('SELECT last_used_step FROM totp_credentials WHERE user_id = $1', [staff.userId]);
  const lastStep = rows[0]?.last_used_step ?? null;
  const last = lastStep === null ? -1 : Number(lastStep);
  const now = new Date(Math.max(Date.now(), (last + 1) * 30_000 + 1_000));
  app.setNow(now);
  const second = await client.post('/api/auth/login/mfa', { challengeToken: first.body.challengeToken, code: totpCodeAt(staff.totpSecret, now) });
  app.setNow(null);
  expect(second.status, JSON.stringify(second.body)).toBe(200);
  return client;
}

export function linkToken(body: string, key: string): string {
  const match = new RegExp(`#${key}=([A-Za-z0-9_-]{43})`).exec(body);
  if (!match?.[1]) throw new Error(`No ${key} token in message: ${body}`);
  return match[1];
}

export function smsCode(body: string): string {
  const match = /code is ([0-9]{6})/.exec(body);
  if (!match?.[1]) throw new Error(`No code in SMS: ${body}`);
  return match[1];
}
