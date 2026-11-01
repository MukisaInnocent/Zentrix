import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../helpers/app.js';
import { createStaff, loginStaff, registerMember } from '../helpers/factories.js';

// The Contact page form (owner, 2026-11-01): a message is emailed to the support address an admin sets in Settings,
// with the sender's address as reply-to, so support answers from their own inbox.
let app: TestApp;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Body = Record<string, any>;
const SUPPORT = 'help@pexerearn.com';

beforeAll(async () => {
  app = await startTestApp();
  const admin = await loginStaff(app, await createStaff(app, ['admin']));
  const saved = await admin.put<Body>('/api/admin/settings/support.contact', { value: { email: SUPPORT, phone: '+256 700 111 222', hours: 'Every day' }, note: 'Test' });
  expect(saved.status).toBe(200);
});
afterAll(async () => {
  await app.close();
});

const mails = async () => (await app.outbox(SUPPORT)).filter(m => m.subject?.startsWith('Contact form:'));

describe('contact form', () => {
  it('emails a visitor\'s message to support, and needs a reply address from a visitor who is not signed in', async () => {
    const visitor = app.client();
    const noEmail = await visitor.post<Body>('/api/support/messages', { subject: 'A question', message: 'How do I pay the activation fee?' });
    expect(noEmail.body.error?.fields?.email).toBeDefined();
    const short = await visitor.post<Body>('/api/support/messages', { email: 'visitor@gmail.com', subject: 'Hi', message: 'Short' });
    expect(short.status).toBe(400);
    const res = await visitor.post<Body>('/api/support/messages', { email: 'visitor@gmail.com', subject: 'A question', message: 'How do I pay the activation fee?' });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    const [mail] = await mails();
    expect(mail?.subject).toBe('Contact form: A question');
    expect(mail?.body).toContain('How do I pay the activation fee?');
    expect(mail?.body).toContain('visitor@gmail.com');
  });

  it('uses a signed-in member\'s username and account email', async () => {
    const member = await registerMember(app);
    const res = await member.client.post<Body>('/api/support/messages', { subject: 'My withdrawal', message: 'My withdrawal has been waiting since this morning.' });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    const mail = (await mails()).find(m => m.subject === 'Contact form: My withdrawal');
    expect(mail?.body).toContain(`@${member.input.username}`);
    expect(mail?.body).toContain(member.input.email);
  });
});
