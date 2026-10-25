import { parsePhoneNumberFromString, type PhoneNumber } from 'libphonenumber-js/max';

// Phone numbers everywhere in Zentrix start with the country code (owner, 2026-10-25): "+256700000001" or
// "256700000001". Local formats such as "0700000001" are refused, never guessed. The number is stored as E.164.
export function parseInternational(input: string): PhoneNumber | null {
  let digits = input.replace(/[\s\-().]/g, '');
  if (digits.startsWith('00')) digits = `+${digits.slice(2)}`;
  else if (!digits.startsWith('+')) digits = `+${digits}`;
  if (!/^\+[1-9][0-9]{6,14}$/.test(digits)) return null;
  const phone = parsePhoneNumberFromString(digits);
  return phone?.isValid() ? phone : null;
}

export const isMobileLike = (phone: PhoneNumber): boolean => {
  const type = phone.getType();
  return type === undefined || type === 'MOBILE' || type === 'FIXED_LINE_OR_MOBILE';
};

export const PHONE_HELP = 'Start with your country code, for example +256700000001.';
