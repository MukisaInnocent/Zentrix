import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { announcementsJob } from '../../src/jobs/announcements.js';
import { startTestApp, type TestApp } from '../helpers/app.js';
import type { TestClient } from '../helpers/client.js';
import { createStaff, loginStaff, registerMember } from '../helpers/factories.js';

// Admins edit the wording of the automatic emails and send announcements to members, within the email allowance.
let app: TestApp;
let admin: TestClient;
let support: TestClient;

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call */
type Body = Record<string, any> & { error?: { code: string; fields?: Record<string, string[]> } };

beforeAll(async () => {
  app = await startTestApp({ TEST_AUTO_APPROVE: 'true' });
  admin = await loginStaff(app, await createStaff(app, ['admin']));
  support = await loginStaff(app, await createStaff(app, ['support']));
});
afterAll(async () => {
  await app.close();
});

const activate = async (m: Awaited<ReturnType<typeof registerMember>>) => {
  const info = await m.client.get<Body>('/api/payments/channels');
  const res = await m.client.post<Body>('/api/payments/deposits', { channel: info.body.channels[0].code, senderPhone: m.input.phone, providerTxnId: `T${randomUUID().slice(0, 8)}` }, { 'idempotency-key': randomUUID() });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
};

describe('email templates', () => {
  it('lets an admin reword an email with fill-ins, checks the wording, previews it and restores the default', async () => {
    const list = await support.get<Body>('/api/admin/email-templates');
    const signup = list.body.templates.find((t: Body) => t.kind === 'referral_signup');
    expect(signup).toMatchObject({ custom: false, version: 0, button: true });
    expect(signup.fillIns.map((f: Body) => f.name)).toEqual(['username', 'member', 'country']);

    const content = { subject: 'Great news, @{username}', heading: '{member} is in', body: 'Hi {username},\n\n{member} from {country} joined using your link.', buttonLabel: 'Open referrals' };
    expect((await support.put<Body>('/api/admin/email-templates/referral_signup', { content, note: 'Friendlier' })).status).toBe(403);
    const bad = await admin.put<Body>('/api/admin/email-templates/referral_signup', { content: { ...content, body: 'Hi {name}' }, note: 'Typo' });
    expect(bad.status).toBe(400);
    expect(bad.body.error?.fields?.body?.[0]).toContain('Unknown fill-in {name}');
    const noCode = await admin.put<Body>('/api/admin/email-templates/sign_in_code', { content: { subject: 'Your code', heading: 'Code', body: 'Here it is.' }, note: 'Shorter' });
    expect(noCode.body.error?.fields?.body?.[0]).toContain('Keep {code}');
    expect((await admin.put<Body>('/api/admin/email-templates/referral_signup', { content: { ...content, buttonLabel: undefined }, note: 'No button' })).body.error?.fields?.buttonLabel).toBeDefined();

    const preview = await admin.post<Body>('/api/admin/email-templates/referral_signup/preview', { content });
    expect(preview.body.preview).toMatchObject({ subject: 'Great news, @jane', heading: 'peter is in', paragraphs: ['Hi jane,', 'peter from Uganda joined using your link.'], buttonLabel: 'Open referrals' });
    expect((await admin.put<Body>('/api/admin/email-templates/referral_signup', { content, note: 'Friendlier wording' })).body.version).toBe(1);

    // The next sign-up with a link uses the new wording.
    const inviter = await registerMember(app);
    const invited = await registerMember(app, { referralCode: inviter.input.username });
    const mail = (await app.outbox(inviter.input.email)).find(m => m.subject === `Great news, @${inviter.input.username}`);
    expect(mail?.body).toContain(`${invited.input.username} from Uganda joined using your link.`);

    expect((await admin.post<Body>('/api/admin/email-templates/referral_signup/restore', { note: 'Back to the original' })).body.version).toBe(2);
    const third = await registerMember(app, { referralCode: inviter.input.username });
    expect((await app.outbox(inviter.input.email)).map(m => m.subject)).toContain(`Pexerearn: @${third.input.username} joined with your link`);
    expect((await support.get<Body>('/api/admin/email-templates/referral_signup/history')).body.history.map((h: Body) => h.version)).toEqual([2, 1]);
    const audits = await app.owner.query(`SELECT action FROM audit_log WHERE target_id = 'referral_signup' ORDER BY id`);
    expect(audits.rows.map(r => r.action)).toEqual(['email_template.changed', 'email_template.restored']);
  });

  it('leaves out a paragraph whose fill-in has no value', async () => {
    const res = await admin.post<Body>('/api/admin/email-templates/payment_withdrawal_cancelled/preview', {
      content: { subject: 'Cancelled {reference}', heading: 'Cancelled', body: 'Hello @{username}.\n\nReason: {reason}\n\nBye.' },
    });
    expect(res.body.preview.paragraphs).toEqual(['Hello @jane.', 'Reason: The transaction ID was not found on our statement.', 'Bye.']);
  });
});

