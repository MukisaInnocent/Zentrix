import { api, ApiError } from '../core/api.js';
import { $ } from '../core/dom.js';

export function init() {
  const form = $('#register-form');
  const alert = $('#register-alert');
  const submitBtn = $('#register-submit');
  const referralInput = $('#referralCode');

  // Auto-fill referral code from query string: ?ref=CODE
  const params = new URLSearchParams(location.search);
  const ref = params.get('ref') || params.get('referral');
  if (ref && referralInput) {
    referralInput.value = ref.trim().toUpperCase();
  }

  function clearErrors() {
    if (alert) {
      alert.innerHTML = '';
      alert.style.display = 'none';
    }
    form?.querySelectorAll('.zx-input, .zx-select').forEach(input => {
      input.style.borderColor = '';
      input.removeAttribute('aria-invalid');
    });
  }

  // Clear errors when the user edits any input
  form?.querySelectorAll('input, select').forEach(input => {
    input.addEventListener('input', () => {
      input.style.borderColor = '';
      input.removeAttribute('aria-invalid');
    });
  });

  form?.addEventListener('submit', async e => {
    e.preventDefault();
    clearErrors();
    submitBtn.setAttribute('aria-busy', 'true');
    submitBtn.disabled = true;

    const data = new FormData(form);
    const country = String(data.get('country') || 'UG');
    const phone = String(data.get('phone') || '').trim();
    const username = String(data.get('username') || '').trim().toLowerCase();
    const email = String(data.get('email') || '').trim().toLowerCase();
    const password = String(data.get('password') || '');
    const dateOfBirth = String(data.get('dateOfBirth') || '');
    const referralCode = String(data.get('referralCode') || '').trim().toUpperCase() || undefined;

    try {
      await api.post('/api/auth/register', {
        country,
        phone,
        username,
        email,
        password,
        dateOfBirth,
        referralCode,
        acceptTerms: true,
        acceptPrivacy: true,
      });

      location.assign('/dashboard.html');
    } catch (err) {
      submitBtn.removeAttribute('aria-busy');
      submitBtn.disabled = false;

      if (!alert) return;
      alert.style.display = 'block';

      if (err instanceof ApiError) {
        const errorMessages = [];

        // Check if there are specific field validation errors
        if (err.fields && typeof err.fields === 'object') {
          for (const [field, msgs] of Object.entries(err.fields)) {
            const inputEl = form?.querySelector(`[name="${field}"]`);
            if (inputEl) {
              inputEl.style.borderColor = 'var(--zx-danger)';
              inputEl.setAttribute('aria-invalid', 'true');
            }
            const fieldLabel = field === 'dateOfBirth' ? 'Date of birth' : field.charAt(0).toUpperCase() + field.slice(1);
            const msgList = Array.isArray(msgs) ? msgs.join(', ') : String(msgs);
            errorMessages.push(`<strong>${fieldLabel}:</strong> ${msgList}`);
          }
        }

        if (errorMessages.length > 0) {
          alert.innerHTML = `
            <div class="zx-alert zx-alert--danger">
              <div class="zx-alert__body">
                <div class="zx-alert__title">Please fix the following:</div>
                <ul class="zx-alert__list">
                  ${errorMessages.map(m => `<li>${m}</li>`).join('')}
                </ul>
              </div>
            </div>
          `;
          // Scroll first invalid input into view
          form?.querySelector('[aria-invalid="true"]')?.focus();
          return;
        }

        // Generic error messages
        let displayMessage = err.message || 'Registration could not be completed.';
        if (err.code === 'auth.username_taken') {
          displayMessage = 'That username is already taken. Please choose a different username.';
          const uInput = form?.querySelector('[name="username"]');
          if (uInput) {
            uInput.style.borderColor = 'var(--zx-danger)';
            uInput.setAttribute('aria-invalid', 'true');
            uInput.focus();
          }
        } else if (err.code === 'auth.registration_conflict') {
          displayMessage = 'An account already exists with that email or phone number. <a href="/login.html">Sign in here</a>.';
        }

        alert.innerHTML = `
          <div class="zx-alert zx-alert--danger">
            <div class="zx-alert__body">
              ${displayMessage}
            </div>
          </div>
        `;
      } else {
        alert.innerHTML = `
          <div class="zx-alert zx-alert--danger">
            <div class="zx-alert__body">
              Connection error. Please check your network and try again.
            </div>
          </div>
        `;
      }
    }
  });
}

