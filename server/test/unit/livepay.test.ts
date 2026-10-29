import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config/env.js';
import { LivePayClient, livePaySignature, mapStatus, SimulatedProvider, verifyLivePaySignature } from '../../src/providers/livepay.js';

const URL_ = 'https://api.pexerearn.com/api/webhooks/livepay';
const SECRET = 'whsec-test-0123456789';
const payload = { status: 'Success', customer_reference: 'DP-AB12CD34', internal_reference: '550e8400-e29b-41d4-a716-446655440000', amount: 19000 };

function fakeFetch(status: number, body: unknown, seen: { url?: string; init?: RequestInit } = {}): typeof fetch {
  return ((url: string, init: RequestInit) => {
    seen.url = url;
    seen.init = init;
    return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
  }) as unknown as typeof fetch;
}

const client = (f: typeof fetch) => new LivePayClient({ apiKey: 'k', accountNumber: 'LP2305443309', fetch: f });
const collect = { op: 'collect' as const, provider: 'livepay' as const, reference: 'DP-AB12CD34', currency: 'UGX', phone: '+256777123456', amount: '19000' };

describe('LivePay webhook signature', () => {
  const now = new Date('2026-11-02T10:00:00Z');
  const t = String(now.getTime() / 1000);
  const header = (p = payload, ts = t, secret = SECRET) => `t=${ts},v=${livePaySignature(secret, URL_, ts, p)}`;

  it('accepts a delivery signed over the URL, timestamp and the sorted fields', () => {
    expect(verifyLivePaySignature(SECRET, URL_, header(), payload, now)).toBe(true);
  });

  it('refuses a wrong secret, a changed status or reference, another URL and old deliveries', () => {
    expect(verifyLivePaySignature(SECRET, URL_, header(payload, t, 'other'), payload, now)).toBe(false);
    expect(verifyLivePaySignature(SECRET, URL_, header(), { ...payload, status: 'Failed' }, now)).toBe(false);
    expect(verifyLivePaySignature(SECRET, URL_, header(), { ...payload, customer_reference: 'DP-OTHER000' }, now)).toBe(false);
    expect(verifyLivePaySignature(SECRET, `${URL_}x`, header(), payload, now)).toBe(false);
    const old = String(now.getTime() / 1000 - 301);
    expect(verifyLivePaySignature(SECRET, URL_, header(payload, old), payload, now)).toBe(false);
    expect(verifyLivePaySignature(SECRET, URL_, 'garbage', payload, now)).toBe(false);
  });

  it('does not cover the amount, which is why money moves only on a status read', () => {
    expect(verifyLivePaySignature(SECRET, URL_, header(), { ...payload, amount: 1 }, now)).toBe(true);
  });
});

describe('LivePay client', () => {
  it('sends a collection with the bearer key and account number', async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const [o] = await client(fakeFetch(200, { success: true, internal_reference: 'abc', network: 'MTN' }, seen)).execute(collect);
    expect(seen.url).toBe('https://livepay.me/api/collect-money');
    expect((seen.init?.headers as Record<string, string>).Authorization).toBe('Bearer k');
    expect(JSON.parse(seen.init?.body as string)).toMatchObject({ accountNumber: 'LP2305443309', amount: 19000, currency: 'UGX', reference: 'DP-AB12CD34' });
    expect(o).toMatchObject({ accepted: 'yes', providerRef: 'abc', network: 'MTN' });
  });

  it('treats refusals as no, and server errors, timeouts and duplicate references as unsure', async () => {
    expect((await client(fakeFetch(400, { error: 'Amount below minimum' })).execute(collect))[0]?.accepted).toBe('no');
    expect((await client(fakeFetch(400, { error: 'Duplicate reference' })).execute(collect))[0]?.accepted).toBe('unsure');
    expect((await client(fakeFetch(504, {})).execute(collect))[0]?.accepted).toBe('unsure');
    const broken = (() => Promise.reject(new Error('timeout'))) as unknown as typeof fetch;
    expect((await client(broken).execute(collect))[0]?.accepted).toBe('unsure');
  });

  it('reads a status with its amount, and reports an unknown reference as missing', async () => {
    const seen: { url?: string } = {};
    const [ok] = await client(fakeFetch(200, {
      success: true, status: 'Success', amount: 19000, currency: 'UGX', provider_transaction_id: 'MP123', charge: 500, msisdn: '+256777123456',
    }, seen)).execute({ op: 'status', provider: 'livepay', reference: 'DP-AB12CD34', currency: 'UGX' });
    expect(seen.url).toBe('https://livepay.me/api/transaction-status?accountNumber=LP2305443309&currency=UGX&reference=DP-AB12CD34');
    expect(ok).toMatchObject({ status: 'succeeded', amount: '19000', currency: 'UGX', providerTxnId: 'MP123', charge: '500' });
    const [missing] = await client(fakeFetch(404, { error: 'Transaction not found' })).execute({ op: 'status', provider: 'livepay', reference: 'X-1234', currency: 'UGX' });
    expect(missing?.status).toBe('missing');
    const [down] = await client(fakeFetch(500, {})).execute({ op: 'status', provider: 'livepay', reference: 'X-1234', currency: 'UGX' });
    expect(down?.status).toBe('unknown');
  });

  it('maps status words and leaves unknown ones for staff', () => {
    expect(['Success', 'COMPLETED', 'successful'].map(mapStatus)).toEqual(['succeeded', 'succeeded', 'succeeded']);
    expect(['Failed', 'declined', 'Expired'].map(mapStatus)).toEqual(['failed', 'failed', 'failed']);
    expect(mapStatus('Pending')).toBe('pending');
    expect(mapStatus('On hold')).toBe('unknown');
  });

  it('simulator: succeeds at once, and a number ending in 000 is declined', async () => {
    const sim = new SimulatedProvider();
    expect((await sim.execute(collect)).map(o => o.status ?? o.accepted)).toEqual(['yes', 'succeeded']);
    expect((await sim.execute({ ...collect, phone: '+256777123000' }))[1]?.status).toBe('failed');
  });
});

describe('payment provider configuration', () => {
  const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/zentrix', CSRF_SECRET: 'c'.repeat(40), DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64') };

  it('uses the simulator in test mode and refuses LivePay keys there', () => {
    expect(loadConfig(base).paymentProvider).toBe('simulator');
    expect(() => loadConfig({ ...base, LIVEPAY_LIVE_API_KEY: 'k' })).toThrow(/live-only secrets/);
    expect(() => loadConfig({ ...base, PAYMENT_PROVIDER: 'livepay' })).toThrow(ConfigError);
  });

  it('defaults the webhook URL to the site address', () => {
    expect(loadConfig(base).livepayWebhookUrl).toBe('http://localhost:3000/api/webhooks/livepay');
  });
});
