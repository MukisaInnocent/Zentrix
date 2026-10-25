import { api } from '../core/api.js';
import { $ } from '../core/dom.js';
import { formatMoney } from '../core/format.js';

export async function init() {
  try {
    const summary = await api.get('/api/wallet/summary');
    if ($('#acc-main-balance')) $('#acc-main-balance').textContent = formatMoney(summary.availableBalanceMinor, summary.currency);
    if ($('#acc-ref-balance')) $('#acc-ref-balance').textContent = formatMoney(summary.totalReferralEarnedMinor, summary.currency);
    if ($('#acc-deposited')) $('#acc-deposited').textContent = formatMoney(summary.totalEarningsMinor, summary.currency);
    if ($('#acc-withdrawn')) $('#acc-withdrawn').textContent = formatMoney(summary.totalWithdrawnMinor, summary.currency);

    if ($('#acc-youtube')) $('#acc-youtube').textContent = formatMoney(summary.taskBalancesMinor.youtube, summary.currency);
    if ($('#acc-tiktok')) $('#acc-tiktok').textContent = formatMoney(summary.taskBalancesMinor.tiktok, summary.currency);
    if ($('#acc-ads')) $('#acc-ads').textContent = formatMoney(summary.taskBalancesMinor.ads, summary.currency);
    if ($('#acc-trivia')) $('#acc-trivia').textContent = formatMoney(summary.taskBalancesMinor.trivia, summary.currency);

    const txData = await api.get('/api/wallet/transactions?limit=100');
    const tbody = $('#statement-body');
    if (tbody) {
      if (!txData.transactions || txData.transactions.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="zx-td-empty">No transactions recorded yet.</td></tr>`;
      } else {
        tbody.innerHTML = txData.transactions
          .map(t => {
            const dateStr = new Date(t.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
            const isCredit = !String(t.amountMinor).startsWith('-');
            const prefix = isCredit ? '+' : '';
            return `
              <tr>
                <td class="zx-td-muted">${dateStr}</td>
                <td class="zx-td-kind">${t.kind.replace('_', ' ')}</td>
                <td class="zx-td-strong">${t.description}</td>
                <td class="zx-amount ${isCredit ? 'zx-amount--in' : 'zx-amount--out'}">${prefix}${formatMoney(t.amountMinor, t.currency)}</td>
                <td class="zx-td-muted">${formatMoney(t.balanceAfterMinor, t.currency)}</td>
              </tr>
            `;
          })
          .join('');
      }
    }
  } catch (err) {
    console.error('Failed to load accounts statement', err);
  }
}
