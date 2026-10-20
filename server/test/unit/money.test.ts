import { describe, expect, it } from 'vitest';
import { basisPointsOf, MoneyFormatError, toDecimalString, toMinor } from '../../src/lib/money.js';

describe('toMinor', () => {
  it('converts decimal strings exactly for 0, 2 and 3 decimal currencies', () => {
    expect(toMinor('19000', 0)).toBe(19000n);
    expect(toMinor('5.25', 2)).toBe(525n);
    expect(toMinor('5', 2)).toBe(500n);
    expect(toMinor('1.5', 3)).toBe(1500n);
    expect(toMinor('0.001', 3)).toBe(1n);
    expect(toMinor('999999999999999.99', 2)).toBe(99999999999999999n);
    expect(toMinor(' 10.10 ', 2)).toBe(1010n);
  });

  it('rejects extra precision, signs, exponents and junk', () => {
    for (const [value, exp] of [['1.5', 0], ['1.234', 2], ['-1', 2], ['1e3', 0], ['1,000', 0], ['', 0], ['.5', 2], ['abc', 2]] as const) {
      expect(() => toMinor(value, exp), value).toThrow(MoneyFormatError);
    }
  });

  it('never goes through floating point', () => {
    expect(toMinor('0.30', 2)).toBe(30n);
    expect(toMinor('1.10', 2) + toMinor('2.20', 2)).toBe(330n);
  });
});

describe('toDecimalString', () => {
  it('formats minor units back without rounding', () => {
    expect(toDecimalString(525n, 2)).toBe('5.25');
    expect(toDecimalString(5n, 2)).toBe('0.05');
    expect(toDecimalString(19000n, 0)).toBe('19000');
    expect(toDecimalString(1500n, 3)).toBe('1.500');
    expect(toDecimalString(-525n, 2)).toBe('-5.25');
  });
});

describe('basisPointsOf (owner decision: withdrawal fee 0.5% = 50 bp)', () => {
  it('rounds half up to the minor unit', () => {
    expect(basisPointsOf(1000n, 50)).toBe(5n);
    expect(basisPointsOf(200_000n, 50)).toBe(1000n);
    expect(basisPointsOf(1_099n, 50)).toBe(5n);
    expect(basisPointsOf(1_100n, 50)).toBe(6n);
    expect(basisPointsOf(0n, 50)).toBe(0n);
    expect(basisPointsOf(10n ** 15n, 50)).toBe(5n * 10n ** 12n);
  });

  it('refuses negative amounts and fractional basis points', () => {
    expect(() => basisPointsOf(-1n, 50)).toThrow(RangeError);
    expect(() => basisPointsOf(100n, 0.5)).toThrow(RangeError);
  });
});
