import { api, newIdempotencyKey } from '../core/api.js';
import { $, h, icon } from '../core/dom.js';
import { formatMoney } from '../core/format.js';
import { bindForm } from '../core/forms.js';
import { toast } from '../core/toast.js';

// The activation payment page. Manual methods: the member pays the fee to a business channel (USSD and merchant code
// shown), then submits the transaction ID, and staff confirm it against the statement. Mobile-money prompt methods
// (LivePay): the member enters the phone to pay from and approves the prompt on it; the account opens when LivePay
// confirms. Nothing here changes a balance: the page only shows what the server says.
let info = null;
let selected = null;
let waitingOnPrompt = false;

const selectedChannel = () => info?.channels.find(x => x.code === selected) ?? null;

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
  renderForm(c);
  if (c.provider) {
    box.replaceChildren(
      h('div', { class: 'zx-paybox__row' }, h('span', { class: 'zx-hint' }, 'Amount'), h('strong', { class: 'zx-paybox__value' }, fee)),
      h('ol', { class: 'zx-steps-list' }, [
        'Enter the MTN or Airtel number you will pay from, then press Send payment prompt.',
        `A prompt for ${fee} appears on that phone.`,
        'Check the amount and approve it with your PIN. Your account opens by itself.',
      ].map(x => h('li', {}, x))),
      c.instructions ? h('p', { class: 'zx-hint' }, c.instructions) : null,
      h('p', { class: 'zx-hint' }, 'You type your PIN only on your phone. Pexerearn never sees it and staff will never ask for it.'));
    return;
  }
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
    h('p', { class: 'zx-hint' }, 'Never share your PIN. Pexerearn staff will never ask for it.'));
}

// A prompt method needs only the phone; a manual one also needs the transaction ID.
function renderForm(c) {
  const prompt = Boolean(c?.provider);
  $('#txn-field').hidden = prompt;
  $('#activate-txn').required = !prompt;
  $('#activate-txn').disabled = prompt;
  $('#form-title').textContent = prompt ? '2. Get the payment prompt' : '2. Enter your payment details';
  $('#activate-phone-label').textContent = prompt ? 'Number to pay from' : 'Number you paid from';
  $('#activate-submit').textContent = prompt ? 'Send payment prompt' : 'Submit payment';
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
  const pendingDeposit = list.deposits.find(d => d.status === 'pending');
  const pending = Boolean(pendingDeposit);
  waitingOnPrompt = pendingDeposit?.method === 'api';
  $('#waiting-title').textContent = waitingOnPrompt ? 'Approve the payment on your phone' : 'We are checking your payment';
  $('#waiting-text').textContent = waitingOnPrompt
    ? `We sent a prompt for ${formatMoney(pendingDeposit.claimedAmountMinor, pendingDeposit.currency)} to ${pendingDeposit.senderPhone}. Approve it with your PIN. This page updates by itself.`
    : 'Your account opens as soon as our team finds it on the statement. This page updates by itself.';
  // The latest payment failed (a declined prompt, or a claim staff could not find): say why.
  const latest = list.deposits[0];
  $('#last-failed').hidden = !(latest && latest.status === 'rejected' && !pending);
  if (latest?.status === 'rejected') $('#last-failed-text').textContent = `Your last payment (${latest.reference}) did not go through${latest.reviewNote ? `: ${latest.reviewNote}` : '.'} You can try again.`;
  $('#form-card').hidden = pending;
  $('#waiting').hidden = !pending;
  $('#pay-area').hidden = pending;
  $('#activate-submit').disabled = info.depositsPaused || !info.channels.some(c => c.depositsEnabled) || !info.activation.feeMinor;
  // The methods are the ones set up for the member's country.
  let country = info.country;
  try {
    country = new Intl.DisplayNames(['en'], { type: 'region' }).of(info.country) ?? info.country;
  } catch {
    // Older browsers: keep the country code.
  }
  $('#pay-title').textContent = `1. Pay with a method for ${country}`;
  renderChannels();
}

export async function init({ me }) {
  await refresh();
  $('#activate-phone').value = me?.phone ?? '';

  bindForm($('#activate-form'), async (data, form) => {
    if (!selected) throw new Error('No payment method');
    if (selectedChannel()?.provider) {
      const res = await api.post('/api/payments/collections', { channel: selected, phone: data.senderPhone }, { idempotencyKey: newIdempotencyKey() });
      if (res.deposit.status === 'confirmed') toast.success('Payment received. Your account is open.');
      else if (res.deposit.status === 'rejected') toast.error('The payment did not go through. See the reason above.');
      else toast.success('Prompt sent. Approve it on your phone.');
    } else {
      const res = await api.post('/api/payments/deposits', { channel: selected, ...data }, { idempotencyKey: newIdempotencyKey() });
      toast.success(`Submitted. Reference ${res.deposit.reference}.`);
    }
    form.reset();
    $('#activate-phone').value = me?.phone ?? '';
    await refresh();
  });

  // While a payment waits, check again so the account opens without a reload: every 5 seconds for a phone prompt,
  // every 15 seconds for a payment staff check.
  let ticks = 0;
  setInterval(() => {
    ticks++;
    if (document.visibilityState !== 'visible' || $('#waiting').hidden) return;
    if (waitingOnPrompt || ticks % 3 === 0) void refresh();
  }, 5_000);
}
