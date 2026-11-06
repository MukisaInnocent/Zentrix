import { api, ApiError, newIdempotencyKey } from '../core/api.js';
import { $, h } from '../core/dom.js';
import { formatDate, formatMoney } from '../core/format.js';
import { bindForm } from '../core/forms.js';
import { paymentBadge, reportProblem } from '../core/payments.js';
import { toast } from '../core/toast.js';

// Withdrawal request. The server previews the fee and limits, holds amount plus fee, and staff send the payout to
// the member's verified phone. The page only displays server values.
// Task earnings cannot be withdrawn yet (owner, 2026-11-03), so the main balance is the only choice.
const SOURCES = { main: 'Balance' };

// The status of the member's latest withdrawal, as a card at the top (owner, 2026-11-06). Shown while it is open, and
// for a day after it is paid, failed or cancelled. Amounts come from the server.
const RECENT_MS = 24 * 60 * 60 * 1000;
function statusText(w) {
  const amount = h('strong', {}, formatMoney(w.amountMinor, w.currency));
  const total = h('strong', {}, formatMoney(w.totalMinor, w.currency));
  const fee = formatMoney(w.feeMinor, w.currency);
  switch (w.status) {
    case 'requested':
      // The owner's wording (2026-11-06).
      return ['Congratulations, Withdrawal Initiated Successfully', ['Your request for ', amount, ' has been processed. A total of ', total, ` (including charges of ${fee}) was deducted from your balance.`]];
    case 'approved':
      return ['Withdrawal Approved', ['Your request for ', amount, ` is approved and will be sent to ${w.payoutPhone} shortly.`]];
    case 'processing':
      return ['Withdrawal Being Sent', [amount, ` is on its way to ${w.payoutPhone}.`]];
    case 'paid':
      return ['Withdrawal Paid', [amount, ` was sent to ${w.payoutPhone}.`]];
    case 'failed':
      return ['Withdrawal Failed', ['Your request for ', amount, ' could not be sent. ', total, ' is back in your balance.', w.closedReason ? ` ${w.closedReason}` : '']];
    case 'cancelled':
      return ['Withdrawal Cancelled', ['Your request for ', amount, ' was cancelled. ', total, ' is back in your balance.']];
    default:
      return null;
  }
}

function showStatus(w) {
  const box = $('#wd-status');
  const closedAt = w && (w.paidAt ?? w.closedAt);
  const text = w && (!closedAt || Date.now() - new Date(closedAt).getTime() < RECENT_MS) ? statusText(w) : null;
  if (!text) {
    box.hidden = true;
    return;
  }
  box.className = `zx-wd-status zx-wd-status--${w.status}`;
  // The transaction details under the message (owner, 2026-11-06).
  const row = (label, value) => [h('dt', {}, label), h('dd', {}, value)];
  box.replaceChildren(h('h2', { class: 'zx-wd-status__title' }, text[0]), h('p', { class: 'zx-wd-status__text' }, ...text[1]),
    h('dl', { class: 'zx-wd-status__details' },
      ...row('Reference', w.reference),
      ...row('Date', formatDate(w.createdAt, { withTime: true })),
      ...row('Amount', formatMoney(w.amountMinor, w.currency)),
      ...row('Charges', formatMoney(w.feeMinor, w.currency)),
      ...row('Total deducted', formatMoney(w.totalMinor, w.currency)),
      ...row('Sent to', w.payoutPhone),
      ...row('Method', w.channel?.name ?? '-'),
      ...row('Status', w.status.charAt(0).toUpperCase() + w.status.slice(1))));
  box.hidden = false;
}

