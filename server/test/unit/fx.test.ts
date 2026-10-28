import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenErApiSource } from '../../src/providers/fx.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const respond = (body: unknown, status = 200) =>
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status }))));

describe('the exchange-rate API source', () => {
  it('turns the dollar rates into decimal strings with the provider time', async () => {
    respond({ result: 'success', base_code: 'USD', time_last_update_unix: 1_793_145_600, rates: { USD: 1, UGX: 3700, KES: 129.25, KWD: 0.307123, JPY: 150.1 } });
    const snapshot = await new OpenErApiSource().latest();
    expect(snapshot.source).toBe('open.er-api.com');
    expect(snapshot.rateAt.toISOString()).toBe('2026-10-28T00:00:00.000Z');
    expect(snapshot.unitsPerUsd).toEqual({ USD: '1', UGX: '3700', KES: '129.25', KWD: '0.307123', JPY: '150.1' });
  });

  it('asks the provider again only after its announced next update', async () => {
    let now = new Date('2026-10-28T06:00:00Z');
    respond({ result: 'success', base_code: 'USD', time_last_update_unix: 1_793_145_600, time_next_update_unix: 1_793_232_000, rates: { UGX: 3700 } });
    const source = new OpenErApiSource(undefined, () => now);
    expect((await source.latest()).nextUpdateAt?.toISOString()).toBe('2026-10-29T00:00:00.000Z');
    await source.latest();
    expect(fetch).toHaveBeenCalledTimes(1);
    now = new Date('2026-10-29T00:05:00Z');
    await source.latest();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('refuses an error answer or a malformed body', async () => {
    respond({ result: 'error', 'error-type': 'unsupported-code' });
    await expect(new OpenErApiSource().latest()).rejects.toThrow();
    respond({}, 503);
    await expect(new OpenErApiSource().latest()).rejects.toThrow('HTTP 503');
    respond({ result: 'success', base_code: 'USD', time_last_update_unix: 1, rates: { UGX: -1 } });
    await expect(new OpenErApiSource().latest()).rejects.toThrow();
  });
});
