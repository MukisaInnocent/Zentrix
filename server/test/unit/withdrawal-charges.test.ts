import { describe, expect, it } from 'vitest';
import { basisPointsOf } from '../../src/lib/money.js';
import { chargeFor, type ChargeBand } from '../../src/modules/payments/withdrawals.js';

// The owner's UGX table (2026-10-26): upper limit -> charge.
const UGX: ChargeBand[] = [
  [50000, 1500], [100000, 2000], [150000, 2250], [200000, 2500], [250000, 2700], [300000, 3000], [350000, 3300], [400000, 3500],
  [500000, 4000], [600000, 4500], [700000, 5000], [850000, 5700], [950000, 6250], [1100000, 7000], [1500000, 9400],
  [3000000, 17000], [5000000, 26500],
].map(([upTo, charge]) => ({ upToMinor: String(upTo), chargeMinor: String(charge) }));

describe('withdrawal charge', () => {
  it('picks the band whose limit covers the amount, a boundary amount paying the lower band', () => {
    const cases: [number, number][] = [
      [15000, 1500], [50000, 1500], [50001, 2000], [100000, 2000], [100001, 2250], [199999, 2500], [400001, 4000],
      [950000, 6250], [950001, 7000], [1500001, 17000], [3000000, 17000], [3000001, 26500], [5000000, 26500],
    ];
    for (const [amount, charge] of cases) expect([amount, chargeFor(UGX, 0n, BigInt(amount))]).toEqual([amount, BigInt(charge)]);
  });

  it('uses the top band above the table and the fallback when a currency has no table', () => {
    expect(chargeFor(UGX, 0n, 6_000_000n)).toBe(26500n);
    expect(chargeFor([], 700n, 20_000n)).toBe(700n);
  });

  it('adds the 0.5% tax on the amount, rounded half up', () => {
    expect(basisPointsOf(20000n, 50)).toBe(100n);
    expect(basisPointsOf(15000n, 50)).toBe(75n);
    expect(basisPointsOf(15100n, 50)).toBe(76n); // 75.5 rounds up
  });
});
