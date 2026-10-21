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

  $('#fill-test-member')?.addEventListener('click', () => {
    const idInput = $('#identifier');
    const pwdInput = $('#password');
    if (idInput && pwdInput) {
      idInput.value = 'test_member_01';
      pwdInput.value = 'Member-kcyDG72VN_Nt';
      clearErrors();
    }
  });

  $('#fill-test-admin')?.addEventListener('click', () => {
    const idInput = $('#identifier');
    const pwdInput = $('#password');
    if (idInput && pwdInput) {
      idInput.value = 'zx_admin';
      pwdInput.value = 'Staff-Jcba_P99ZOe2';
      clearErrors();
    }
  });

  form?.addEventListener('submit', async e => {
    e.preventDefault();
    clearErrors();
    submitBtn.setAttribute('aria-busy', 'true');
    submitBtn.disabled = true;

    const data = new FormData(form);
    const identifier = String(data.get('identifier') || '').trim();
    const password = String(data.get('password') || '');

    try {
      await api.post('/api/auth/login', { identifier, password });
      const next = new URLSearchParams(location.search).get('next') || '/dashboard.html';
      location.assign(next);
    } catch (err) {
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

