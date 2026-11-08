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

// After a withdrawal request, the owner's message (2026-11-08: exactly this wording and format, in a green card). It shows
// for a short time and then goes away; the request's progress is in the history below. Amounts come from the server.
const MESSAGE_MS = 10_000;
let messageTimer;
function showMessage(w) {
  const box = $('#wd-status');
  clearTimeout(messageTimer);
  box.className = 'zx-wd-status';
  box.replaceChildren(
    h('h2', { class: 'zx-wd-status__title' }, 'Congratulations, Withdrawal Initiated Successfully'),
    h('p', { class: 'zx-wd-status__text' },
      'Your request for ', h('strong', {}, formatMoney(w.amountMinor, w.currency)), ' has been processed. A total of ',
      h('strong', {}, formatMoney(w.totalMinor, w.currency)), ` (including charges of ${formatMoney(w.feeMinor, w.currency)}) was deducted from your balance.`));
  box.hidden = false;
  messageTimer = setTimeout(() => {
    box.classList.add('zx-wd-status--leaving');
    messageTimer = setTimeout(() => { box.hidden = true; }, 600);
  }, MESSAGE_MS);
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
    const { withdrawal } = await api.post('/api/payments/withdrawals', data, { idempotencyKey: newIdempotencyKey() });
    form.elements.namedItem('amount').value = '';
    $('#quote').hidden = true;
    showMessage(withdrawal);
    $('#wd-status').scrollIntoView({ behavior: 'smooth', block: 'start' });
    await refresh();
  });

  await refresh();
}