let quoteSeq = 0;
async function updateQuote(amount) {
  const box = $('#quote');
  const seq = ++quoteSeq;
  if (!/^\d+(\.\d+)?$/.test(amount)) {
    box.hidden = true;
    return;
  }
  try {
    const { quote: q } = await api.get(`/api/payments/withdrawals/quote?amount=${encodeURIComponent(amount)}`);
    if (seq !== quoteSeq) return;
    box.replaceChildren(
      h('div', {}, h('span', {}, 'Charge'), h('span', {}, formatMoney(q.chargeMinor, q.currency))),
      h('div', {}, h('span', {}, `Tax (${q.taxBasisPoints / 100}%)`), h('span', {}, formatMoney(q.taxMinor, q.currency))),
      h('div', {}, h('span', {}, 'Total fee'), h('span', {}, formatMoney(q.feeMinor, q.currency))),
      h('div', {}, h('span', {}, 'Total taken'), h('span', {}, formatMoney(q.totalMinor, q.currency))));
    box.hidden = false;
  } catch (err) {
    if (seq !== quoteSeq) return;
    box.replaceChildren(h('div', {}, h('span', { class: 'zx-error' }, err instanceof ApiError ? err.message : 'Could not preview the fee.')));
    box.hidden = false;
  }
}

async function refresh() {
  const [summary, list] = await Promise.all([api.get('/api/wallet/summary'), api.get('/api/payments/withdrawals')]);
  $('#stat-available').textContent = formatMoney(summary.availableBalanceMinor, summary.currency);
  $('#stat-held').textContent = formatMoney(summary.reservedBalanceMinor, summary.currency);
  $('#stat-withdrawn').textContent = formatMoney(summary.totalWithdrawnMinor, summary.currency);
  const source = $('#withdraw-source');
  const current = source.value || 'main';
  const balances = { main: summary.availableBalanceMinor, ...summary.taskBalancesMinor };
  source.replaceChildren(...Object.entries(SOURCES).map(([key, label]) =>
    h('option', { value: key, selected: key === current }, `${label}: ${formatMoney(balances[key] ?? '0', summary.currency)}`)));

  showStatus(list.withdrawals[0]);
  const body = $('#withdraw-history-body');
  if (!list.withdrawals.length) {
    body.replaceChildren(h('tr', {}, h('td', { colspan: '7', class: 'zx-td-empty' }, 'No withdrawals yet.')));
    return;
  }
  body.replaceChildren(...list.withdrawals.map(w => {
    const actions = [];
    if (w.status === 'requested') {
      const cancel = h('button', { type: 'button', class: 'zx-btn zx-btn--ghost zx-btn--sm' }, 'Cancel');
      cancel.addEventListener('click', async () => {
        try {
          await api.post(`/api/payments/withdrawals/${w.id}/cancel`, {}, { idempotencyKey: newIdempotencyKey() });
          toast.success('Cancelled. The money is back in your balance.');
          await refresh();
        } catch (err) {
          toast.error(err.message);
        }
      });
      actions.push(cancel);
    }
    if (w.status !== 'cancelled') {
      const report = h('button', { type: 'button', class: 'zx-btn zx-btn--ghost zx-btn--sm' }, 'Report');
      report.addEventListener('click', () => void reportProblem('withdrawal', w.reference));
      actions.push(report);
    }
    return h('tr', {},
      h('td', { class: 'zx-td-muted' }, formatDate(w.createdAt, { withTime: true })),
      h('td', { class: 'zx-td-mono' }, w.reference),
      h('td', { class: 'zx-amount zx-amount--out' }, formatMoney(w.amountMinor, w.currency)),
      h('td', { class: 'zx-td-muted' }, formatMoney(w.feeMinor, w.currency)),
      h('td', { class: 'zx-td-mono' }, w.payoutPhone),
      h('td', {}, paymentBadge(w.status), w.closedReason ? h('div', { class: 'zx-hint' }, w.closedReason) : null),
      h('td', {}, h('span', { class: 'zx-row-actions' }, actions)));
  }));
}

export async function init() {
  const info = await api.get('/api/payments/channels');
  $('#paused').hidden = !info.withdrawalsPaused;
  $('#no-phone').hidden = Boolean(info.payoutPhone);
  $('#withdraw-submit').disabled = info.withdrawalsPaused || !info.payoutPhone;

  let timer;
  $('#withdraw-amount').addEventListener('input', e => {
    clearTimeout(timer);
    timer = setTimeout(() => void updateQuote(e.target.value.trim()), 350);
  });

  bindForm($('#withdraw-form'), async (data, form) => {
    await api.post('/api/payments/withdrawals', data, { idempotencyKey: newIdempotencyKey() });
    form.elements.namedItem('amount').value = '';
    $('#quote').hidden = true;
    await refresh();
    $('#wd-status').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  await refresh();
}
