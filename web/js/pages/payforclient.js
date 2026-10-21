import { api, ApiError } from '../core/api.js';
import { $ } from '../core/dom.js';
import { formatMoney } from '../core/format.js';
import { toast } from '../core/toast.js';

export async function init() {
  async function refresh() {
    try {
      const summary = await api.get('/api/wallet/summary');
      if ($('#pfc-balance')) $('#pfc-balance').textContent = formatMoney(summary.availableBalanceMinor, summary.currency);

      const pData = await api.get('/api/client-payments');
      const payments = pData.payments || [];
      if ($('#pfc-count')) $('#pfc-count').textContent = String(payments.length);

      const tbody = $('#pfc-history-body');
      if (tbody) {
        if (payments.length === 0) {
          tbody.innerHTML = `<tr><td colspan="6" class="zx-td-empty">No client payments made yet.</td></tr>`;
        } else {
          tbody.innerHTML = payments
            .map(p => {
              const dateStr = new Date(p.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
              return `
                <tr>
                  <td class="zx-td-muted">${dateStr}</td>
                  <td class="zx-td-strong">${p.clientName}</td>
                  <td>${p.clientPhone}</td>
                  <td class="zx-amount zx-amount--out">- ${formatMoney(p.amountMinor, p.currency)}</td>
                  <td class="zx-td-mono">${p.reference}</td>
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
      console.error('Failed to load client payments', err);
    }
  }

  const form = $('#pfc-form');
  const alert = $('#pfc-alert');
  const submitBtn = $('#pfc-submit');

  form?.addEventListener('submit', async e => {
    e.preventDefault();
    alert.textContent = '';
    submitBtn.setAttribute('aria-busy', 'true');
    submitBtn.disabled = true;

    const data = new FormData(form);
    const clientName = String(data.get('clientName') || '').trim();
    const clientPhone = String(data.get('clientPhone') || '').trim();
    const amount = Number(data.get('amount') || 0);
    const note = String(data.get('note') || '').trim();

    try {
      await api.post('/api/client-payments', { clientName, clientPhone, amount, note });
      toast.success(`Client payment for ${clientName} sent successfully!`);
      submitBtn.removeAttribute('aria-busy');
      submitBtn.disabled = false;
      await refresh();
    } catch (err) {
      submitBtn.removeAttribute('aria-busy');
      submitBtn.disabled = false;
      if (err instanceof ApiError) {
        alert.textContent = err.message || 'Payment failed. Please check your balance.';
      } else {
        alert.textContent = 'Connection error. Please try again.';
      }
    }
  });

  await refresh();
}
