import { api } from '../core/api.js';
import { $ } from '../core/dom.js';
import { formatMoney } from '../core/format.js';
import { toast } from '../core/toast.js';

export async function init({ me }) {
  if (me && $('#welcome-heading')) {
    $('#welcome-heading').textContent = `Welcome back, ${me.username}`;
  }

  // Load wallet summary
  try {
    const summary = await api.get('/api/wallet/summary');
    if ($('#stat-available')) $('#stat-available').textContent = formatMoney(summary.availableBalanceMinor, summary.currency);
    if ($('#stat-referrals')) $('#stat-referrals').textContent = formatMoney(summary.totalReferralEarnedMinor, summary.currency);
    if ($('#stat-deposited')) $('#stat-deposited').textContent = formatMoney(summary.totalDepositedMinor, summary.currency);
    if ($('#stat-withdrawn')) $('#stat-withdrawn').textContent = formatMoney(summary.totalWithdrawnMinor, summary.currency);

    // Module task balances
    if ($('#task-youtube-val')) $('#task-youtube-val').textContent = formatMoney(summary.taskBalancesMinor.youtube, summary.currency);
    if ($('#task-tiktok-val')) $('#task-tiktok-val').textContent = formatMoney(summary.taskBalancesMinor.tiktok, summary.currency);
    if ($('#task-ads-val')) $('#task-ads-val').textContent = formatMoney(summary.taskBalancesMinor.ads, summary.currency);
    if ($('#task-trivia-val')) $('#task-trivia-val').textContent = formatMoney(summary.taskBalancesMinor.trivia, summary.currency);
  } catch (err) {
    console.error('Failed to load wallet summary', err);
  }

  // Load referral link
  try {
    const refData = await api.get('/api/referrals');
    const input = $('#ref-link-input');
    const copyBtn = $('#copy-ref-btn');
    if (input && refData.referralLink) {
      input.value = refData.referralLink;
    }
    copyBtn?.addEventListener('click', () => {
      if (input && input.value) {
        navigator.clipboard.writeText(input.value).then(() => {
          toast.success('Referral link copied to clipboard!');
        });
      }
    });
  } catch (err) {
    console.error('Failed to load referral link', err);
  }

  // Load recent transactions
  try {
    const txData = await api.get('/api/wallet/transactions?limit=6');
    const tbody = $('#transactions-body');
    if (tbody) {
      if (!txData.transactions || txData.transactions.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" class="zx-td-empty">No transactions yet. Complete tasks or make a deposit to get started!</td></tr>`;
      } else {
        tbody.innerHTML = txData.transactions
          .map(t => {
            const dateStr = new Date(t.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
            const isCredit = !String(t.amountMinor).startsWith('-');
            const prefix = isCredit ? '+' : '';
            return `
              <tr>
                <td class="zx-td-muted">${dateStr}</td>
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
    console.error('Failed to load transactions', err);
  }
}
