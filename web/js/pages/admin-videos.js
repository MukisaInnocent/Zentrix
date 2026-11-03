import { api } from '../core/api.js';
import { $, h } from '../core/dom.js';
import { act, askForm, emptyRow } from '../admin/kit.js';
import { toast } from '../core/toast.js';

// Videos (owner, 2026-11-03): add, edit, hide, remove and restore the video links on the member Videos page. The
// server refuses links to adult content and audits every change. Support staff see the list; only admins change it.
const state = { removed: false };
const SITES = { youtube: 'YouTube', tiktok: 'TikTok', other: 'Other site' };

const yesNo = on => h('span', { class: `zx-badge ${on ? 'zx-badge--success' : ''}` }, on ? 'Yes' : 'Hidden');

function videoFields(v = {}) {
  return [
    { name: 'title', label: 'Title', required: true, minLength: 2, maxLength: 120, value: v.title },
    { name: 'linkUrl', label: 'Link to the video', type: 'url', required: true, maxLength: 500, value: v.linkUrl, hint: 'A full https:// link from YouTube, TikTok or any other site. Links to adult content are refused.' },
    { name: 'description', label: 'Short description (optional)', type: 'textarea', maxLength: 600, value: v.description },
    { name: 'sort', label: 'Order (optional)', inputmode: 'numeric', value: v.sort ?? 0, hint: 'Lower numbers show first.' },
    {
      name: 'published', label: 'Members see it', type: 'select', value: String(v.published ?? true),
      options: [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No, keep it hidden for now' }],
    },
  ];
}

const toBody = v => ({ title: v.title, linkUrl: v.linkUrl, description: v.description ?? '', sort: v.sort ? Number(v.sort) : 0, published: v.published === 'true' });

async function addVideo() {
  if (await askForm({ title: 'Add a video', submitLabel: 'Add video', fields: videoFields(), submit: v => api.post('/api/admin/videos', toBody(v)) })) {
    toast.success('Video added.');
    await load();
  }
}

async function editVideo(v) {
  if (await askForm({ title: `Edit ${v.title}`, submitLabel: 'Save changes', fields: videoFields(v), submit: x => api.put(`/api/admin/videos/${v.id}`, toBody(x)) })) {
    toast.success('Video saved.');
    await load();
  }
}

async function removeVideo(v) {
  const done = await askForm({
    title: `Remove ${v.title}?`, text: 'Members will no longer see it. You can restore it later.', submitLabel: 'Remove', tone: 'danger',
    fields: [{ name: 'note', label: 'Why is it removed? (optional)', type: 'textarea', maxLength: 300 }],
    submit: x => api.post(`/api/admin/videos/${v.id}/remove`, x.note ? { note: x.note } : {}),
  });
  if (done) {
    toast.success(`${v.title} removed.`);
    await load();
  }
}

function actionButton(label, onClick, tone = 'secondary') {
  const b = h('button', { type: 'button', class: `zx-btn zx-btn--${tone} zx-btn--sm` }, label);
  b.addEventListener('click', onClick);
  return b;
}

async function load() {
  const { videos } = await api.get(`/api/admin/videos${state.removed ? '?removed=1' : ''}`);
  $('#rows').replaceChildren(...(videos.length ? videos.map(v => h('tr', {},
    h('td', { class: 'zx-td-strong' }, v.title, v.description ? h('div', { class: 'zx-hint' }, v.description) : null, v.removedAt ? h('div', { class: 'zx-hint' }, 'Removed') : null),
    h('td', {}, SITES[v.platform] ?? v.platform, v.platform !== 'other' && !v.embedUrl ? h('div', { class: 'zx-hint' }, 'Opens on its site') : null),
    h('td', {}, h('a', { href: v.linkUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Open')),
    h('td', {}, yesNo(v.published)),
    h('td', {}, String(v.sort)),
    h('td', {}, h('span', { class: 'zx-row-actions' }, v.removedAt
      ? [actionButton('Restore', () => void act(async () => { await api.post(`/api/admin/videos/${v.id}/restore`, {}); await load(); }, `${v.title} restored.`))]
      : [actionButton('Edit', () => void editVideo(v)), actionButton('Remove', () => void removeVideo(v), 'ghost')]))))
    : [emptyRow(6, 'No videos yet. Members see an empty Videos page until you add one.')]));
}

export async function init() {
  $('#show-removed').addEventListener('change', e => {
    state.removed = e.target.checked;
    void act(load);
  });
  $('#add-btn').addEventListener('click', () => void addVideo());
  await act(load);
}
