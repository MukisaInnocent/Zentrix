import { describe, expect, it } from 'vitest';
import type { OutcomeStatus, ProviderOutcome } from '../../src/providers/livepay.js';
import { decideWatch, markerFor, watchKey, type WatchMarker } from '../../src/providers/paywatch.js';

const created = new Date('2026-11-01T20:00:00Z');
const marker: WatchMarker = { reference: 'DP-AB12CD34', provider: 'livepay', currency: 'UGX', createdAt: created.toISOString(), nextCheckAt: created.toISOString() };
const after = (minutes: number) => new Date(created.getTime() + minutes * 60_000);
const outcome = (status: OutcomeStatus, rawStatus?: string): ProviderOutcome =>
  ({ op: 'status', provider: 'livepay', reference: marker.reference, at: created.toISOString(), status, ...(rawStatus ? { rawStatus } : {}) });
const waitMinutes = (d: { marker: WatchMarker }, now: Date) => (new Date(d.marker.nextCheckAt).getTime() - now.getTime()) / 60_000;

describe('watching LivePay requests without the database', () => {
  it('marks a command with its request time and reads it a minute later', () => {
    const now = after(0);
    const m = markerFor({ op: 'collect', provider: 'livepay', reference: 'DP-1', currency: 'UGX', createdAt: '2026-11-01T19:59:00.000Z' }, now);
    expect(m).toEqual({ reference: 'DP-1', provider: 'livepay', currency: 'UGX', createdAt: '2026-11-01T19:59:00.000Z', nextCheckAt: after(1).toISOString() });
    expect(watchKey('DP-1')).toBe('paygate/watch/DP-1.json');
  });

  it('wakes the database for a paid or failed request', () => {
    for (const s of ['succeeded', 'failed'] as const) {
      const d = decideWatch(marker, outcome(s), after(2));
      expect(d.forward).toBe(true);
      expect(waitMinutes(d, after(2))).toBe(30);
    }
  });

  it('lets the database sleep while a request is pending, reading every minute, then less often', () => {
    for (const [age, wait] of [[2, 1], [29, 1], [31, 10], [300, 10], [400, 60]] as const) {
      const d = decideWatch(marker, outcome('pending'), after(age));
      expect(d.forward).toBe(false);
      expect(waitMinutes(d, after(age))).toBe(wait);
    }
  });

  it('hands over a request still pending after a day, for staff review', () => {
    expect(decideWatch(marker, outcome('pending'), after(24 * 60 + 1)).forward).toBe(true);
  });

  it('hands over "no record" only once it may fail the request', () => {
    expect(decideWatch(marker, outcome('missing'), after(10)).forward).toBe(false);
    expect(decideWatch(marker, outcome('missing'), after(16)).forward).toBe(true);
  });

  it('hands over an unknown status word, but reads again after a failed call', () => {
    expect(decideWatch(marker, outcome('unknown', 'Weird'), after(2)).forward).toBe(true);
    expect(decideWatch(marker, outcome('unknown'), after(2)).forward).toBe(false);
    expect(decideWatch(marker, undefined, after(2)).forward).toBe(false);
    expect(decideWatch(marker, outcome('unknown'), after(24 * 60 + 1)).forward).toBe(true);
  });
});
