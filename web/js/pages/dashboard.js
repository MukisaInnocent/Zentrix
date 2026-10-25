import { api } from '../core/api.js';
import { $, h } from '../core/dom.js';
import { formatDate, formatMoney } from '../core/format.js';
import { paymentBadge } from '../core/payments.js';
import { toast } from '../core/toast.js';

const money = (minor, currency) => formatMoney(minor, currency);
const set = (id, text) => {
  const el = $(id);
  if (el) el.textContent = text;
};

export async function init({ me }) {
  set('#welcome-heading', `Welcome back, ${me.username}`);
  set('#me-username', `@${me.username}`);
  set('#me-phone', me.phone ?? '');
  set('#me-email', me.email ?? '');
  set('#me-upline', me.referrer ? `@${me.referrer.username}` : 'None');

  const [summary, referrals, withdrawals, transactions] = await Promise.all([
    api.get('/api/wallet/summary').catch(() => null),
    api.get('/api/referrals').catch(() => null),
    api.get('/api/payments/withdrawals').catch(() => null),
    api.get('/api/wallet/transactions?limit=6').catch(() => null),
  ]);

  if (summary) {
    const c = summary.currency;
    // Balance holds referral money only. Earnings, expenses and net come from the server.
    set('#stat-available', money(summary.availableBalanceMinor, c));
    set('#stat-total-earnings', money(summary.totalEarningsMinor, c));
    set('#stat-expenses', money(summary.expensesMinor, c));
    set('#stat-net', money(summary.netEarningsMinor, c));
    set('#stat-withdrawn', money(summary.totalWithdrawnMinor, c));
    for (const m of ['youtube', 'tiktok', 'ads', 'trivia']) set(`#task-${m}-val`, money(summary.taskBalancesMinor[m], c));
  }

  if (referrals) {
    set('#me-referred', String(referrals.levels[1].total));
    const input = $('#ref-link-input');
    input.value = referrals.referralLink;
    $('#copy-ref-btn').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(input.value);
        toast.success('Referral link copied');
      } catch {
        input.select();
      }
    });
  }

  const pending = (withdrawals?.withdrawals ?? []).filter(w => ['requested', 'approved', 'processing'].includes(w.status));
  $('#pending-body').replaceChildren(...(pending.length
    ? pending.map(w => h('tr', {},
      h('td', { class: 'zx-td-muted' }, formatDate(w.createdAt)),
      h('td', { class: 'zx-td-mono' }, w.reference),
      h('td', { class: 'zx-amount zx-amount--out' }, money(w.amountMinor, w.currency)),
      h('td', {}, paymentBadge(w.status))))
    : [h('tr', {}, h('td', { colspan: '4', class: 'zx-td-empty' }, 'No pending withdrawals.'))]));

  const list = transactions?.transactions ?? [];
  $('#transactions-body').replaceChildren(...(list.length
    ? list.map(t => {
      const credit = !String(t.amountMinor).startsWith('-');
      return h('tr', {},
        h('td', { class: 'zx-td-muted' }, formatDate(t.createdAt, { withTime: true })),
        h('td', { class: 'zx-td-strong' }, t.description),
        h('td', { class: `zx-amount ${credit ? 'zx-amount--in' : 'zx-amount--out'}` }, `${credit ? '+' : ''}${money(t.amountMinor, t.currency)}`),
        h('td', { class: 'zx-td-muted' }, money(t.balanceAfterMinor, t.currency)));
    })
    : [h('tr', {}, h('td', { colspan: '4', class: 'zx-td-empty' }, 'No transactions yet.'))]));
}
