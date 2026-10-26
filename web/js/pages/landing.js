import { api } from '../core/api.js';
import { $, h } from '../core/dom.js';
import { formatMoney, loadCurrencies } from '../core/format.js';

// The landing page is static apart from two live details: the activation fee for the visitor's country (from the
// server, never calculated here) and the support contact an admin sets in Settings.
async function showFee() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  const { country } = await api.get(`/api/reference/detect?tz=${encodeURIComponent(tz)}`, { noRedirect: true });
  const code = country ?? 'UG';
  await loadCurrencies();
  const { config } = await api.get(`/api/reference/config/${code}`, { noRedirect: true });
  $('#plan-price').textContent = formatMoney(config.activationFee);
  let name = code;
  try {
    name = new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
  } catch {
    // Older browsers: keep the country code.
  }
  $('#plan-country').textContent = `One-time activation fee in ${name}. Each country pays in its own currency.`;
}

async function showContact() {
  const { support } = await api.get('/api/meta', { noRedirect: true });
  if (!support) return;
  $('#contact-details').replaceChildren(
    h('a', { href: `mailto:${support.email}` }, support.email), ' · ', support.phone, ' · ', support.hours);
}

export async function init() {
  // Either detail may be unavailable; the page reads fine without it.
  await Promise.all([showFee().catch(() => undefined), showContact().catch(() => undefined)]);
}
