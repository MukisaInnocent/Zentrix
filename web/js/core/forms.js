import { ApiError } from './api.js';
import { t } from './i18n.js';
import { setBusy } from './dom.js';
import { toast } from './toast.js';

export function serialize(form) {
  const data = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled || el.type === 'submit' || el.type === 'button') continue;
    if (el.type === 'checkbox') data[el.name] = el.checked;
    else if (el.type === 'radio') {
      if (el.checked) data[el.name] = el.value;
    } else data[el.name] = el.value.trim() === '' && el.dataset.optional !== undefined ? undefined : el.value;
  }
  return data;
}

export function clearErrors(form) {
  for (const el of form.querySelectorAll('[aria-invalid="true"]')) el.removeAttribute('aria-invalid');
  for (const el of form.querySelectorAll('.zx-error')) {
    el.textContent = '';
    el.hidden = true;
  }
}

// Places server field errors next to the matching inputs (by name) and focuses the first one.
export function showErrors(form, fields = {}) {
  let first = null;
  for (const [name, messages] of Object.entries(fields)) {
    const input = form.elements.namedItem(name);
    const field = input instanceof Element ? input : null;
    const target = field ? form.querySelector(`#${CSS.escape(field.id)}-error`) : form.querySelector('[data-form-error]');
    if (field) {
      field.setAttribute('aria-invalid', 'true');
      first ??= field;
    }
    if (target) {
      target.textContent = Array.isArray(messages) ? messages[0] : String(messages);
      target.hidden = false;
    }
  }
  first?.focus();
}

// Submit handling with loading state, field errors and toasts. onSubmit gets the serialized data.
export function bindForm(form, onSubmit) {
  form.addEventListener('submit', async event => {
    event.preventDefault();
    clearErrors(form);
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }
    const button = event.submitter ?? form.querySelector('[type="submit"]');
    setBusy(button, true);
    try {
      await onSubmit(serialize(form), form);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.fields) showErrors(form, err.fields);
        toast.error(err.message);
      } else {
        toast.error(t('errors.unexpected', {}, 'Something went wrong. Please try again.'));
        console.error(err);
      }
    } finally {
      setBusy(button, false);
    }
  });
}

// Show/hide password toggles: <button data-toggle-password="input-id">.
export function bindPasswordToggles(root = document) {
  for (const btn of root.querySelectorAll('[data-toggle-password]')) {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.togglePassword);
      if (!input) return;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.setAttribute('aria-pressed', String(show));
      btn.querySelector('use')?.setAttribute('href', `/img/icons.svg#${show ? 'eye-off' : 'eye'}`);
    });
  }
}
