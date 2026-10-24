import { api, ApiError } from '../core/api.js';
import { $ } from '../core/dom.js';

export function init() {
  const form = $('#login-form');
  const alert = $('#login-alert');
  const submitBtn = $('#login-submit');

  function clearErrors() {
    if (alert) {
      alert.innerHTML = '';
      alert.style.display = 'none';
    }
    form?.querySelectorAll('.zx-input').forEach(input => {
      input.style.borderColor = '';
      input.removeAttribute('aria-invalid');
    });
  }

  form?.querySelectorAll('input').forEach(input => {
    input.addEventListener('input', () => {
      input.style.borderColor = '';
      input.removeAttribute('aria-invalid');
    });
  });

  // Test shortcuts fill the username only; passwords never live in page code.
  $('#fill-test-member')?.addEventListener('click', () => {
    const idInput = $('#identifier');
    const pwdInput = $('#password');
    if (idInput && pwdInput) {
      idInput.value = 'test_member_01';
      pwdInput.focus();
      clearErrors();
    }
  });

  $('#fill-test-admin')?.addEventListener('click', () => {
    const idInput = $('#identifier');
    const pwdInput = $('#password');
    if (idInput && pwdInput) {
      idInput.value = 'zx_admin';
      pwdInput.focus();
      clearErrors();
    }
  });

  let challengeToken = null;
  function showCodeStep(emailSent) {
    for (const id of ['identifier', 'password']) {
      const field = $(`#${id}`)?.closest('.zx-field');
      if (field) field.hidden = true;
      $(`#${id}`)?.removeAttribute('required');
    }
    const field = document.createElement('div');
    field.className = 'zx-field';
    const label = document.createElement('label');
    label.htmlFor = 'login-code';
    label.textContent = 'Sign-in code';
    const input = document.createElement('input');
    Object.assign(input, { id: 'login-code', name: 'code', className: 'zx-input zx-code-input', inputMode: 'numeric', autocomplete: 'one-time-code', required: true, maxLength: 12 });
    const hint = document.createElement('span');
    hint.className = 'zx-hint';
    hint.textContent = emailSent
      ? 'We emailed a 6-digit code to your account email. It expires in 5 minutes. A code from your authenticator app also works.'
      : 'Enter the 6-digit code from your authenticator app. In test mode you can run: npm run totp -- <username>';
    field.append(label, input, hint);
    submitBtn.before(field);
    submitBtn.textContent = 'Confirm code';
    input.focus();
  }

  form?.addEventListener('submit', async e => {
    e.preventDefault();
    clearErrors();
    submitBtn.setAttribute('aria-busy', 'true');
    submitBtn.disabled = true;

    const data = new FormData(form);
    const identifier = String(data.get('identifier') || '').trim();
    const password = String(data.get('password') || '');

    try {
      if (challengeToken) {
        await api.post('/api/auth/login/mfa', { challengeToken, code: String(data.get('code') || '').trim() });
      } else {
        const res = await api.post('/api/auth/login', { identifier, password });
        // Staff accounts need a second step: the 6-digit code from the authenticator app.
        if (res?.mfaRequired) {
          challengeToken = res.challengeToken;
          showCodeStep(res.emailSent);
          submitBtn.removeAttribute('aria-busy');
          submitBtn.disabled = false;
          return;
        }
      }
      const next = new URLSearchParams(location.search).get('next') || (challengeToken ? '/admin/index.html' : '/dashboard.html');
      location.assign(next);
    } catch (err) {
      if (challengeToken && err instanceof ApiError && err.code === 'auth.mfa_expired') {
        challengeToken = null;
        location.reload();
        return;
      }
      submitBtn.removeAttribute('aria-busy');
      submitBtn.disabled = false;

      if (!alert) return;
      alert.style.display = 'block';

      form?.querySelectorAll('.zx-input').forEach(input => {
        input.style.borderColor = 'var(--zx-danger)';
        input.setAttribute('aria-invalid', 'true');
      });

      let message = 'Invalid username, email, phone number, or password.';
      if (err instanceof ApiError) {
        if (err.code === 'auth.invalid_credentials') {
          message = 'Invalid sign-in details. If you just registered, please verify that your registration was submitted, or check your password.';
        } else if (err.code === 'rate_limited' || err.status === 429) {
          message = 'Too many attempts. Your account or IP is temporarily restricted. Please wait a few minutes before trying again.';
        } else if (err.message) {
          message = err.message;
        }
      } else {
        message = 'Connection error. Please check your network and try again.';
      }

      alert.innerHTML = `
        <div class="zx-alert zx-alert--danger">
          <div class="zx-alert__body">
            ${message}
          </div>
        </div>
      `;
    }
  });
}

