import { api } from '../core/api.js';
import { $, h } from '../core/dom.js';
import { act, askForm, emptyRow } from '../admin/kit.js';
import { toast } from '../core/toast.js';

// E-books (owner, 2026-11-01): add, edit, hide, remove and restore the books on the member E-books page. Every change
// is audited by the server. Support staff can see the list; only admins change it.
const state = { removed: false };

const yesNo = on => h('span', { class: `zx-badge ${on ? 'zx-badge--success' : ''}` }, on ? 'Yes' : 'Hidden');

function bookFields(b = {}) {
  return [
    { name: 'section', label: 'Section', required: true, minLength: 2, maxLength: 60, value: b.section, hint: 'Books with the same section show together, for example Entrepreneurship, Marketing or Personal Finance.' },
    { name: 'title', label: 'Title', required: true, minLength: 2, maxLength: 120, value: b.title },
    { name: 'description', label: 'Short description', type: 'textarea', required: true, minLength: 2, maxLength: 600, value: b.description },
    { name: 'linkUrl', label: 'Link to the book file', type: 'url', required: true, maxLength: 500, value: b.linkUrl, hint: 'A full https:// link members can open, for example a Google Drive PDF shared with "anyone with the link".' },
    { name: 'pages', label: 'Number of pages (optional)', inputmode: 'numeric', value: b.pages ?? '' },
    { name: 'sort', label: 'Order within the section (optional)', inputmode: 'numeric', value: b.sort ?? 0, hint: 'Lower numbers show first.' },
    {
      name: 'published', label: 'Members see it', type: 'select', value: String(b.published ?? true),
      options: [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No, keep it hidden for now' }],
    },
  ];
}

const toBody = v => ({
  section: v.section, title: v.title, description: v.description, linkUrl: v.linkUrl,
  pages: v.pages ? Number(v.pages) : null, sort: v.sort ? Number(v.sort) : 0, published: v.published === 'true',
});

async function addBook() {
  const saved = await askForm({ title: 'Add an e-book', submitLabel: 'Add e-book', fields: bookFields(), submit: v => api.post('/api/admin/ebooks', toBody(v)) });
  if (saved) {
    toast.success('E-book added.');
    await load();
  }
}

async function editBook(b) {
  const saved = await askForm({ title: `Edit ${b.title}`, submitLabel: 'Save changes', fields: bookFields(b), submit: v => api.put(`/api/admin/ebooks/${b.id}`, toBody(v)) });
  if (saved) {
    toast.success('E-book saved.');
    await load();
  }
}

async function removeBook(b) {
  const done = await askForm({
    title: `Remove ${b.title}?`, text: 'Members will no longer see it. You can restore it later.', submitLabel: 'Remove', tone: 'danger',
    fields: [{ name: 'note', label: 'Why is it removed? (optional)', type: 'textarea', maxLength: 300 }],
    submit: v => api.post(`/api/admin/ebooks/${b.id}/remove`, v.note ? { note: v.note } : {}),
  });
  if (done) {
    toast.success(`${b.title} removed.`);
    await load();
  }
}

async function restoreBook(b) {
  if (await act(() => api.post(`/api/admin/ebooks/${b.id}/restore`, {}), `${b.title} restored.`)) await load();
}

function actionButton(label, onClick, tone = 'secondary') {
  const b = h('button', { type: 'button', class: `zx-btn zx-btn--${tone} zx-btn--sm` }, label);
  b.addEventListener('click', onClick);
  return b;
}

async function load() {
  const { ebooks } = await api.get(`/api/admin/ebooks${state.removed ? '?removed=1' : ''}`);
  $('#rows').replaceChildren(...(ebooks.length ? ebooks.map(b => h('tr', {},
    h('td', {}, b.section),
    h('td', { class: 'zx-td-strong' }, b.title, h('div', { class: 'zx-hint' }, b.description), b.removedAt ? h('div', { class: 'zx-hint' }, 'Removed') : null),
    h('td', {}, b.pages ? String(b.pages) : '-'),
    h('td', {}, h('a', { href: b.linkUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Open')),
    h('td', {}, yesNo(b.published)),
    h('td', {}, String(b.sort)),
    h('td', {}, h('span', { class: 'zx-row-actions' }, b.removedAt
      ? [actionButton('Restore', () => void restoreBook(b))]
      : [actionButton('Edit', () => void editBook(b)), actionButton('Remove', () => void removeBook(b), 'ghost')]))))
    : [emptyRow(7, 'No e-books yet. Members see an empty E-books page until you add one.')]));
}

export async function init() {
  $('#show-removed').addEventListener('change', e => {
    state.removed = e.target.checked;
    void act(load);
  });
  $('#add-btn').addEventListener('click', () => void addBook());
  await act(load);
}
