import { api } from './api.js';

// Money arrives from the server as { amountMinor: "19000", currency: "UGX" }. The browser never does
// arithmetic on it (section 5); it only places the decimal point and formats with Intl.NumberFormat.
let exponents = null;

export async function loadCurrencies() {
  if (exponents) return exponents;
  try {
    const cached = sessionStorage.getItem('zx-currencies');
    if (cached) return (exponents = JSON.parse(cached));
  } catch {
    // Storage blocked; fetch below.
  }
  const { currencies } = await api.get('/api/reference/currencies');
  exponents = Object.fromEntries(currencies.map(c => [c.code, c.exponent]));
  try {
    sessionStorage.setItem('zx-currencies', JSON.stringify(exponents));
  } catch {
    // Not fatal.
  }
  return exponents;
}

export function minorToDecimal(amountMinor, exponent) {
  const raw = String(amountMinor);
  const negative = raw.startsWith('-');
  const digits = (negative ? raw.slice(1) : raw).padStart(exponent + 1, '0');
  const whole = exponent === 0 ? digits : digits.slice(0, -exponent);
  const fraction = exponent === 0 ? '' : `.${digits.slice(-exponent)}`;
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

// Accepts either ({ amountMinor, currency }, locale) or the shorthand (amountMinor, currency, locale).
export function formatMoney(money, ...rest) {
  let locale = rest[0];
  if (money !== null && typeof money !== 'object') {
    if (money === undefined || !rest[0]) return '';
    money = { amountMinor: money, currency: rest[0] };
    locale = rest[1];
  }
  if (!money || !money.currency) return '';
  const exponent = exponents?.[money.currency] ?? 2;
  const formatter = new Intl.NumberFormat(locale, {
    style: 'currency', currency: money.currency, currencyDisplay: 'code',
    minimumFractionDigits: exponent, maximumFractionDigits: exponent,
  });
  // Intl formats decimal strings exactly in current browsers; older ones convert, which is fine for display.
  return formatter.format(minorToDecimal(money.amountMinor, exponent));
}

export function formatDate(value, { locale, timeZone, withTime = false } = {}) {
  if (!value) return '';
  const options = withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' };
  try {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone }).format(new Date(value));
  } catch {
    return new Intl.DateTimeFormat(locale, options).format(new Date(value));
  }
}

export function formatPercentFromBasisPoints(bp, locale) {
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 2 }).format(bp / 10_000);
}
