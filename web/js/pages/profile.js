import { api, ApiError } from '../core/api.js';
import { $ } from '../core/dom.js';
import { toast } from '../core/toast.js';

export async function init({ me }) {
  if (me) {
    if ($('#prof-username')) $('#prof-username').value = `@${me.username}`;
    if ($('#prof-email')) $('#prof-email').value = me.email || '—';
    if ($('#prof-phone')) $('#prof-phone').value = me.phone || '—';
    if ($('#prof-ref-code')) $('#prof-ref-code').value = me.referralCode || '—';
  }

  const form = $('#pw-form');
  const alert = $('#pw-alert');
  const submitBtn = $('#pw-submit');

  form?.addEventListener('submit', async e => {
    e.preventDefault();
    alert.textContent = '';

    const data = new FormData(form);
    const currentPassword = String(data.get('currentPassword') || '');
    const newPassword = String(data.get('newPassword') || '');
    const confirmPassword = String(data.get('confirmPassword') || '');

    if (newPassword !== confirmPassword) {
      alert.textContent = 'The two new passwords do not match.';
      return;
    }

    submitBtn.setAttribute('aria-busy', 'true');
    submitBtn.disabled = true;

    try {
      await api.post('/api/auth/password/change', { currentPassword, newPassword });
      toast.success('Password changed successfully! Other devices signed out.');
      submitBtn.removeAttribute('aria-busy');
      submitBtn.disabled = false;
      form.reset();
    } catch (err) {
      submitBtn.removeAttribute('aria-busy');
      submitBtn.disabled = false;
      if (err instanceof ApiError) {
        alert.textContent = err.message || 'Failed to update password.';
      } else {
        alert.textContent = 'Connection error. Please try again.';
      }
    }
  });
}
