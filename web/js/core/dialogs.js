import { ApiError } from './api.js';
import { $, h, setBusy } from './dom.js';
import { clearErrors, showErrors } from './forms.js';
import { toast } from './toast.js';

// A small form in a modal dialog, optionally after `before` content. fields: [{ name, label, type, value, required, hint, options, minLength }].
// Resolves with the submitted values, or null when cancelled. `submit` may throw an ApiError to keep the
// dialog open with field errors shown.
export function askForm({ title, text, before, fields = [], submitLabel = 'Confirm', tone = '', submit }) {
  return new Promise(resolve => {
    let done = false;
    const form = h('form', { class: 'zx-form', novalidate: false });
    if (before) form.append(before);
    if (text) form.append(h('p', { class: 'zx-hint' }, text));
    form.append(h('div', { class: 'zx-error', 'data-form-error': '', hidden: true, role: 'alert' }));
    for (const f of fields) {
      const id = `ask-${f.name}`;
      let input;
      if (f.type === 'textarea') input = h('textarea', { id, name: f.name, class: 'zx-textarea', required: f.required, minlength: f.minLength, maxlength: f.maxLength ?? 500 });
      else if (f.type === 'select') input = h('select', { id, name: f.name, class: 'zx-select', required: f.required }, f.options.map(o => h('option', { value: o.value }, o.label)));
      else input = h('input', { id, name: f.name, class: 'zx-input', type: f.type ?? 'text', required: f.required, inputmode: f.inputmode, autocomplete: 'off', minlength: f.minLength, maxlength: f.maxLength });
      if (f.value !== undefined && f.value !== null) input.value = f.value;
      form.append(h('div', { class: 'zx-field' },
        h('label', { for: id }, f.label), input,
        f.hint ? h('span', { class: 'zx-hint' }, f.hint) : null,
        h('span', { class: 'zx-error', id: `${id}-error`, hidden: true })));
    }
    const cancel = h('button', { type: 'button', class: 'zx-btn zx-btn--secondary' }, 'Cancel');
    const ok = h('button', { type: 'submit', class: `zx-btn${tone ? ` zx-btn--${tone}` : ''}` }, submitLabel);
    form.append(h('div', { class: 'zx-dialog__actions' }, cancel, ok));
    const dialog = h('dialog', { class: 'zx-dialog', 'aria-label': title }, h('div', { class: 'zx-dialog__body' }, h('h2', {}, title), form));
    const finish = value => {
      done = true;
      resolve(value);
      dialog.close();
    };
    cancel.addEventListener('click', () => finish(null));
    dialog.addEventListener('close', () => {
      dialog.remove();
      if (!done) resolve(null);
    });
    form.addEventListener('submit', async e => {
      e.preventDefault();
      clearErrors(form);
      if (!form.checkValidity()) return form.reportValidity();
      const values = Object.fromEntries(fields.map(f => [f.name, form.elements.namedItem(f.name).value.trim()]));
      if (!submit) return finish(values);
      setBusy(ok, true);
      try {
        finish(await submit(values));
      } catch (err) {
        if (err instanceof ApiError) {
          if (err.fields) showErrors(form, err.fields);
          const slot = $('[data-form-error]', form);
          slot.textContent = err.message;
          slot.hidden = false;
        } else {
          toast.error('Something went wrong. Please try again.');
          console.error(err);
        }
      } finally {
        setBusy(ok, false);
      }
    });
    document.body.append(dialog);
    dialog.showModal();
    form.querySelector('input, textarea, select')?.focus();
  });
}

