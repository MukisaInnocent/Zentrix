import { api } from '../core/api.js';
import { $, h } from '../core/dom.js';
import { act, askForm, emptyRow, money } from '../admin/kit.js';
import { toast } from '../core/toast.js';

// Tasks (owner, 2026-11-03): add, edit, hide and show the tasks on the member YouTube, TikTok, Ads and Trivia pages.
// The server checks the reward, refuses links to adult content and audits every change. A completed task pays from the
// promotions budget into the member's task earnings, which cannot be withdrawn yet.
const PAGES = { youtube: 'YouTube', tiktok: 'TikTok', ads: 'Ads', trivia: 'Trivia' };
const state = { module: '' };

function taskFields(t = {}) {
  const modules = t.module ? [t.module] : Object.keys(PAGES);
  return [
    { name: 'module', label: 'Page', type: 'select', value: t.module ?? (state.module || 'youtube'), options: modules.map(m => ({ value: m, label: PAGES[m] })), hint: t.module ? 'A task stays on its page. Add a new task for another page.' : '' },
    { name: 'title', label: 'Title', required: true, minLength: 2, maxLength: 120, value: t.title },
    { name: 'description', label: 'What the member does (for Trivia: the question)', type: 'textarea', required: true, minLength: 2, maxLength: 600, value: t.description },
    { name: 'reward', label: 'Reward', required: true, inputmode: 'decimal', value: t.reward, hint: 'Paid from the promotions budget into the member\'s task earnings (not withdrawable yet).' },
    { name: 'currency', label: 'Currency', required: true, minLength: 3, maxLength: 3, value: t.currency ?? 'UGX', hint: 'Members see tasks in their own currency only, for example UGX for Uganda.' },
    { name: 'linkUrl', label: 'Link (YouTube and TikTok: required; Ads: optional; Trivia: leave empty)', type: 'url', maxLength: 500, value: t.linkUrl ?? '', hint: 'A full https:// link. Links to adult content are refused.' },
    { name: 'durationSec', label: 'Seconds before Done unlocks (optional, 5 to 3600)', inputmode: 'numeric', value: t.durationSec ?? '' },
    { name: 'options', label: 'Trivia only: answer choices, one per line', type: 'textarea', maxLength: 800, value: (t.options ?? []).join('\n') },
    { name: 'answer', label: 'Trivia only: the correct answer (one of the choices)', maxLength: 120, value: t.answer ?? '' },
    {
      name: 'active', label: 'Members see it', type: 'select', value: String(t.active ?? true),
      options: [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No, keep it hidden for now' }],
    },
  ];
}

const toBody = v => ({
  module: v.module, title: v.title, description: v.description, reward: v.reward, currency: v.currency,
  linkUrl: v.linkUrl || null, durationSec: v.durationSec ? Number(v.durationSec) : null,
  options: v.module === 'trivia' ? String(v.options ?? '').split('\n').map(o => o.trim()).filter(Boolean) : [],
  answer: v.module === 'trivia' ? v.answer || null : null, active: v.active === 'true',
});

async function addTask() {
  if (await askForm({ title: 'Add a task', submitLabel: 'Add task', fields: taskFields(), submit: v => api.post('/api/admin/tasks', toBody(v)) })) {
    toast.success('Task added.');
    await load();
  }
}

async function editTask(t) {
  if (await askForm({ title: `Edit ${t.title}`, submitLabel: 'Save changes', fields: taskFields(t), submit: v => api.put(`/api/admin/tasks/${t.id}`, toBody(v)) })) {
    toast.success('Task saved.');
    await load();
  }
}

function actionButton(label, onClick, tone = 'secondary') {
  const b = h('button', { type: 'button', class: `zx-btn zx-btn--${tone} zx-btn--sm` }, label);
  b.addEventListener('click', onClick);
  return b;
}

const toggle = t => act(async () => {
  await api.post(`/api/admin/tasks/${t.id}/${t.active ? 'hide' : 'show'}`, {});
  await load();
}, t.active ? `${t.title} hidden.` : `${t.title} shown to members.`);

async function load() {
  const { tasks } = await api.get(`/api/admin/tasks${state.module ? `?module=${state.module}` : ''}`);
  $('#rows').replaceChildren(...(tasks.length ? tasks.map(t => h('tr', {},
    h('td', {}, PAGES[t.module] ?? t.module),
    h('td', { class: 'zx-td-strong' }, t.title, h('div', { class: 'zx-hint' }, t.description),
      t.module === 'trivia' ? h('div', { class: 'zx-hint' }, `Choices: ${t.options.join(', ')}. Answer: ${t.answer ?? '-'}`) : null),
    h('td', { class: 'zx-amount' }, money(t.rewardMinor, t.currency)),
    h('td', {}, t.linkUrl ? h('a', { href: t.linkUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Open') : '-'),
    h('td', {}, h('span', { class: `zx-badge ${t.active ? 'zx-badge--success' : ''}` }, t.active ? 'Yes' : 'Hidden')),
    h('td', {}, String(t.completions)),
    h('td', {}, h('span', { class: 'zx-row-actions' }, actionButton('Edit', () => void editTask(t)), actionButton(t.active ? 'Hide' : 'Show', () => void toggle(t), 'ghost')))))
    : [emptyRow(7, 'No tasks yet. Members see empty task pages until you add one.')]));
}

export async function init() {
  $('#module').addEventListener('change', e => {
    state.module = e.target.value;
    void act(load);
  });
  $('#add-btn').addEventListener('click', () => void addTask());
  await act(load);
}
