import { api, newIdempotencyKey } from '../core/api.js';
import { $, h, icon } from '../core/dom.js';
import { formatDate, formatMoney } from '../core/format.js';
import { bindForm } from '../core/forms.js';
import { paymentBadge } from '../core/payments.js';
import { toast } from '../core/toast.js';

// Wallet deposit: the member sends money to a business channel, then submits the transaction ID. Staff confirm it
// against the statement and the amount is credited to the balance. The page never changes a balance itself.
let info = null;
let selected = null;

function row(label, value, copy = false) {
  const btn = copy ? h('button', { type: 'button', class: 'zx-icon-btn zx-icon-btn--square', 'aria-label': `Copy ${label}` }, icon('copy')) : null;
  btn?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success('Copied');
    } catch {
      toast.error('Copy is blocked in this browser.');
    }
  });
  return h('div', { class: 'zx-paybox__row' }, h('span', { class: 'zx-hint' }, label), h('strong', { class: 'zx-paybox__value' }, value), btn);
}

function renderPaybox() {
  const c = info.channels.find(x => x.code === selected);
  const box = $('#paybox');
  if (!c) return box.replaceChildren(h('p', {}, 'No payment method is set up for your country yet. Please contact support.'));
  const code = c.merchantCode ?? c.accountNumber;
  box.replaceChildren(
    c.ussdCode ? row('Dial', c.ussdCode, true) : null,
    row(c.ussdCode ? 'Merchant code' : 'Account', code, true),
    row('Account name', c.accountName),
    c.instructions ? h('p', { class: 'zx-hint' }, c.instructions) : null,
    h('p', { class: 'zx-hint' }, 'Never share your PIN. Zentrix staff will never ask for it.'));
}

function renderChannels() {
  const usable = info.channels.filter(c => c.depositsEnabled);
  if (!usable.find(c => c.code === selected)) selected = usable[0]?.code ?? null;
  $('#channel-pick').replaceChildren(...usable.map(c => {
    const input = h('input', { type: 'radio', name: 'channel-choice', value: c.code, checked: c.code === selected });
    input.addEventListener('change', () => {
      selected = c.code;
      renderPaybox();
    });
    return h('label', {}, input, c.name);
  }));
  renderPaybox();
}

async function refresh() {
  const [channels, list] = await Promise.all([api.get('/api/payments/channels'), api.get('/api/payments/deposits')]);
  info = channels;
  $('#paused').hidden = !info.depositsPaused;
  $('#auto-note').hidden = !info.autoApprove;
  if (info.autoApprove && !$('#deposit-txn').value) $('#deposit-txn').value = `TEST${Date.now().toString(36).toUpperCase()}`;
  $('#deposit-submit').disabled = info.depositsPaused || !info.channels.some(c => c.depositsEnabled);
  renderChannels();
  const deposits = list.deposits.filter(d => d.purpose === 'wallet');
  $('#deposits-body').replaceChildren(...(deposits.length
    ? deposits.map(d => h('tr', {},
      h('td', { class: 'zx-td-muted' }, formatDate(d.createdAt, { withTime: true })),
      h('td', {}, d.channel.name),
      h('td', { class: 'zx-td-mono' }, d.providerTxnId),
      h('td', { class: 'zx-amount zx-amount--in' }, formatMoney(d.creditedAmountMinor ?? d.claimedAmountMinor, d.currency)),
      h('td', {}, paymentBadge(d.status), d.reviewNote ? h('div', { class: 'zx-hint' }, d.reviewNote) : null)))
    : [h('tr', {}, h('td', { colspan: '5', class: 'zx-td-empty' }, 'No deposits yet.'))]));
}

export async function init({ me }) {
  await refresh();
  $('#deposit-phone').value = me?.phone ?? '';
  bindForm($('#deposit-form'), async (data, form) => {
    if (!selected) throw new Error('No payment method');
    const res = await api.post('/api/payments/deposits', { purpose: 'wallet', channel: selected, ...data }, { idempotencyKey: newIdempotencyKey() });
    toast.success(`Submitted. Reference ${res.deposit.reference}.`);
    form.reset();
    $('#deposit-phone').value = me?.phone ?? '';
    await refresh();
  });
}
