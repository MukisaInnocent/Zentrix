import { api, ApiError, newIdempotencyKey } from '../core/api.js';
import { formatMoney } from '../core/format.js';
import { $ } from '../core/dom.js';
import { toast } from '../core/toast.js';

export async function init() {
  const badge = $('#status-badge');
  const btn = $('#activate-btn');
  const desc = $('#membership-desc');

  async function check() {
    try {
      const res = await api.get('/api/wallet/membership/status');
      if (res.active) {
        if (badge) {
          badge.textContent = 'Active Member';
          badge.className = 'zx-status-badge zx-status-badge--success';
        }
        if (desc && res.activatedAt) {
          const d = new Date(res.activatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
          desc.textContent = `Your membership was activated on ${d}. All task modules are open to you.`;
        }
        if (btn) {
          btn.textContent = 'Membership Active';
          btn.disabled = true;
          btn.classList.add('zx-btn--secondary');
        }
      } else {
        if (badge) {
          badge.textContent = 'Pending Activation';
          badge.className = 'zx-status-badge zx-status-badge--warning';
        }
        if (btn) {
          btn.textContent = res.fee ? `Activate membership (${formatMoney(res.fee, res.currency)})` : 'Membership is not available in your country yet';
          btn.disabled = !res.fee;
        }
      }
    } catch (err) {
      console.error('Failed to check membership status', err);
    }
  }

  btn?.addEventListener('click', async () => {
    btn.setAttribute('aria-busy', 'true');
    btn.disabled = true;
    try {
      const res = await api.post('/api/wallet/membership/activate', {}, { idempotencyKey: newIdempotencyKey() });
      toast.success(`Membership active. Receipt ${res.receiptNo}: ${formatMoney(res.feeMinor, res.currency)} paid from your main balance.`);
      btn.removeAttribute('aria-busy');
      await check();
    } catch (err) {
      btn.removeAttribute('aria-busy');
      btn.disabled = false;
      toast.error(err instanceof ApiError ? err.message : 'Activation failed.');
    }
  });

  await check();
}
