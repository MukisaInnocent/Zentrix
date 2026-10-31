import { api, newIdempotencyKey } from '../core/api.js';
import { $, h, icon } from '../core/dom.js';
import { formatDate, formatMoney } from '../core/format.js';
import { bindForm } from '../core/forms.js';
import { paymentBadge } from '../core/payments.js';
import { toast } from '../core/toast.js';

// Deposit into the deposit balance (kept apart from the balance, which holds referral money only). Works like the
// activation page (owner, 2026-10-31), except that the member enters the amount. Mobile-money prompt methods
// (LivePay): the prompt goes to the registered number and the deposit is credited when LivePay confirms. Manual
// methods: the member sends money to a business channel and submits the transaction ID; staff confirm it against the
// statement. The page never changes a balance itself.
let info = null;
let selected = null;
let waitingOnPrompt = false;

const selectedChannel = () => info?.channels.find(x => x.code === selected) ?? null;

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
  const c = selectedChannel();
  const box = $('#paybox');
  renderForm(c);
  if (!c) return box.replaceChildren(h('p', {}, 'No payment method is set up for your country yet. Please contact support.'));
  if (c.provider) {
    box.replaceChildren(
      h('ol', { class: 'zx-steps-list' }, [
        'Enter the amount you want to deposit.',
        `Press Send payment prompt. It goes to your registered number${info.phone ? ` ${info.phone}` : ''} (MTN or Airtel).`,
        'Check the amount on your phone and approve it with your PIN. The deposit is added by itself.',
      ].map(x => h('li', {}, x))),
      c.instructions ? h('p', { class: 'zx-hint' }, c.instructions) : null,
      h('p', { class: 'zx-hint' }, 'You type your PIN only on your phone. Pexerearn never sees it and staff will never ask for it.'));
    return;
  }
  const code = c.merchantCode ?? c.accountNumber;
  box.replaceChildren(
    c.ussdCode ? row('Dial', c.ussdCode, true) : null,
    row(c.ussdCode ? 'Merchant code' : 'Account', code, true),
    row('Account name', c.accountName),
    c.instructions ? h('p', { class: 'zx-hint' }, c.instructions) : null,
    h('p', { class: 'zx-hint' }, 'Never share your PIN. Pexerearn staff will never ask for it.'));
}

// A prompt method needs the amount only (the prompt goes to the registered number); a manual one also needs the
// transaction ID and the number paid from.
function renderForm(c) {
  const prompt = Boolean(c?.provider);
  $('#txn-field').hidden = prompt;
  $('#deposit-txn').required = !prompt;
  $('#deposit-txn').disabled = prompt;
  $('#form-title').textContent = prompt ? '2. Enter the amount and get the payment prompt' : '2. Enter your payment details';
  $('#deposit-amount-label').textContent = prompt ? `Amount to deposit (${info.currency})` : 'Amount you sent';
  $('#deposit-phone-label').textContent = prompt ? 'Your registered number (the prompt goes here)' : 'Number you paid from';
  $('#deposit-phone').readOnly = prompt;
  if (prompt && info?.phone) $('#deposit-phone').value = info.phone;
  $('#deposit-submit').textContent = prompt ? 'Send payment prompt' : 'Submit deposit';
}

function renderChannels() {
  // Deposits are in the account's own currency (an activation fee in USD has its own methods).
  const usable = info.channels.filter(c => c.depositsEnabled && c.currency === info.currency);
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
  $('#deposit-submit').disabled = info.depositsPaused || !info.channels.some(c => c.depositsEnabled && c.currency === info.currency);
  renderChannels();
  const deposits = list.deposits.filter(d => d.purpose === 'wallet');
  // A prompt on its way: say so, and check again every few seconds until LivePay answers.
  const prompt = deposits.find(d => d.status === 'pending' && d.method === 'api');
  waitingOnPrompt = Boolean(prompt);
  $('#waiting').hidden = !prompt;
  if (prompt) $('#waiting-text').textContent = `We sent a prompt for ${formatMoney(prompt.claimedAmountMinor, prompt.currency)} to ${prompt.senderPhone}. Approve it with your PIN. This page updates by itself.`;
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
    if (selectedChannel()?.provider) {
      const res = await api.post('/api/payments/collections', { purpose: 'wallet', channel: selected, amount: data.amount, phone: data.senderPhone }, { idempotencyKey: newIdempotencyKey() });
      if (res.deposit.status === 'confirmed') toast.success('Deposit received.');
      else if (res.deposit.status === 'rejected') toast.error(`The payment did not go through${res.deposit.reviewNote ? `: ${res.deposit.reviewNote}` : '.'}`);
      else toast.success('Prompt sent. Approve it on your phone.');
    } else {
      const res = await api.post('/api/payments/deposits', { purpose: 'wallet', channel: selected, ...data }, { idempotencyKey: newIdempotencyKey() });
      toast.success(`Submitted. Reference ${res.deposit.reference}.`);
    }
    form.reset();
    $('#deposit-phone').value = me?.phone ?? '';
    await refresh();
  });

  // While a prompt waits, check every 5 seconds so the deposit shows without a reload.
  setInterval(() => {
    if (document.visibilityState === 'visible' && waitingOnPrompt) void refresh();
  }, 5_000);
}
