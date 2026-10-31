import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sendEmail } from '../../src/modules/email/send.js';
import { notifyReferralRewards } from '../../src/modules/notifications/notify.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import type { TestClient } from '../helpers/client.js';
import { createStaff, loginStaff, PASSWORD, registerMember } from '../helpers/factories.js';

// The email system: every email recorded, sent once, never to a blocked address, optional emails follow the
// member's choices, and Resend's signed delivery webhook updates the status and blocks bad addresses.
let app: TestApp;
let admin: TestClient;
let support: TestClient;
const SECRET = `whsec_${randomBytes(24).toString('base64')}`;

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call */
type Body = Record<string, any> & { error?: { code: string } };

beforeAll(async () => {
  app = await startTestApp({ RESEND_WEBHOOK_SECRET: SECRET, TEST_AUTO_APPROVE: 'true' });
  admin = await loginStaff(app, await createStaff(app, ['admin']));
  support = await loginStaff(app, await createStaff(app, ['support']));
});
afterAll(async () => {
  await app.close();
});

const status = async (id: string) => (await app.owner.query<{ status: string; detail: string | null }>('SELECT status, detail FROM email_messages WHERE id = $1', [id])).rows[0];
const lastId = async (to: string) => (await app.owner.query<{ id: string }>('SELECT id FROM email_messages WHERE recipient = $1 ORDER BY created_at DESC LIMIT 1', [to])).rows[0]!.id;
const address = () => `e_${randomUUID().slice(0, 8)}@zentrix.test`;

