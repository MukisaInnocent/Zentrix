import { api, ApiError } from '../core/api.js';
import { $, h } from '../core/dom.js';
import { formatMoney, loadCurrencies } from '../core/format.js';
import { bindPasswordToggles } from '../core/forms.js';

// Picks the visitor's country (from the network when known, else the browser time zone, else the browser
// language), shows its country code in front of the mobile number, and shows its currency and activation fee.
// Choosing a country code picks its country, and choosing a country picks its code (owner, 2026-11-06).
let countries = [];
let dial = '';

// The number goes to the server with its country code: typed with a leading + it is sent as typed, otherwise the
// country code is put in front (a leading 0 of the local form is dropped).
function fullPhone(typed) {
  const compact = typed.replace(/[\s()-]/g, '');
  if (compact === '' || compact.startsWith('+')) return compact;
  if (compact.startsWith('00')) return `+${compact.slice(2)}`;
  const local = compact.replace(/^0+/, '');
  return local.startsWith(dial.slice(1)) && local.length > 10 ? `+${local}` : `${dial}${local}`;
}

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

// The country code picker (owner, 2026-11-06): each country's flag, full name and code. Choosing one also picks the
// country below. Flags are local images (web/img/flags, flag-icons, MIT).
const flagSrc = code => `/img/flags/${code.toLowerCase()}.svg`;

function showDial(country) {
  const flag = $('#dial-flag');
  flag.hidden = !country;
  if (country) flag.src = flagSrc(country.code);
  $('#dial-code').textContent = country ? `+${country.dialCode}` : '+';
  $('#phone-dial').setAttribute('aria-label', country ? `Country code: ${country.name} +${country.dialCode}` : 'Country code');
}

function bindDialPicker(onPick) {
  const btn = $('#phone-dial');
  const panel = $('#dial-panel');
  const search = $('#dial-search');
  const list = $('#dial-list');
  const items = countries.map(c => {
    const item = h('button', { type: 'button', class: 'zx-dialpick__item', dataset: { code: c.code } },
      h('img', { class: 'zx-flag', src: flagSrc(c.code), alt: '', width: '24', height: '18', loading: 'lazy' }),
      h('span', { class: 'zx-dialpick__name' }, c.name),
      h('span', { class: 'zx-dialpick__code' }, `+${c.dialCode}`));
    return { c, li: h('li', {}, item), text: `${c.name} +${c.dialCode} ${c.code}`.toLowerCase() };
  });
  list.replaceChildren(...items.map(i => i.li));

  const close = (focusBtn = false) => {
    panel.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    if (focusBtn) btn.focus();
  };
  const open = () => {
    panel.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    search.value = '';
    for (const i of items) i.li.hidden = false;
    search.focus();
    list.querySelector(`[data-code="${$('#country').value}"]`)?.scrollIntoView({ block: 'center' });
  };
  btn.addEventListener('click', () => (panel.hidden ? open() : close()));
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    for (const i of items) i.li.hidden = q !== '' && !i.text.includes(q);
  });
  list.addEventListener('click', e => {
    const item = e.target instanceof Element ? e.target.closest('[data-code]') : null;
    if (!item) return;
    onPick(item.dataset.code);
    close(true);
  });
  panel.addEventListener('keydown', e => {
    if (e.key === 'Escape') close(true);
  });
  document.addEventListener('click', e => {
    if (!panel.hidden && e.target instanceof Node && !panel.contains(e.target) && !btn.contains(e.target)) close();
  });
}

async function applyCountry(code) {
  const country = countries.find(c => c.code === code);
  const hint = $('#country-hint');
  if (!country) {
    hint.textContent = '';
    showDial(null);
    return;
  }
  dial = `+${country.dialCode}`;
  showDial(country);
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
  bindDialPicker(code => {
    select.value = code;
    void applyCountry(code);
  });
  select.addEventListener('change', () => void applyCountry(select.value));
  await applyCountry(select.value);
}

export async function init() {
  const form = $('#register-form');
  const alert = $('#register-alert');
  const submitBtn = $('#register-submit');
  const referralInput = $('#referralCode');
  bindPasswordToggles(form);

  // An invite link carries the username of the member who invited you: ?ref=username
  const params = new URLSearchParams(location.search);
  const ref = (params.get('ref') || params.get('referral') || '').trim().replace(/^@/, '').toLowerCase();
  if (ref) {
    referralInput.value = ref;
    $('#invited-by-name').textContent = ref;
    $('#invited-by').hidden = false;
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
    const data = new FormData(form);
    if (data.get('password') !== data.get('confirmPassword')) {
      const confirm = $('#confirmPassword');
      confirm.style.borderColor = 'var(--zx-danger)';
      confirm.setAttribute('aria-invalid', 'true');
      alert.style.display = 'block';
      alert.replaceChildren(h('div', { class: 'zx-alert zx-alert--danger' }, h('div', { class: 'zx-alert__body' }, 'The two passwords do not match.')));
      confirm.focus();
      return;
    }
    submitBtn.setAttribute('aria-busy', 'true');
    submitBtn.disabled = true;

    const country = String(data.get('country') || 'UG');
    const phone = fullPhone(String(data.get('phone') || ''));
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

      location.assign('/activate');
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
          displayMessage = 'An account already exists with that email or phone number. <a href="/login">Sign in here</a>.';
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

