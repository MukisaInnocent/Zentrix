import { api } from '../core/api.js';
import { $ } from '../core/dom.js';
import { bindForm, showErrors } from '../core/forms.js';
import { t } from '../core/i18n.js';

// Sets a new password from the emailed link (/reset-password.html#token=...). The token sits in the URL
// fragment, so it never reaches server logs; it is read once and removed from the address bar.
export function init() {
  const token = new URLSearchParams(location.hash.slice(1)).get('token');
  history.replaceState(null, '', location.pathname);
  const form = $('#reset-form');
  if (!token) {
    form.hidden = true;
    $('#reset-missing').hidden = false;
    return;
  }
  bindForm(form, async data => {
    if (data.password !== data.confirm) {
      showErrors(form, { confirm: [t('reset.mismatch', {}, 'The two passwords do not match.')] });
      return;
    }
    await api.post('/api/auth/password/reset', { token, password: data.password }, { noRedirect: true });
    form.hidden = true;
    $('#reset-done').hidden = false;
  });
}
