import { api, newIdempotencyKey } from '../core/api.js';
import { $, h, icon } from '../core/dom.js';
import { formatDate, formatMoney } from '../core/format.js';
import { bindForm } from '../core/forms.js';
import { paymentBadge, reportProblem } from '../core/payments.js';
import { toast } from '../core/toast.js';

// The activation payment page. The member pays the fee to a business channel (USSD and merchant code shown),
// then submits the transaction ID. Staff confirm it against the statement, which opens the account. Nothing here
// changes a balance: the page only shows what the server says.
let info = null;
let selected = null;

function copyRow(label, value) {
  const copy = h('button', { type: 'button', class: 'zx-icon-btn zx-icon-btn--square', 'aria-label': `Copy ${label}` }, icon('copy'));
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success('Copied');
    } catch {
      toast.error('Copy is blocked in this browser.');
    }
  });
  return h('div', { class: 'zx-paybox__row' }, h('span', { class: 'zx-hint' }, label), h('strong', { class: 'zx-paybox__value' }, value), copy);
}

function renderPaybox() {
  const box = $('#paybox');
  const c = info.channels.find(x => x.code === selected);
  if (!c) {
    box.replaceChildren(h('p', {}, 'Payment methods for your country are being set up. Please contact support and we will help you pay.'),
      h('a', { class: 'zx-btn zx-btn--secondary zx-btn--fit', href: '/contact.html' }, 'Contact support'));
    return;
  }
  const fee = formatMoney(info.activation.feeMinor, info.currency);
  const code = c.merchantCode ?? c.accountNumber;
  const steps = c.ussdCode
    ? [`Dial ${c.ussdCode} on your phone.`, `Choose pay merchant and enter the code ${code}.`, `Enter the amount ${fee} and confirm with your PIN.`, 'Copy the transaction ID from the confirmation message.']
    : [`Send ${fee} to the account below.`, 'Check the account name before you confirm.', 'Copy the transaction ID or reference from your receipt.'];
  box.replaceChildren(
    c.ussdCode ? copyRow('Dial', c.ussdCode) : null,
    copyRow(c.ussdCode ? 'Merchant code' : 'Account', code),
    h('div', { class: 'zx-paybox__row' }, h('span', { class: 'zx-hint' }, 'Account name'), h('strong', { class: 'zx-paybox__value' }, c.accountName)),
    h('div', { class: 'zx-paybox__row' }, h('span', { class: 'zx-hint' }, 'Amount'), h('strong', { class: 'zx-paybox__value' }, fee)),
    h('ol', { class: 'zx-steps-list' }, steps.map(x => h('li', {}, x))),
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
  info = await api.get('/api/payments/channels');
  if (info.activation.active) return location.assign('/dashboard.html');
  const list = await api.get('/api/payments/deposits');
  list.deposits = list.deposits.filter(d => d.purpose === 'activation');
  $('#fee').textContent = info.activation.feeMinor ? formatMoney(info.activation.feeMinor, info.currency) : 'Not set for your country yet';
  $('#paused').hidden = !info.depositsPaused;
  $('#auto-note').hidden = !info.autoApprove;
  // Test mode: a made-up transaction ID so the member only has to press Submit.
  if (info.autoApprove && !$('#activate-txn').value) $('#activate-txn').value = `TEST${Date.now().toString(36).toUpperCase()}`;
  const pending = list.deposits.some(d => d.status === 'pending');
  $('#form-card').hidden = pending;
  $('#waiting').hidden = !pending;
  $('#pay-area').hidden = pending;
  $('#activate-submit').disabled = info.depositsPaused || !info.channels.some(c => c.depositsEnabled) || !info.activation.feeMinor;
  renderChannels();

  const body = $('#payments-body');
  if (!list.deposits.length) {
    body.replaceChildren(h('tr', {}, h('td', { colspan: '6', class: 'zx-td-empty' }, 'No payments yet.')));
    return;
  }
  body.replaceChildren(...list.deposits.map(d => {
    const actions = [];
    if (d.status === 'pending') {
      const cancel = h('button', { type: 'button', class: 'zx-btn zx-btn--ghost zx-btn--sm' }, 'Cancel');
      cancel.addEventListener('click', async () => {
        try {
          await api.post(`/api/payments/deposits/${d.id}/cancel`, {});
          toast.success('Payment cancelled');
          await refresh();
        } catch (err) {
          toast.error(err.message);
        }
      });
      actions.push(cancel);
    }
    if (d.status !== 'cancelled') {
      const report = h('button', { type: 'button', class: 'zx-btn zx-btn--ghost zx-btn--sm' }, 'Report a problem');
      report.addEventListener('click', () => void reportProblem('deposit', d.reference));
      actions.push(report);
    }
    return h('tr', {},
      h('td', { class: 'zx-td-muted' }, formatDate(d.createdAt, { withTime: true })),
      h('td', {}, d.channel.name),
      h('td', { class: 'zx-td-mono' }, d.providerTxnId),
      h('td', { class: 'zx-amount' }, formatMoney(d.claimedAmountMinor, d.currency)),
      h('td', {}, paymentBadge(d.status), d.reviewNote ? h('div', { class: 'zx-hint' }, d.reviewNote) : null),
      h('td', {}, h('span', { class: 'zx-row-actions' }, actions)));
  }));
}

export async function init({ me }) {
  await refresh();
  $('#activate-phone').value = me?.phone ?? '';

  bindForm($('#activate-form'), async (data, form) => {
    if (!selected) throw new Error('No payment method');
    const res = await api.post('/api/payments/deposits', { channel: selected, ...data }, { idempotencyKey: newIdempotencyKey() });
    toast.success(`Submitted. Reference ${res.deposit.reference}.`);
    form.reset();
    $('#activate-phone').value = me?.phone ?? '';
    await refresh();
  });

  // While a payment waits for review, check every 15 seconds so the account opens without a reload.
  setInterval(() => {
    if (document.visibilityState === 'visible' && !$('#waiting').hidden) void refresh();
  }, 15_000);
}
