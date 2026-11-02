import { api } from '../core/api.js';
import { $ } from '../core/dom.js';
import { bindForm, showErrors } from '../core/forms.js';
import { t } from '../core/i18n.js';

// Asks for a reset code and link. The server answers the same whether or not the email has an account, so the page
// always shows the same message, then takes the 6-digit code with the new password (owner, 2026-11-02).
export function init() {
  const form = $('#forgot-form');
  const codeForm = $('#code-form');
  let email = '';
  bindForm(form, async data => {
    email = String(data.email ?? '').trim();
    await api.post('/api/auth/password/forgot', { email }, { noRedirect: true });
    form.hidden = true;
    $('#forgot-sent').hidden = false;
    codeForm.hidden = false;
    $('#code-code').focus();
  });
  bindForm(codeForm, async data => {
    if (data.password !== data.confirm) {
      showErrors(codeForm, { confirm: [t('reset.mismatch', {}, 'The two passwords do not match.')] });
      return;
    }
    await api.post('/api/auth/password/reset', { email, code: String(data.code ?? '').trim(), password: data.password }, { noRedirect: true });
    codeForm.hidden = true;
    $('#forgot-sent').hidden = true;
    $('#code-done').hidden = false;
  });
}
