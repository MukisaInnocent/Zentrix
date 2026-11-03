import { api, ApiError, newIdempotencyKey } from './api.js';
import { $, h } from './dom.js';
import { formatDate, formatMoney } from './format.js';
import { toast } from './toast.js';

// The YouTube, TikTok and ads task pages. Tasks come from the staff console (Tasks), so every text is put in with
// DOM nodes, never as HTML. A task with a link opens it first; Done unlocks after the task's duration.
// Task earnings stay in the task balance and cannot be withdrawn yet (owner, 2026-11-03).
export async function initTaskPage({ module, ids, verb, proof, empty, defaultSeconds }) {
  const container = $(ids.list);
  const body = $(ids.submissions);

  function doneButton(t, seconds) {
    const btn = h('button', { type: 'button', class: 'zx-btn zx-btn--sm', disabled: seconds > 0 }, seconds > 0 ? `Done (${seconds}s)` : 'Done');
    if (seconds > 0) {
      let left = seconds;
      const timer = setInterval(() => {
        left -= 1;
        btn.textContent = left > 0 ? `Done (${left}s)` : 'Done';
        if (left <= 0) {
          clearInterval(timer);
          btn.disabled = false;
        }
      }, 1000);
    }
    btn.addEventListener('click', async () => {
      btn.setAttribute('aria-busy', 'true');
      btn.disabled = true;
      try {
        await api.post(`/api/tasks/${t.id}/complete`, { answer: proof }, { idempotencyKey: newIdempotencyKey() });
        toast.success('Task completed. The reward is in your task earnings.');
        await refresh();
      } catch (err) {
        btn.removeAttribute('aria-busy');
        btn.disabled = false;
        toast.error(err instanceof ApiError ? err.message : 'Could not complete the task.');
      }
    });
    return btn;
  }

  function actions(t) {
    if (t.completed) return h('span', { class: 'zx-btn zx-btn--secondary zx-btn--sm zx-btn--done' }, 'Completed');
    const slot = h('div', { class: 'zx-row-actions' });
    const seconds = t.durationSec || defaultSeconds;
    if (!t.url) {
      slot.append(doneButton(t, 0));
      return slot;
    }
    const open = h('a', { class: 'zx-btn zx-btn--sm', href: t.url, target: '_blank', rel: 'noopener noreferrer' }, verb);
    open.addEventListener('click', () => open.replaceWith(doneButton(t, seconds)), { once: true });
    slot.append(open);
    return slot;
  }

  async function refresh() {
    const [summary, { tasks }, { submissions }] = await Promise.all([
      api.get('/api/wallet/summary'),
      api.get(`/api/tasks?module=${module}`),
      api.get(`/api/tasks/submissions?module=${module}`),
    ]);
    $(ids.earnings).textContent = formatMoney(summary.taskBalancesMinor[module] ?? '0', summary.currency);
    $(ids.count).textContent = String(submissions.length);

    container.replaceChildren(...(tasks.length ? tasks.map(t => h('div', { class: 'zx-tile' },
      h('div', {},
        h('div', { class: 'zx-tile__title' }, t.title),
        h('div', { class: 'zx-hint zx-tile__meta' }, t.description),
        h('div', { class: 'zx-tile__reward' }, `Reward: +${formatMoney(t.rewardMinor, t.currency)}`)),
      h('div', {}, actions(t)))) : [h('p', { class: 'zx-empty' }, empty)]));

    body.replaceChildren(...(submissions.length ? submissions.map(s => h('tr', {},
      h('td', { class: 'zx-td-muted' }, formatDate(s.createdAt)),
      h('td', { class: 'zx-td-strong' }, s.taskTitle),
      h('td', { class: 'zx-amount zx-amount--in' }, `+ ${formatMoney(s.rewardMinor, s.currency)}`),
      h('td', {}, h('span', { class: 'zx-badge zx-badge--success' }, 'Approved'))))
      : [h('tr', {}, h('td', { colspan: '4', class: 'zx-td-empty' }, 'No completed tasks yet.'))]));
  }

  try {
    await refresh();
  } catch (err) {
    container.replaceChildren(h('p', { class: 'zx-empty' }, err instanceof ApiError ? err.message : 'Could not load the tasks. Reload the page.'));
  }
}
