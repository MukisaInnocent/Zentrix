import { api, ApiError } from '../core/api.js';
import { $ } from '../core/dom.js';
import { formatMoney } from '../core/format.js';
import { toast } from '../core/toast.js';

export async function init({ me }) {
  if (me && $('#withdraw-destination') && me.phone) {
    $('#withdraw-destination').value = me.phone;
  }

  const amountInput = $('#withdraw-amount');
  const calcFee = $('#calc-fee');
  const calcTotal = $('#calc-total');

  function updateCalc() {
    const val = Number(amountInput?.value || 0);
    const fee = Math.round((val * 50) / 10000);
    const total = val + fee;
    if (calcFee) calcFee.textContent = formatMoney(String(fee), 'UGX');
    if (calcTotal) calcTotal.textContent = formatMoney(String(total), 'UGX');
  }

  amountInput?.addEventListener('input', updateCalc);
  updateCalc();

  async function refresh() {
    try {
      const summary = await api.get('/api/wallet/summary');
      if ($('#stat-available')) $('#stat-available').textContent = formatMoney(summary.availableBalanceMinor, summary.currency);
      if ($('#stat-withdrawn')) $('#stat-withdrawn').textContent = formatMoney(summary.totalWithdrawnMinor, summary.currency);

      const txData = await api.get('/api/wallet/transactions?limit=20');
      const withdrawals = (txData.transactions || []).filter(t => t.kind === 'withdrawal');
      const tbody = $('#withdraw-history-body');
      if (tbody) {
        if (withdrawals.length === 0) {
          tbody.innerHTML = `<tr><td colspan="5" class="zx-td-empty">No withdrawals yet. Requested payouts will appear here.</td></tr>`;
        } else {
          tbody.innerHTML = withdrawals
            .map(w => {
              const dateStr = new Date(w.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
              return `
                <tr>
                  <td class="zx-td-muted">${dateStr}</td>
                  <td class="zx-td-strong">${w.description}</td>
                  <td class="zx-td-mono">${w.reference || '—'}</td>
                  <td class="zx-amount zx-amount--out">${formatMoney(w.amountMinor, w.currency)}</td>
                  <td>
                    <span class="zx-badge zx-badge--success">
                      Paid
                    </span>
                  </td>
                </tr>
              `;
            })
            .join('');
        }
      }
    } catch (err) {
      console.error('Failed to load withdrawal data', err);
    }
  }

  const form = $('#withdraw-form');
  const alert = $('#withdraw-alert');
  const submitBtn = $('#withdraw-submit');

  form?.addEventListener('submit', async e => {
    e.preventDefault();
    alert.textContent = '';
    submitBtn.setAttribute('aria-busy', 'true');
    submitBtn.disabled = true;

    const data = new FormData(form);
    const amount = Number(data.get('amount') || 0);
    const method = String(data.get('method') || 'MTN Mobile Money');
    const destination = String(data.get('destination') || '');

    try {
      await api.post('/api/wallet/withdraw', { amount, method, destination });
      toast.success(`Withdrawal of UGX ${amount.toLocaleString()} requested successfully!`);
      submitBtn.removeAttribute('aria-busy');
      submitBtn.disabled = false;
      await refresh();
    } catch (err) {
      submitBtn.removeAttribute('aria-busy');
      submitBtn.disabled = false;
      if (err instanceof ApiError) {
        alert.textContent = err.message || 'Withdrawal failed. Please check your available balance.';
      } else {
        alert.textContent = 'Connection error. Please try again.';
      }
    }
  });

  await refresh();
}
