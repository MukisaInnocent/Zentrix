import { api, ApiError, newIdempotencyKey } from '../core/api.js';
import { $ } from '../core/dom.js';
import { formatMoney } from '../core/format.js';
import { toast } from '../core/toast.js';

export async function init() {
  async function refresh() {
    try {
      const summary = await api.get('/api/wallet/summary');
      if ($('#voucher-wallet-balance')) $('#voucher-wallet-balance').textContent = formatMoney(summary.availableBalanceMinor, summary.currency);

      const vData = await api.get('/api/vouchers');
      const vouchers = vData.vouchers || [];
      const activeCount = vouchers.filter(v => v.status === 'active').length;
      if ($('#active-vouchers-count')) $('#active-vouchers-count').textContent = String(activeCount);

      const tbody = $('#vouchers-body');
      if (tbody) {
        if (vouchers.length === 0) {
          tbody.innerHTML = `<tr><td colspan="5" class="zx-td-empty">No vouchers created yet. Use the form above to purchase your first voucher!</td></tr>`;
        } else {
          tbody.innerHTML = vouchers
            .map(v => {
              const dateStr = new Date(v.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
              const isActive = v.status === 'active';
              const badgeClass = isActive ? 'zx-badge--success' : '';
              const copyBtn = isActive
                ? `<button class="zx-btn zx-btn--secondary zx-btn--sm copy-v-btn" data-code="${v.code}">Copy</button>`
                : `—`;

              return `
                <tr>
                  <td class="zx-td-mono zx-td-strong">${v.code}</td>
                  <td class="zx-td-strong">${formatMoney(v.amountMinor, v.currency)}</td>
                  <td class="zx-td-muted">${dateStr}</td>
                  <td>
                    <span class="zx-badge zx-badge--cap ${badgeClass}">
                      ${v.status}
                    </span>
                  </td>
                  <td>${copyBtn}</td>
                </tr>
              `;
            })
            .join('');

          tbody.querySelectorAll('.copy-v-btn').forEach(btn => {
            btn.addEventListener('click', () => {
              const code = btn.getAttribute('data-code');
              if (code) {
                navigator.clipboard.writeText(code).then(() => {
                  toast.success(`Voucher ${code} copied!`);
                });
              }
            });
          });
        }
      }
    } catch (err) {
      console.error('Failed to load voucher data', err);
    }
  }

  // Buy voucher form
  const buyForm = $('#buy-voucher-form');
  const buyAlert = $('#buy-alert');
  const buySubmit = $('#buy-submit');

  buyForm?.addEventListener('submit', async e => {
    e.preventDefault();
    buyAlert.textContent = '';
    buySubmit.setAttribute('aria-busy', 'true');
    buySubmit.disabled = true;

    const data = new FormData(buyForm);
    const amount = String(data.get('amount') || '').trim();
    const quantity = Number(data.get('quantity') || 1);

    try {
      await api.post('/api/vouchers/buy', { amount, quantity }, { idempotencyKey: newIdempotencyKey() });
      toast.success(`Successfully created ${quantity} voucher(s)!`);
      buySubmit.removeAttribute('aria-busy');
      buySubmit.disabled = false;
      await refresh();
    } catch (err) {
      buySubmit.removeAttribute('aria-busy');
      buySubmit.disabled = false;
      if (err instanceof ApiError) {
        buyAlert.textContent = err.message || 'Failed to purchase voucher.';
      } else {
        buyAlert.textContent = 'Connection error. Please try again.';
      }
    }
  });

  // Redeem voucher form
  const redeemForm = $('#redeem-voucher-form');
  const redeemAlert = $('#redeem-alert');
  const redeemSubmit = $('#redeem-submit');

  redeemForm?.addEventListener('submit', async e => {
    e.preventDefault();
    redeemAlert.textContent = '';
    redeemSubmit.setAttribute('aria-busy', 'true');
    redeemSubmit.disabled = true;

    const data = new FormData(redeemForm);
    const code = String(data.get('code') || '').trim();

    try {
      const res = await api.post('/api/vouchers/redeem', { code }, { idempotencyKey: newIdempotencyKey() });
      toast.success(`Voucher redeemed: ${formatMoney(res.amount, res.currency)} added to your main balance.`);
      redeemSubmit.removeAttribute('aria-busy');
      redeemSubmit.disabled = false;
      if ($('#redeem-code')) $('#redeem-code').value = '';
      await refresh();
    } catch (err) {
      redeemSubmit.removeAttribute('aria-busy');
      redeemSubmit.disabled = false;
      if (err instanceof ApiError) {
        redeemAlert.textContent = err.message || 'Invalid or redeemed voucher code.';
      } else {
        redeemAlert.textContent = 'Connection error. Please try again.';
      }
    }
  });

  await refresh();
}
