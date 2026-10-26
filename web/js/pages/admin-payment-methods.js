import { api } from '../core/api.js';
import { $, h } from '../core/dom.js';
import { act, askForm, emptyRow, queryParam } from '../admin/kit.js';
import { toast } from '../core/toast.js';

// Payment methods per country: add, edit, switch on or off, remove (archive) and restore. Every change is audited
// by the server.
const state = { country: '', removed: false };
let countries = [];

const yesNo = on => h('span', { class: `zx-badge ${on ? 'zx-badge--success' : ''}` }, on ? 'On' : 'Off');
const countryName = code => countries.find(c => c.code === code)?.name ?? code;

// The fields shared by the add and edit forms; `c` is the method being edited.
function methodFields(c = {}) {
  return [
    { name: 'name', label: 'Method name (what members see)', required: true, minLength: 2, value: c.name, hint: 'For example MTN Mobile Money or Airtel Money.' },
    { name: 'accountName', label: 'Account name', required: true, minLength: 2, value: c.accountName, hint: 'The registered name members should see before they confirm.' },
    { name: 'accountNumber', label: 'Phone number or account number', required: true, minLength: 3, value: c.accountNumber },
    { name: 'ussdCode', label: 'USSD code (optional)', value: c.ussdCode, hint: 'For example *165*3#.' },
    { name: 'merchantCode', label: 'Merchant code (optional)', value: c.merchantCode },
    { name: 'instructions', label: 'Extra instructions (optional)', type: 'textarea', maxLength: 600, value: c.instructions },
    {
      name: 'depositsEnabled', label: 'Takes activation payments and deposits', type: 'select', value: String(c.depositsEnabled ?? true),
      options: [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }],
    },
    {
      name: 'payoutsEnabled', label: 'Sends withdrawals', type: 'select', value: String(c.payoutsEnabled ?? true),
      options: [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }],
    },
  ];
}

const toBody = v => ({
  name: v.name, accountName: v.accountName, accountNumber: v.accountNumber, ussdCode: v.ussdCode || undefined, merchantCode: v.merchantCode || undefined,
  instructions: v.instructions || undefined, depositsEnabled: v.depositsEnabled === 'true', payoutsEnabled: v.payoutsEnabled === 'true',
});

async function addMethod() {
  const saved = await askForm({
    title: 'Add a payment method', submitLabel: 'Add method',
    fields: [
      { name: 'country', label: 'Country', type: 'select', required: true, value: state.country || 'UG', options: countries.map(c => ({ value: c.code, label: `${c.name} (${c.currency_code})` })) },
      ...methodFields(),
    ],
    submit: v => api.post('/api/admin/payments/channels', { country: v.country, ...toBody(v) }),
  });
  if (saved) {
    toast.success('Payment method added.');
    await load();
  }
}

async function editMethod(c) {
  const saved = await askForm({
    title: `Edit ${c.name} (${countryName(c.countryCode)})`, submitLabel: 'Save changes',
    fields: methodFields(c),
    submit: v => api.patch(`/api/admin/payments/channels/${c.code}`, toBody(v)),
  });
  if (saved) {
    toast.success('Payment method saved.');
    await load();
  }
}

async function removeMethod(c) {
  const done = await askForm({
    title: `Remove ${c.name}?`, text: 'Members will no longer see it, and it takes no payments and sends no payouts. Past payments keep their record, and you can restore it later.',
    submitLabel: 'Remove', tone: 'danger',
    fields: [{ name: 'reason', label: 'Why is it removed?', type: 'textarea', required: true, minLength: 5 }],
    submit: v => api.post(`/api/admin/payments/channels/${c.code}/remove`, { reason: v.reason }),
  });
  if (done) {
    toast.success(`${c.name} removed.`);
    await load();
  }
}

async function restoreMethod(c) {
  if (await act(() => api.post(`/api/admin/payments/channels/${c.code}/restore`, {}), `${c.name} restored. Switch deposits and payouts on when ready.`)) await load();
}

function actionButton(label, onClick, tone = 'secondary') {
  const b = h('button', { type: 'button', class: `zx-btn zx-btn--${tone} zx-btn--sm` }, label);
  b.addEventListener('click', onClick);
  return b;
}

async function load() {
  const params = new URLSearchParams();
  if (state.country) params.set('country', state.country);
  if (state.removed) params.set('removed', '1');
  const { channels } = await api.get(`/api/admin/payments/channels?${params}`);
  $('#rows').replaceChildren(...(channels.length ? channels.map(c => h('tr', {},
    h('td', {}, `${countryName(c.countryCode)} (${c.currency})`),
    h('td', { class: 'zx-td-strong' }, c.name, c.removedAt ? h('div', { class: 'zx-hint' }, 'Removed') : null),
    h('td', {}, c.accountName),
    h('td', { class: 'zx-td-mono' }, c.accountNumber),
    h('td', { class: 'zx-td-mono' }, c.ussdCode ?? '-'),
    h('td', { class: 'zx-td-mono' }, c.merchantCode ?? '-'),
    h('td', {}, yesNo(c.depositsEnabled)),
    h('td', {}, yesNo(c.payoutsEnabled)),
    h('td', {}, h('span', { class: 'zx-row-actions' }, c.removedAt
      ? [actionButton('Restore', () => void restoreMethod(c))]
      : [actionButton('Edit', () => void editMethod(c)), actionButton('Remove', () => void removeMethod(c), 'ghost')]))))
    : [emptyRow(9, state.country ? 'No payment methods for this country yet. Members there cannot pay until you add one.' : 'No payment methods yet.')]));
}

export async function init() {
  // Support staff may not read the country list; the page still works with country codes.
  countries = (await api.get('/api/admin/countries').catch(() => ({ countries: [] }))).countries;
  const select = $('#country-filter');
  select.append(...countries.map(c => h('option', { value: c.code }, `${c.name} (${c.code})`)));
  state.country = (queryParam('country') ?? '').toUpperCase();
  select.value = state.country;
  select.addEventListener('change', () => {
    state.country = select.value;
    history.replaceState(null, '', state.country ? `?country=${state.country}` : location.pathname);
    void act(load);
  });
  $('#show-removed').addEventListener('change', e => {
    state.removed = e.target.checked;
    void act(load);
  });
  $('#add-btn').addEventListener('click', () => void addMethod());
  await act(load);
}
