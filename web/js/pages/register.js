import { api, ApiError } from '../core/api.js';
import { $, h } from '../core/dom.js';
import { formatMoney, loadCurrencies } from '../core/format.js';

// Picks the visitor's country (from the network when known, else the browser time zone, else the browser
// language), fills the phone prefix with its country code, and shows its currency and activation fee.
let countries = [];
let lastDial = '';

function guessFromLanguage() {
  const region = (navigator.language || '').split('-')[1]?.toUpperCase();
  return region && countries.some(c => c.code === region) ? region : null;
}

async function detectCountry() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  try {
    const found = await api.get(`/api/reference/detect?tz=${encodeURIComponent(tz)}`, { noRedirect: true });
    if (found.country) return found.country;
  } catch {
    // Fall through to the browser language.
  }
  return guessFromLanguage();
}

async function applyCountry(code) {
  const country = countries.find(c => c.code === code);
  const phone = $('#phone');
  const hint = $('#country-hint');
  if (!country) {
    hint.textContent = '';
    return;
  }
  // Keep the country code at the start of the number, replacing the previous country's code.
  const dial = `+${country.dialCode}`;
  const typed = phone.value.trim();
  if (typed === '' || typed === lastDial) phone.value = dial;
  lastDial = dial;
  phone.placeholder = `${dial}...`;
  try {
    await loadCurrencies();
    const { config } = await api.get(`/api/reference/config/${country.code}`, { noRedirect: true });
    hint.textContent = `Currency ${country.currency}. Activation fee ${formatMoney(config.activationFee)}.`;
  } catch {
    hint.textContent = `Currency ${country.currency}. The activation fee for your country is not set yet.`;
  }
}

async function loadCountries() {
  const select = $('#country');
  ({ countries } = await api.get('/api/reference/countries'));
  select.replaceChildren(h('option', { value: '' }, 'Choose your country'), ...countries.map(c => h('option', { value: c.code }, `${c.name} (${c.currency})`)));
  const wanted = new URLSearchParams(location.search).get('country')?.toUpperCase() ?? (await detectCountry());
  if (wanted && countries.some(c => c.code === wanted)) select.value = wanted;
  select.addEventListener('change', () => void applyCountry(select.value));
  await applyCountry(select.value);
}

export async function init() {
  const form = $('#register-form');
  const alert = $('#register-alert');
  const submitBtn = $('#register-submit');
  const referralInput = $('#referralCode');

  // An invite link carries the username of the member who invited you: ?ref=username
  const params = new URLSearchParams(location.search);
  const ref = params.get('ref') || params.get('referral');
  if (ref && referralInput) {
    referralInput.value = ref.trim().replace(/^@/, '').toLowerCase();
  }
  await loadCountries().catch(() => {
    $('#country').replaceChildren(h('option', { value: '' }, 'Could not load countries. Reload the page.'));
  });

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
    const referralCode = String(data.get('referralCode') || '').trim().replace(/^@/, '').toLowerCase() || undefined;

    try {
      await api.post('/api/auth/register', {
        country,
        phone,
        username,
        email,
        password,
        referralCode,
        acceptTerms: true,
        acceptPrivacy: true,
      });

      location.assign('/activate.html');
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
            const fieldLabel = field === 'referralCode' ? 'Invited by' : field.charAt(0).toUpperCase() + field.slice(1);
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

