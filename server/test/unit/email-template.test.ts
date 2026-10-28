import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { renderEmail } from '../../src/modules/email/template.js';
import { verifySignature } from '../../src/modules/email/webhook.js';

describe('branded email layout', () => {
  it('escapes every text value and keeps a plain-text version with the link', () => {
    const { html, text } = renderEmail(
      { heading: 'Hi <b>@you</b>', paragraphs: ['A & B\nnext "line"'], button: { label: 'Go <now>', url: 'https://x.test/?a=1&b="2"' }, note: 'Note <i>', footer: 'Foot' },
      { origin: 'https://staging.pexerearn.com', testMode: true },
    );
    expect(html).not.toMatch(/<b>@you|<i>|<now>/);
    expect(html).toContain('Hi &lt;b&gt;@you&lt;/b&gt;');
    expect(html).toContain('A &amp; B<br>next &quot;line&quot;');
    expect(html).toContain('href="https://x.test/?a=1&amp;b=&quot;2&quot;"');
    expect(html).toContain('TEST MODE: no real money');
    expect(text).toContain('Go <now>: https://x.test/?a=1&b="2"');
    expect(text).toContain('staging.pexerearn.com · info@pexerearn.com');
  });

  it('leaves out the test banner in live mode', () => {
    expect(renderEmail({ heading: 'h', paragraphs: [] }, { origin: 'https://pexerearn.com', testMode: false }).html).not.toContain('TEST MODE');
  });
});

describe('Resend webhook signature', () => {
  const secret = `whsec_${Buffer.from('a-test-signing-key-32-bytes-long').toString('base64')}`;
  const body = Buffer.from('{"type":"email.sent"}');
  const now = new Date('2026-10-28T12:00:00Z');
  const ts = String(now.getTime() / 1000);
  const sign = (s: string, t: string, b: Buffer) => createHmac('sha256', Buffer.from(s.slice(6), 'base64')).update(`msg_1.${t}.`).update(b).digest('base64');

  it('accepts the right signature among several, and nothing else', () => {
    expect(verifySignature(secret, 'msg_1', ts, `v1,bogus v1,${sign(secret, ts, body)}`, body, now)).toBe(true);
    expect(verifySignature(secret, 'msg_2', ts, `v1,${sign(secret, ts, body)}`, body, now)).toBe(false);
    expect(verifySignature(secret, 'msg_1', ts, `v1,${sign(secret, ts, body)}`, Buffer.from('{"type":"email.bounced"}'), now)).toBe(false);
    expect(verifySignature(secret, 'msg_1', ts, `v2,${sign(secret, ts, body)}`, body, now)).toBe(false);
    const old = String(now.getTime() / 1000 - 301);
    expect(verifySignature(secret, 'msg_1', old, `v1,${sign(secret, old, body)}`, body, now)).toBe(false);
    expect(verifySignature(secret, '', ts, '', body, now)).toBe(false);
  });
});
