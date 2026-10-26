import { api } from '../core/api.js';
import { $ } from '../core/dom.js';
import { formatMoney } from '../core/format.js';
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

  const [summary, referrals] = await Promise.all([
    api.get('/api/wallet/summary').catch(() => null),
    api.get('/api/referrals').catch(() => null),
  ]);

  if (summary) {
    const c = summary.currency;
    // Balance holds referral money only; deposited money shows under Deposit. Total earnings (referral and task
    // income), expenses and net come from the server.
    set('#stat-available', money(summary.availableBalanceMinor, c));
    set('#stat-deposit', money(summary.depositBalanceMinor, c));
    set('#stat-total-earnings', money(summary.totalEarningsMinor, c));
    set('#stat-expenses', money(summary.expensesMinor, c));
    set('#stat-net', money(summary.netEarningsMinor, c));
    set('#stat-withdrawn', money(summary.totalWithdrawnMinor, c));
    set('#stat-pending', money(summary.reservedBalanceMinor, c));
    set('#stat-referrals', money(summary.referralEarningsMinor, c));
    for (const m of ['youtube', 'tiktok', 'ads', 'trivia', 'music', 'fixtap']) set(`#task-${m}-val`, money(summary.taskBalancesMinor[m], c));
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
}
