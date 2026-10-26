import { api } from '../core/api.js';
import { $ } from '../core/dom.js';
import { bindForm } from '../core/forms.js';

// Asks for a reset link. The server answers the same whether or not the email has an account, so the page
// always shows the same message.
export function init() {
  const form = $('#forgot-form');
  bindForm(form, async data => {
    await api.post('/api/auth/password/forgot', { email: String(data.email ?? '').trim() }, { noRedirect: true });
    form.hidden = true;
    $('#forgot-sent').hidden = false;
  });
}