function webhook(event: unknown, opts: { secret?: string; age?: number; id?: string } = {}) {
  const body = JSON.stringify(event);
  const id = opts.id ?? `msg_${randomUUID()}`;
  const ts = String(Math.floor(Date.now() / 1000) - (opts.age ?? 0));
  const key = Buffer.from((opts.secret ?? SECRET).replace(/^whsec_/, ''), 'base64');
  const sig = createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
  return fetch(`${app.baseUrl}/api/webhooks/resend`, {
    method: 'POST', body, headers: { 'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` },
  });
}

describe('sending', () => {
  it('records every email in the branded layout, sends a (kind, ref) once and never to a blocked address', async () => {
    const to = address();
    const send = () => sendEmail(app.services, { to, kind: 'staff_test', category: 'account', ref: `once:${to}`, subject: 'Hello <b>', heading: 'Hi <script>', paragraphs: ['Line one\nline two'], button: { label: 'Open', url: 'https://example.com/?a=1&b=2' } });
    expect(await send()).toBe('sent');
    expect(await send()).toBe('duplicate');
    const [mail] = await app.outbox(to);
    expect(mail!.subject).toBe('Hello <b>');
    expect(mail!.body).toContain('Open: https://example.com/?a=1&b=2');
    expect(mail!.body).toContain('TEST MODE: no real money.');

    const blocked = address();
    await app.owner.query(`INSERT INTO email_suppressions (email, reason) VALUES ($1, 'bounced')`, [blocked]);
    expect(await sendEmail(app.services, { to: blocked.toUpperCase(), kind: 'staff_test', category: 'security', subject: 's', heading: 'h', paragraphs: [] })).toBe('suppressed');
    expect(await app.outbox(blocked.toUpperCase())).toEqual([]);
  });

  it('emails nothing on sign-in, but records every sign-in (owner, 2026-11-01)', async () => {
    const m = await registerMember(app);
    const login = (ua: string) => app.client().post('/api/auth/login', { identifier: m.input.username, password: PASSWORD }, { 'user-agent': ua });
    expect((await login('Phone A')).status).toBe(200);
    expect((await login('Laptop B')).status).toBe(200);
    await new Promise(r => setTimeout(r, 300));
    expect((await app.outbox(m.input.email)).filter(x => x.channel === 'email')).toEqual([]);
    const events = await app.owner.query(
      `SELECT a.user_agent FROM auth_events a JOIN users u ON u.id = a.user_id WHERE u.username = $1 AND a.kind = 'login' ORDER BY a.id`, [m.input.username],
    );
    expect(events.rows.map(r => r.user_agent)).toEqual(['Phone A', 'Laptop B']);
    await m.client.put('/api/me/email-preferences', { referralRewards: true, signInAlerts: false });
    expect((await m.client.get<Body>('/api/me/email-preferences')).body.preferences).toEqual({ referralRewards: true, signInAlerts: false, announcements: true });
    expect((await m.client.put<Body>('/api/me/email-preferences', { referralRewards: 'no' })).status).toBe(400);
  });

  it('emails each referral reward once, and not to a member who turned them off', async () => {
    const activate = async (memberIn: Awaited<ReturnType<typeof registerMember>>) => {
      const info = await memberIn.client.get<Body>('/api/payments/channels');
      const res = await memberIn.client.post<Body>('/api/payments/deposits', { channel: info.body.channels[0].code, senderPhone: memberIn.input.phone, providerTxnId: `T${randomUUID().slice(0, 8)}` }, { 'idempotency-key': randomUUID() });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    };
    const keen = await registerMember(app);
    const quiet = await registerMember(app);
    await activate(keen);
    await activate(quiet);
    await quiet.client.put('/api/me/email-preferences', { referralRewards: false, signInAlerts: true });
    const a = await registerMember(app, { referralCode: keen.input.username });
    const b = await registerMember(app, { referralCode: quiet.input.username });
    // Signing up sends nothing (owner, 2026-11-01): no confirmation, and the inviter hears only when the member activates.
    expect((await app.outbox(a.input.email)).filter(x => x.channel === 'email')).toEqual([]);
    expect((await app.outbox(keen.input.email)).filter(x => x.subject?.includes('joined with your link'))).toEqual([]);
    await activate(a);
    await activate(b);
    expect((await app.outbox(a.input.email)).map(x => x.subject)).toContain('Pexerearn: Welcome! Your account is active');
    await notifyReferralRewards(app.services); // a second run sends nothing new
    const rewardMails = async (to: string) => (await app.outbox(to)).filter(x => x.subject?.startsWith('Pexerearn: you earned'));
    const keenMails = await rewardMails(keen.input.email);
    expect(keenMails).toHaveLength(1);
    expect(keenMails[0]!.subject).toBe('Pexerearn: you earned UGX 10,000');
    expect(keenMails[0]!.body).toContain(`@${a.input.username} (Uganda) activated their account. Your level 1 referral reward is UGX 10,000.`);
    expect(await rewardMails(quiet.input.email)).toEqual([]);
  });
});

describe('delivery webhook', () => {
  it('needs a valid, fresh signature and ignores a replay', async () => {
    const to = address();
    await sendEmail(app.services, { to, kind: 'staff_test', category: 'account', subject: 's', heading: 'h', paragraphs: [] });
    const id = await lastId(to);
    const delivered = { type: 'email.delivered', data: { email_id: 'res_1', to: [to], tags: { message_id: id } } };
    expect((await webhook(delivered, { secret: `whsec_${randomBytes(24).toString('base64')}` })).status).toBe(401);
    expect((await webhook(delivered, { age: 600 })).status).toBe(401);
    expect((await fetch(`${app.baseUrl}/api/webhooks/resend`, { method: 'POST', body: '{}' })).status).toBe(401);
    expect((await webhook(delivered, { id: 'msg_fixed_1' })).status).toBe(200);
    expect(await status(id)).toMatchObject({ status: 'delivered' });
    // A late "sent" never moves it back; a replayed delivery id changes nothing.
    expect((await webhook({ type: 'email.sent', data: { email_id: 'res_1', tags: { message_id: id } } })).status).toBe(200);
    expect((await webhook({ type: 'email.bounced', data: { email_id: 'res_1', to: [to], tags: { message_id: id } } }, { id: 'msg_fixed_1' })).status).toBe(200);
    expect(await status(id)).toMatchObject({ status: 'delivered' });
  });

  it('blocks an address that bounces for good or reports spam, and an admin can unblock it', async () => {
    const to = address();
    await sendEmail(app.services, { to, kind: 'staff_test', category: 'account', subject: 's', heading: 'h', paragraphs: [] });
    const id = await lastId(to);
    const res = await webhook({ type: 'email.bounced', data: { email_id: 'res_2', to: [to], tags: { message_id: id }, bounce: { type: 'Permanent', subType: 'General', message: 'Mailbox does not exist' } } });
    expect(res.status).toBe(200);
    expect(await status(id)).toEqual({ status: 'bounced', detail: 'Mailbox does not exist' });
    expect(await sendEmail(app.services, { to, kind: 'staff_test', category: 'security', subject: 's', heading: 'h', paragraphs: [] })).toBe('suppressed');

    const list = await support.get<Body>('/api/admin/emails?status=bounced');
    expect(list.body.messages.some((m: Body) => m.id === id)).toBe(true);
    expect((await support.get<Body>('/api/admin/emails/suppressions')).body.suppressions.some((s: Body) => s.email === to)).toBe(true);
    expect((await support.post<Body>('/api/admin/emails/suppressions/remove', { email: to, reason: 'Fixed' })).status).toBe(403);
    expect((await admin.post<Body>('/api/admin/emails/suppressions/remove', { email: to, reason: 'Member fixed the mailbox' })).status).toBe(200);
    expect((await admin.post<Body>('/api/admin/emails/suppressions/remove', { email: to, reason: 'Again' })).status).toBe(404);
    expect((await app.owner.query(`SELECT 1 FROM audit_log WHERE action = 'email.suppression_removed' AND target_id = $1`, [to])).rowCount).toBe(1);
    expect(await sendEmail(app.services, { to, kind: 'staff_test', category: 'security', subject: 's', heading: 'h', paragraphs: [] })).toBe('sent');

    const spam = address();
    await sendEmail(app.services, { to: spam, kind: 'staff_test', category: 'account', subject: 's', heading: 'h', paragraphs: [] });
    await webhook({ type: 'email.complained', data: { email_id: 'res_3', to: [spam], tags: { message_id: await lastId(spam) } } });
    expect((await app.owner.query(`SELECT reason FROM email_suppressions WHERE email = $1`, [spam])).rows).toEqual([{ reason: 'complained' }]);
  });

  it('lets an admin send a test email, audited', async () => {
    const to = address();
    const res = await admin.post<Body>('/api/admin/emails/test', { to });
    expect(res.body).toEqual({ outcome: 'sent' });
    expect((await app.outbox(to))[0]!.subject).toBe('Pexerearn test email');
    expect((await support.post<Body>('/api/admin/emails/test', { to })).status).toBe(403);
  });
});