describe('announcements', () => {
  it('sends to the chosen members, skips those who turned announcements off, and spreads over days within the allowance', async () => {
    const message = { subject: 'Pexerearn news', heading: 'Something new', body: 'First paragraph.\n\nSecond paragraph.', buttonLabel: 'Open Pexerearn', buttonUrl: 'https://staging.pexerearn.com/' };
    const activated = [await registerMember(app), await registerMember(app), await registerMember(app)];
    for (const m of activated) await activate(m);
    const optedOut = activated[2]!;
    await optedOut.client.put('/api/me/email-preferences', { referralRewards: true, signInAlerts: true, announcements: false });
    expect((await optedOut.client.get<Body>('/api/me/email-preferences')).body.preferences.announcements).toBe(false);
    const pending = await registerMember(app); // never activated

    const audience = async (a: string) => (await admin.get<Body>(`/api/admin/announcements/audience?audience=${a}`)).body.members as number;
    const [all, onlyActive, notActive] = [await audience('all'), await audience('activated'), await audience('not_activated')];
    expect(all).toBe(onlyActive + notActive);
    expect(notActive).toBeGreaterThanOrEqual(1);

    // A test email first, then the real send. Support may look but not send.
    expect((await admin.post<Body>('/api/admin/announcements/test', { to: 'me@zentrix.test', message: { ...message, audience: 'activated' } })).body.outcome).toBe('sent');
    expect((await app.outbox('me@zentrix.test'))[0]!.body).toContain('Second paragraph.');
    expect((await support.post<Body>('/api/admin/announcements', { ...message, audience: 'activated' })).status).toBe(403);
    expect((await admin.post<Body>('/api/admin/announcements', { ...message, buttonUrl: 'http://insecure.test', audience: 'all' })).status).toBe(400);

    // Only one email fits today: the allowance minus what was sent today minus the reserved part.
    const used = Number((await app.owner.query(`SELECT count(*) AS n FROM email_messages WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AND status NOT IN ('skipped', 'suppressed')`)).rows[0].n);
    const allowance = (daily: number) => admin.put('/api/admin/settings/email.allowance', { value: { daily, monthly: 1_000_000, reserved: 10 }, note: 'Test' });
    await allowance(used + 10 + 1);
    const sent = await admin.post<Body>('/api/admin/announcements', { ...message, audience: 'activated' });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    expect(sent.body).toMatchObject({ recipients: onlyActive, sentNow: 1 });
    const state = async () => (await support.get<Body>('/api/admin/announcements')).body.announcements.find((a: Body) => a.id === sent.body.id);
    expect((await state()).status).toBe('sending');

    // The daily job sends the rest once there is room again.
    await announcementsJob.run(app.services);
    expect((await state()).waiting).toBeGreaterThan(0);
    await allowance(100_000);
    await announcementsJob.run(app.services);
    const done = await state();
    expect(done).toMatchObject({ status: 'done', waiting: 0, recipients: onlyActive });
    expect(done.sent + done.skipped).toBe(onlyActive);

    const got = async (m: { input: { email: string } }) => (await app.outbox(m.input.email)).filter(x => x.subject === 'Pexerearn news').length;
    expect([await got(activated[0]!), await got(activated[1]!), await got(optedOut), await got(pending)]).toEqual([1, 1, 0, 0]);
    const skipped = await app.owner.query(
      `SELECT r.outcome FROM announcement_recipients r JOIN users u ON u.id = r.user_id WHERE u.username = $1`, [optedOut.input.username],
    );
    expect(skipped.rows).toEqual([{ outcome: 'opted_out' }]);
    expect((await app.owner.query(`SELECT 1 FROM audit_log WHERE action = 'announcement.sent' AND target_id = $1`, [sent.body.id])).rowCount).toBe(1);
  });

  it('can be cancelled while it is still sending', async () => {
    await registerMember(app);
    await admin.put('/api/admin/settings/email.allowance', { value: { daily: 1, monthly: 1, reserved: 0 }, note: 'Nothing left' });
    const sent = await admin.post<Body>('/api/admin/announcements', { subject: 'Second news', heading: 'Hi', body: 'Text', audience: 'not_activated' });
    expect(sent.body.sentNow).toBe(0);
    const cancel = await admin.post<Body>(`/api/admin/announcements/${sent.body.id}/cancel`, {});
    expect(cancel.body).toMatchObject({ ok: true, notSent: sent.body.recipients });
    expect((await admin.post<Body>(`/api/admin/announcements/${sent.body.id}/cancel`, {})).status).toBe(404);
    await admin.put('/api/admin/settings/email.allowance', { value: { daily: 100_000, monthly: 1_000_000, reserved: 0 }, note: 'Room again' });
    await announcementsJob.run(app.services);
    expect((await support.get<Body>('/api/admin/announcements')).body.announcements.find((a: Body) => a.id === sent.body.id)).toMatchObject({ status: 'cancelled', sent: 0 });
  });
});
