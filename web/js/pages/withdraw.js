import { api, ApiError, newIdempotencyKey } from '../core/api.js';
import { $, h } from '../core/dom.js';
import { formatDate, formatMoney } from '../core/format.js';
import { bindForm } from '../core/forms.js';
import { mountReports, paymentBadge, reportProblem } from '../core/payments.js';
import { toast } from '../core/toast.js';

// Withdrawal request. The server previews the fee and limits, holds amount plus fee, and staff send the payout
// to the member's verified phone. The page only displays server values.
const SOURCES = { main: 'Main balance', youtube: 'YouTube earnings', tiktok: 'TikTok earnings', ads: 'Ads earnings', trivia: 'Trivia earnings', fixtap: 'Fix Tap earnings', music: 'Music earnings' };
const STEP = { requested: 'Waiting for approval', approved: 'Approved, waiting to be sent', processing: 'Being sent now', paid: 'Sent to your phone', failed: 'Payout failed, money returned', cancelled: 'Cancelled, money returned' };

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
      h('div', {}, h('span', {}, 'Amount sent to you'), h('span', {}, formatMoney(q.amountMinor, q.currency))),
      h('div', {}, h('span', {}, 'Withdrawal fee'), h('span', {}, formatMoney(q.feeMinor, q.currency))),
      h('div', {}, h('span', {}, 'Limits'), h('span', {}, `${formatMoney(q.limits.minMinor, q.currency)} to ${formatMoney(q.limits.maxMinor, q.currency)}`)),
      q.needsAdminApproval ? h('div', {}, h('span', { class: 'zx-hint' }, 'An admin reviews this one (large amount or new account).'), h('span', {})) : null,
      h('div', {}, h('span', {}, 'Taken from your balance'), h('span', {}, formatMoney(q.totalMinor, q.currency))));
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
    body.replaceChildren(h('tr', {}, h('td', { colspan: '6', class: 'zx-td-empty' }, 'No withdrawals yet.')));
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
      const report = h('button', { type: 'button', class: 'zx-btn zx-btn--ghost zx-btn--sm' }, 'Report a problem');
      report.addEventListener('click', () => void reportProblem('withdrawal', w.reference));
      actions.push(report);
    }
    return h('tr', {},
      h('td', { class: 'zx-td-muted' }, formatDate(w.createdAt, { withTime: true })),
      h('td', { class: 'zx-amount zx-amount--out' }, formatMoney(w.amountMinor, w.currency)),
      h('td', { class: 'zx-td-muted' }, formatMoney(w.feeMinor, w.currency)),
      h('td', { class: 'zx-td-mono' }, `${w.payoutPhone} · ${w.channel.name}`),
      h('td', {}, paymentBadge(w.status), h('div', { class: 'zx-hint' }, STEP[w.status] ?? ''),
        w.payoutTxnId ? h('div', { class: 'zx-hint' }, `Transaction ${w.payoutTxnId}`) : null,
        w.closedReason ? h('div', { class: 'zx-hint' }, w.closedReason) : null),
      h('td', {}, h('span', { class: 'zx-row-actions' }, actions)));
  }));
}

export async function init() {
  const info = await api.get('/api/payments/channels');
  const payouts = info.channels.filter(c => c.payoutsEnabled);
  $('#withdraw-channel').replaceChildren(...payouts.map(c => h('option', { value: c.code }, c.name)));
  $('#paused').hidden = !info.withdrawalsPaused;
  $('#no-phone').hidden = Boolean(info.payoutPhone);
  if (info.payoutPhone) $('#payout-phone').textContent = info.payoutPhone;
  $('#withdraw-submit').disabled = info.withdrawalsPaused || !info.payoutPhone || payouts.length === 0;

  let timer;
  $('#withdraw-amount').addEventListener('input', e => {
    clearTimeout(timer);
    timer = setTimeout(() => void updateQuote(e.target.value.trim()), 350);
  });

  bindForm($('#withdraw-form'), async (data, form) => {
    const res = await api.post('/api/payments/withdrawals', data, { idempotencyKey: newIdempotencyKey() });
    toast.success(`Requested ${formatMoney(res.withdrawal.amountMinor, res.withdrawal.currency)}. Reference ${res.withdrawal.reference}.`);
    form.elements.namedItem('amount').value = '';
    $('#quote').hidden = true;
    await refresh();
  });

  await Promise.all([refresh(), mountReports($('#reports'))]);
}
