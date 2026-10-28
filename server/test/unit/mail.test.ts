import { afterEach, describe, expect, it, vi } from 'vitest';
import { isReservedAddress, ResendMailer } from '../../src/providers/mail.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('outgoing email', () => {
  it('recognises the fake addresses of test accounts', () => {
    for (const to of ['zx_admin@zentrix.test', 'm_1@zentrix.test', 'a@b.example', 'x@y.invalid', 'me@localhost']) expect(isReservedAddress(to)).toBe(true);
    for (const to of ['mukisa@gmail.com', 'info@pexerearn.com', 'a@test.com', 'a@example.co.ug']) expect(isReservedAddress(to)).toBe(false);
  });

  it('never calls Resend for a test address, and does for a real one', async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetch);
    const mailer = new ResendMailer('re_test', 'Pexerearn <info@pexerearn.com>');
    await mailer.send({ to: 'm_1@zentrix.test', subject: 's', text: 't' });
    expect(fetch).not.toHaveBeenCalled();
    await mailer.send({ to: 'someone@gmail.com', subject: 's', text: 't' });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
