import { api, ApiError } from '../core/api.js';
import { $ } from '../core/dom.js';
import { formatMoney } from '../core/format.js';
import { toast } from '../core/toast.js';

export async function init({ me }) {
  if (me && $('#deposit-phone') && me.phone) {
    $('#deposit-phone').value = me.phone;
  }

  async function refresh() {
    try {
      const summary = await api.get('/api/wallet/summary');
      if ($('#stat-balance')) $('#stat-balance').textContent = formatMoney(summary.availableBalanceMinor, summary.currency);
      if ($('#stat-total-deposited')) $('#stat-total-deposited').textContent = formatMoney(summary.totalDepositedMinor, summary.currency);

      const txData = await api.get('/api/wallet/transactions?limit=20');
      const deposits = (txData.transactions || []).filter(t => t.kind === 'deposit');
      const tbody = $('#deposit-history-body');
      if (tbody) {
        if (deposits.length === 0) {
          tbody.innerHTML = `<tr><td colspan="5" class="zx-td-empty">No deposits yet. Use the form above to add your first deposit!</td></tr>`;
        } else {
          tbody.innerHTML = deposits
            .map(d => {
              const dateStr = new Date(d.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
              return `
                <tr>
                  <td class="zx-td-muted">${dateStr}</td>
                  <td class="zx-td-strong">${d.description}</td>
                  <td class="zx-td-mono">${d.reference || '—'}</td>
                  <td class="zx-amount zx-amount--in">+ ${formatMoney(d.amountMinor, d.currency)}</td>
                  <td>
                    <span class="zx-badge zx-badge--success">
                      Completed
                    </span>
                  </td>
                </tr>
              `;
            })
            .join('');
        }
      }
    } catch (err) {
      console.error('Failed to load deposit data', err);
    }
  }

  // Preset buttons
  document.querySelectorAll('.preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = btn.getAttribute('data-val');
      const input = $('#deposit-amount');
      if (input && val) input.value = val;
    });
  });

  // Submit form
  const form = $('#deposit-form');
  const alert = $('#deposit-alert');
  const submitBtn = $('#deposit-submit');

  form?.addEventListener('submit', async e => {
    e.preventDefault();
    alert.textContent = '';
    submitBtn.setAttribute('aria-busy', 'true');
    submitBtn.disabled = true;

    const data = new FormData(form);
    const amount = Number(data.get('amount') || 0);
    const method = String(data.get('method') || 'MTN Mobile Money');
    const phone = String(data.get('phone') || '');

    try {
      const res = await api.post('/api/wallet/deposit', { amount, method, phone });
      toast.success(`Successfully deposited UGX ${amount.toLocaleString()}!`);
      submitBtn.removeAttribute('aria-busy');
      submitBtn.disabled = false;
      await refresh();
    } catch (err) {
      submitBtn.removeAttribute('aria-busy');
      submitBtn.disabled = false;
      if (err instanceof ApiError) {
        alert.textContent = err.message || 'Deposit failed. Please try again.';
      } else {
        alert.textContent = 'Connection error. Please try again.';
      }
    }
  });

  await refresh();
}
