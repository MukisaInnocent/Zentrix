import { ApiError, api } from '../core/api.js';
import { $, h, on } from '../core/dom.js';
import { clearErrors, showErrors } from '../core/forms.js';
import { toast } from '../core/toast.js';
import { act, askForm, debounce, emptyRow, when } from '../admin/kit.js';
import { mailPreview } from './admin-announcements.js';

// The wording of the automatic emails. The server checks every change (only known fill-ins, required ones kept)
// and fills in sample values for the preview.
let templates = [];
let current = null;
let isAdmin = false;
let me = null;

const form = () => $('#template-form');

function content() {
  const f = form().elements;
  const v = name => f.namedItem(name).value.trim();
  return { subject: v('subject'), heading: v('heading'), body: v('body'), ...(current?.button && v('buttonLabel') ? { buttonLabel: v('buttonLabel') } : {}) };
}

async function refreshPreview() {
  if (!current) return;
  clearErrors(form());
  try {
    const { preview } = await api.post(`/api/admin/email-templates/${current.kind}/preview`, { content: content() });
    $('#t-preview').replaceChildren(mailPreview(preview));
  } catch (err) {
    if (err instanceof ApiError && err.fields) showErrors(form(), err.fields);
    else if (err instanceof ApiError) $('#t-preview').replaceChildren(h('p', { class: 'zx-error' }, err.message));
  }
}

function insertAtCursor(text) {
  const active = document.activeElement;
  const target = active && form().contains(active) && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT') ? active : form().elements.namedItem('body');
  const start = target.selectionStart ?? target.value.length;
  const end = target.selectionEnd ?? start;
  target.setRangeText(text, start, end, 'end');
  target.focus();
  void refreshPreview();
}

async function loadHistory() {
  const { history } = await api.get(`/api/admin/email-templates/${current.kind}/history`);
  $('#history').replaceChildren(...(history.length ? history.map(v => h('li', {},
    h('div', { class: 'zx-td-strong' }, `Version ${v.version}${v.content ? '' : ' (back to the original)'}`),
    h('div', { class: 'zx-hint' }, `${when(v.created_at)} by @${v.username}: ${v.note}`))) : [h('li', { class: 'zx-hint' }, 'Never changed: this is the original wording.')]));
}

function open(kind) {
  current = templates.find(t => t.kind === kind);
  if (!current) return;
  $('#editor').hidden = false;
  $('#editor-title').textContent = current.title;
  $('#editor-when').textContent = `${current.when}${current.note ? ` Fixed note under the button: "${current.note}"` : ''}`;
  const f = form().elements;
  for (const name of ['subject', 'heading', 'body', 'buttonLabel']) f.namedItem(name).value = current.content[name] ?? '';
  $('#button-field').hidden = !current.button;
  $('#fill-ins').replaceChildren(...current.fillIns.map(x => h('button', {
    type: 'button', class: 'zx-btn zx-btn--secondary zx-btn--sm', title: `${x.about}${current.required.includes(x.name) ? ' (must stay in the email)' : ''}. Example: ${x.sample}`, dataset: { fill: x.name },
  }, `{${x.name}}${current.required.includes(x.name) ? ' *' : ''}`)));
  for (const el of form().querySelectorAll('input, textarea, button')) el.disabled = !isAdmin;
  $('#t-restore').hidden = !current.custom;
  void refreshPreview();
  void act(loadHistory);
  $('#editor').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function load() {
  ({ templates } = await api.get('/api/admin/email-templates'));
  let group = null;
  const out = [];
  for (const t of templates) {
    if (t.group !== group) {
      group = t.group;
      out.push(h('tr', {}, h('th', { colspan: '3', scope: 'colgroup' }, group)));
    }
    out.push(h('tr', {},
      h('td', {}, h('div', { class: 'zx-td-strong' }, t.title), h('div', { class: 'zx-hint' }, t.when)),
      h('td', {}, t.custom ? h('span', { class: 'zx-badge zx-badge--brand' }, 'Changed') : h('span', { class: 'zx-badge' }, 'Original'),
        t.updatedAt ? h('div', { class: 'zx-hint' }, `${when(t.updatedAt)} by @${t.updatedBy}`) : null),
      h('td', {}, h('button', { type: 'button', class: 'zx-btn zx-btn--secondary zx-btn--sm', dataset: { open: t.kind } }, isAdmin ? 'Edit' : 'View'))));
  }
  $('#rows').replaceChildren(...(out.length ? out : [emptyRow(3, 'No emails.')]));
}

async function save(e) {
  e.preventDefault();
  clearErrors(form());
  const saved = await askForm({
    title: `Save "${current.title}"?`, text: 'Members get the new wording from the next email of this kind.', submitLabel: 'Save',
    fields: [{ name: 'note', label: 'What changed and why?', required: true, minLength: 3, maxLength: 300 }],
    submit: v => api.put(`/api/admin/email-templates/${current.kind}`, { content: content(), note: v.note }),
  });
  if (!saved) return;
  toast.success(`Saved as version ${saved.version}.`);
  const kind = current.kind;
  await act(load);
  open(kind);
}

export async function init(ctx) {
  me = ctx.me;
  isAdmin = me.roles.includes('admin');
  on($('#rows'), 'click', 'button[data-open]', (_e, button) => open(button.dataset.open));
  on($('#fill-ins'), 'mousedown', 'button[data-fill]', e => e.preventDefault()); // keep the cursor where it was
  on($('#fill-ins'), 'click', 'button[data-fill]', (_e, button) => insertAtCursor(`{${button.dataset.fill}}`));
  form().addEventListener('input', debounce(() => void refreshPreview(), 400));
  form().addEventListener('submit', e => void save(e).catch(err => toast.error(err instanceof ApiError ? err.message : 'Something went wrong.')));
  $('#t-restore').addEventListener('click', async () => {
    const done = await askForm({
      title: 'Restore the original wording?', text: `"${current.title}" goes back to the site's original words. Your version stays in the history.`, submitLabel: 'Restore',
      fields: [{ name: 'note', label: 'Why?', required: true, minLength: 3, maxLength: 300 }],
      submit: v => api.post(`/api/admin/email-templates/${current.kind}/restore`, { note: v.note }),
    });
    if (!done) return;
    toast.success('Original wording restored.');
    const kind = current.kind;
    await act(load);
    open(kind);
  });
  $('#t-test').addEventListener('click', async () => {
    const result = await askForm({
      title: 'Send me a test', text: 'Sends the wording in the form (saved or not) with sample values. The subject starts with [Test].', submitLabel: 'Send test',
      fields: [{ name: 'to', label: 'Send to', type: 'email', required: true, value: me?.email ?? '' }],
      submit: v => api.post(`/api/admin/email-templates/${current.kind}/test`, { content: content(), to: v.to }),
    });
    if (result) toast.success(result.outcome === 'sent' || result.outcome === 'queued' ? 'Test sent. Check the inbox (and spam).' : `Not sent: ${result.outcome}.`);
  });
  await act(load);
}
