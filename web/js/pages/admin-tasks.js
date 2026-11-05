import { api, newIdempotencyKey } from '../core/api.js';
import { $, h } from '../core/dom.js';
import { act, askForm, emptyRow, money } from '../admin/kit.js';
import { toast } from '../core/toast.js';

// Tasks (owner, 2026-11-03): add, edit, hide and show the tasks on the member YouTube, TikTok, Ads and Trivia pages.
// The server checks the reward, refuses links to adult content and audits every change. Each task has its own budget
// (owner, 2026-11-05), set by the admin; a completed task pays from it into the member's task earnings,
// which cannot be withdrawn yet. Members stop seeing the task when what is left is less than one reward.
const PAGES = { youtube: 'YouTube', tiktok: 'TikTok', ads: 'Ads', trivia: 'Trivia' };
const state = { module: '' };

function taskFields(t = {}) {
  const modules = t.module ? [t.module] : Object.keys(PAGES);
  return [
    { name: 'module', label: 'Page', type: 'select', value: t.module ?? (state.module || 'youtube'), options: modules.map(m => ({ value: m, label: PAGES[m] })), hint: t.module ? 'A task stays on its page. Add a new task for another page.' : '' },
    { name: 'title', label: 'Title', required: true, minLength: 2, maxLength: 120, value: t.title },
    { name: 'description', label: 'What the member does (for Trivia: the question)', type: 'textarea', required: true, minLength: 2, maxLength: 600, value: t.description },
    { name: 'reward', label: 'Reward for each member', required: true, inputmode: 'decimal', value: t.reward, hint: 'Paid from this task\'s budget into the member\'s task earnings (not withdrawable yet).' },
    {
      name: 'budget', label: 'Total budget', required: true, inputmode: 'decimal', value: t.budget,
      hint: t.id
        ? `Already paid: ${money(t.spentMinor, t.currency)}. Raising it adds more; lowering it (not below what was paid) gives the rest back. Set it to what was paid to end the task.`
        : 'Set it to any amount. Members stop seeing the task when what is left is less than one reward.',
    },
    { name: 'currency', label: 'Currency', required: true, minLength: 3, maxLength: 3, value: t.currency ?? 'UGX', hint: t.id ? 'Fixed once the task has a budget.' : 'Members see the reward in their own currency, converted at the latest rate.' },
    { name: 'linkUrl', label: 'Link (YouTube and TikTok: required; Ads: optional; Trivia: leave empty)', type: 'url', maxLength: 500, value: t.linkUrl ?? '', hint: 'YouTube and TikTok: the link to one video; it plays on the member\'s page. TikTok can also link a LIVE (tiktok.com/@name/live), which opens on TikTok. Links to adult content are refused.' },
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
  module: v.module, title: v.title, description: v.description, reward: v.reward, budget: v.budget, currency: v.currency,
  linkUrl: v.linkUrl || null, durationSec: v.durationSec ? Number(v.durationSec) : null,
  options: v.module === 'trivia' ? String(v.options ?? '').split('\n').map(o => o.trim()).filter(Boolean) : [],
  answer: v.module === 'trivia' ? v.answer || null : null, active: v.active === 'true',
});

async function addTask() {
  if (await askForm({ title: 'Add a task', submitLabel: 'Add task', fields: taskFields(), submit: v => api.post('/api/admin/tasks', toBody(v), { idempotencyKey: newIdempotencyKey() }) })) {
    toast.success('Task added.');
    await load();
  }
}

async function editTask(t) {
  if (await askForm({ title: `Edit ${t.title}`, submitLabel: 'Save changes', fields: taskFields(t), submit: v => api.put(`/api/admin/tasks/${t.id}`, toBody(v), { idempotencyKey: newIdempotencyKey() }) })) {
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
    h('td', { class: 'zx-amount' }, money(t.budgetMinor, t.currency), h('div', { class: 'zx-hint' }, `Paid ${money(t.spentMinor, t.currency)}`)),
    h('td', { class: 'zx-amount' }, money(t.remainingMinor, t.currency),
      t.usedUp ? h('div', { class: 'zx-hint' }, 'Used up: members no longer see it') : null),
    h('td', {}, t.linkUrl ? h('a', { href: t.linkUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Open') : '-'),
    h('td', {}, h('span', { class: `zx-badge ${t.active ? 'zx-badge--success' : ''}` }, t.active ? 'Yes' : 'Hidden')),
    h('td', {}, String(t.completions)),
    h('td', {}, h('span', { class: 'zx-row-actions' }, actionButton('Edit', () => void editTask(t)), actionButton(t.active ? 'Hide' : 'Show', () => void toggle(t), 'ghost')))))
    : [emptyRow(9, 'No tasks yet. Members see empty task pages until you add one.')]));
}

export async function init() {
  $('#module').addEventListener('change', e => {
    state.module = e.target.value;
    void act(load);
  });
  $('#add-btn').addEventListener('click', () => void addTask());
  await act(load);
}
