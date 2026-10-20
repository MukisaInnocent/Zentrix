// Exact money arithmetic. Amounts are BigInt minor units with an ISO 4217 exponent; no floats anywhere
// (section 1 and 7). Decimal strings are the only way amounts enter or leave the server.

export interface Money {
  amountMinor: string;
  currency: string;
}

export class MoneyFormatError extends Error {
  override name = 'MoneyFormatError';
}

const DECIMAL = /^(\d{1,15})(?:\.(\d{1,4}))?$/;

// "19000" (UGX, exponent 0) -> 19000n; "5.25" (USD, exponent 2) -> 525n. Rejects extra precision.
export function toMinor(amount: string, exponent: number): bigint {
  const match = DECIMAL.exec(amount.trim());
  if (!match) throw new MoneyFormatError('Enter an amount like 1000 or 10.50.');
  const whole = match[1] ?? '0';
  const fraction = match[2] ?? '';
  if (fraction.length > exponent) {
    throw new MoneyFormatError(exponent === 0 ? 'This currency has no decimal places.' : `Use at most ${exponent} decimal places.`);
  }
  return BigInt(whole) * 10n ** BigInt(exponent) + BigInt(fraction.padEnd(exponent, '0') || '0');
}

// 525n, exponent 2 -> "5.25"; 19000n, exponent 0 -> "19000".
export function toDecimalString(minor: bigint, exponent: number): string {
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString().padStart(exponent + 1, '0');
  const whole = exponent === 0 ? digits : digits.slice(0, -exponent);
  const fraction = exponent === 0 ? '' : `.${digits.slice(-exponent)}`;
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

// basisPoints / 10_000 of an amount, rounded half up to the minor unit (owner decision: fee 0.5% = 50 bp).
export function basisPointsOf(amountMinor: bigint, basisPoints: number): bigint {
  if (amountMinor < 0n) throw new RangeError('amount must not be negative');
  if (!Number.isInteger(basisPoints) || basisPoints < 0) throw new RangeError('basis points must be a non-negative integer');
  const scaled = amountMinor * BigInt(basisPoints);
  return (scaled + 5_000n) / 10_000n;
}

export const money = (amountMinor: bigint | string, currency: string): Money => ({ amountMinor: String(amountMinor), currency });
