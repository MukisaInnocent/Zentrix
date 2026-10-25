import { api, ApiError } from '../core/api.js';
import { askForm } from '../core/dialogs.js';
import { $, h } from '../core/dom.js';
import { formatDate } from '../core/format.js';
import { toast } from '../core/toast.js';

// Password, email and phone change only after an admin unlocks that one change (it then stays open for 24 hours
// and works once). The page shows each as locked or unlocked and opens the matching form.
const KINDS = {
  password: {
    label: 'Password', current: () => '••••••••••',
    title: 'Change password', submit: 'Change password',
    fields: [
      { name: 'currentPassword', label: 'Current password', type: 'password', required: true },
      { name: 'newPassword', label: 'New password', type: 'password', required: true, minLength: 10 },
      { name: 'confirmPassword', label: 'Repeat new password', type: 'password', required: true, minLength: 10 },
    ],
    send: v => {
      if (v.newPassword !== v.confirmPassword) throw new ApiError(400, 'validation_failed', 'The two new passwords do not match.', { confirmPassword: ['The two new passwords do not match.'] });
      return api.post('/api/auth/password/change', { currentPassword: v.currentPassword, newPassword: v.newPassword });
    },
    done: 'Password changed. Other devices were signed out.',
  },
  email: {
    label: 'Email', current: me => me.email ?? '',
    title: 'Change email', submit: 'Change email',
    fields: [
      { name: 'newEmail', label: 'New email address', type: 'email', required: true },
      { name: 'password', label: 'Your password', type: 'password', required: true },
    ],
    send: v => api.post('/api/me/email', v),
    done: 'Email changed.',
  },
  phone: {
    label: 'Phone', current: me => me.phone ?? '',
    title: 'Change phone', submit: 'Change phone',
    fields: [
      { name: 'newPhone', label: 'New number, starting with the country code', type: 'tel', required: true },
      { name: 'password', label: 'Your password', type: 'password', required: true },
    ],
    send: v => api.post('/api/me/phone', v),
    done: 'Phone changed. Withdrawals are locked for 48 hours.',
  },
};

async function render(me, list) {
  const { unlocked } = await api.get('/api/me/changes');
  list.replaceChildren(...Object.entries(KINDS).map(([kind, k]) => {
    const open = unlocked[kind];
    const action = open
      ? h('button', { type: 'button', class: 'zx-btn zx-btn--sm' }, 'Change')
      : h('span', { class: 'zx-badge' }, 'Locked');
    if (open) {
      action.addEventListener('click', async () => {
        const done = await askForm({
          title: k.title, submitLabel: k.submit,
          text: `Unlocked until ${formatDate(open, { withTime: true })}.`,
          fields: k.fields,
          submit: v => k.send(v),
        });
        if (done) {
          toast.success(k.done);
          if (kind !== 'password') setTimeout(() => location.reload(), 800);
          else await render(me, list);
        }
      });
    }
    return h('li', {}, h('span', { class: 'zx-rows__label' }, h('strong', {}, k.label), h('div', { class: 'zx-hint' }, k.current(me))), action);
  }));
}

export async function init({ me }) {
  $('#prof-username').textContent = `@${me.username}`;
  $('#prof-country').textContent = `${me.country.name} (${me.currency})`;
  $('#prof-upline').textContent = me.referrer ? `@${me.referrer.username}` : 'None';
  $('#prof-status').textContent = me.activated ? 'Active' : 'Waiting for activation';
  await render(me, $('#security-list'));
}
